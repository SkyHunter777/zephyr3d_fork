import type { GlyphContour, GlyphData } from './types';
import type { SFNTReader } from './sfnt_reader';

type CFFIndex = {
  objects: Uint8Array<ArrayBuffer>[];
  endOffset: number;
};

type CFFDict = Map<string, number[]>;

type CFFPrivateInfo = {
  subrs: Uint8Array<ArrayBuffer>[];
  subrBias: number;
};

type CFFFontDict = {
  privateInfo: CFFPrivateInfo;
};

type FDSelect =
  | {
      format: 0;
      fds: Uint8Array<ArrayBuffer>;
    }
  | {
      format: 3;
      ranges: { first: number; fd: number }[];
      sentinel: number;
    };

/**
 * CFF Type 2 glyph provider for OpenType/CFF fonts.
 *
 * @internal
 */
export class CFFGlyphProvider {
  private readonly _charStrings: Uint8Array<ArrayBuffer>[];
  private readonly _globalSubrs: Uint8Array<ArrayBuffer>[];
  private readonly _globalSubrBias: number;
  private readonly _privateInfo: CFFPrivateInfo;
  private readonly _fdArray: CFFFontDict[];
  private readonly _fdSelect: FDSelect | null;
  constructor(
    charStrings: Uint8Array<ArrayBuffer>[],
    globalSubrs: Uint8Array<ArrayBuffer>[],
    privateInfo: CFFPrivateInfo,
    fdArray: CFFFontDict[],
    fdSelect: FDSelect | null
  ) {
    this._charStrings = charStrings;
    this._globalSubrs = globalSubrs;
    this._globalSubrBias = getSubrBias(globalSubrs.length);
    this._privateInfo = privateInfo;
    this._fdArray = fdArray;
    this._fdSelect = fdSelect;
  }
  getGlyph(
    glyphIndex: number,
    advanceWidths: Uint16Array<ArrayBuffer>,
    leftSideBearings: Int16Array<ArrayBuffer>
  ): GlyphData | null {
    const charString = this._charStrings[glyphIndex];
    if (!charString) {
      return null;
    }
    const privateInfo = this.getPrivateInfo(glyphIndex);
    const interpreter = new Type2CharStringInterpreter(
      this._globalSubrs,
      this._globalSubrBias,
      privateInfo.subrs,
      privateInfo.subrBias
    );
    const contours = interpreter.parse(charString);
    const bounds = computeBounds(contours);
    return {
      glyphIndex,
      advanceWidth: advanceWidths[glyphIndex] ?? 0,
      leftSideBearing: leftSideBearings[glyphIndex] ?? 0,
      xMin: bounds.xMin,
      yMin: bounds.yMin,
      xMax: bounds.xMax,
      yMax: bounds.yMax,
      contours
    };
  }
  private getPrivateInfo(glyphIndex: number) {
    const fdIndex = this.getFDIndex(glyphIndex);
    return fdIndex >= 0 ? (this._fdArray[fdIndex]?.privateInfo ?? this._privateInfo) : this._privateInfo;
  }
  private getFDIndex(glyphIndex: number) {
    if (!this._fdSelect) {
      return -1;
    }
    if (this._fdSelect.format === 0) {
      return this._fdSelect.fds[glyphIndex] ?? -1;
    }
    const ranges = this._fdSelect.ranges;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges[i].first;
      const end = i + 1 < ranges.length ? ranges[i + 1].first : this._fdSelect.sentinel;
      if (glyphIndex >= start && glyphIndex < end) {
        return ranges[i].fd;
      }
    }
    return -1;
  }
}

/** @internal */
export function parseCFFGlyphProvider(reader: SFNTReader, tableOffset: number, glyphCount: number) {
  const major = reader.uint8(tableOffset);
  if (major !== 1) {
    throw new Error(`Unsupported CFF table version: ${major}`);
  }
  const headerSize = reader.uint8(tableOffset + 2);
  let offset = tableOffset + headerSize;
  const nameIndex = readIndex(reader, offset);
  offset = nameIndex.endOffset;
  const topDictIndex = readIndex(reader, offset);
  offset = topDictIndex.endOffset;
  const stringIndex = readIndex(reader, offset);
  offset = stringIndex.endOffset;
  const globalSubrIndex = readIndex(reader, offset);
  const topDictBytes = topDictIndex.objects[0];
  if (!topDictBytes) {
    throw new Error('CFF Top DICT not found');
  }
  const topDict = parseDict(topDictBytes, 'dict');
  const charStringsOffset = getDictNumber(topDict, '17');
  if (charStringsOffset === null) {
    throw new Error('CFF CharStrings offset not found');
  }
  const charStrings = readIndex(reader, tableOffset + charStringsOffset);
  const privateInfo = readTopPrivateInfo(reader, tableOffset, topDict);
  const fdArrayOffset = getDictNumber(topDict, '12 36');
  const fdSelectOffset = getDictNumber(topDict, '12 37');
  const fdArray = fdArrayOffset !== null ? readFDArray(reader, tableOffset, fdArrayOffset) : [];
  const fdSelect =
    fdSelectOffset !== null ? readFDSelect(reader, tableOffset + fdSelectOffset, glyphCount) : null;
  return new CFFGlyphProvider(charStrings.objects, globalSubrIndex.objects, privateInfo, fdArray, fdSelect);
}

function readTopPrivateInfo(reader: SFNTReader, tableOffset: number, topDict: CFFDict): CFFPrivateInfo {
  const privateEntry = topDict.get('18');
  if (!privateEntry || privateEntry.length < 2) {
    return { subrs: [], subrBias: getSubrBias(0) };
  }
  return readPrivateInfo(reader, tableOffset, privateEntry[1], privateEntry[0]);
}

function readFDArray(reader: SFNTReader, tableOffset: number, fdArrayOffset: number): CFFFontDict[] {
  const fdIndex = readIndex(reader, tableOffset + fdArrayOffset);
  return fdIndex.objects.map((fontDictBytes) => {
    const fontDict = parseDict(fontDictBytes, 'dict');
    const privateEntry = fontDict.get('18');
    return {
      privateInfo:
        privateEntry && privateEntry.length >= 2
          ? readPrivateInfo(reader, tableOffset, privateEntry[1], privateEntry[0])
          : { subrs: [], subrBias: getSubrBias(0) }
    };
  });
}

function readPrivateInfo(
  reader: SFNTReader,
  tableOffset: number,
  privateOffset: number,
  privateSize: number
): CFFPrivateInfo {
  const bytes = readBytes(reader, tableOffset + privateOffset, privateSize);
  const dict = parseDict(bytes, 'dict');
  const subrsOffset = getDictNumber(dict, '19');
  const subrs =
    subrsOffset !== null ? readIndex(reader, tableOffset + privateOffset + subrsOffset).objects : [];
  return { subrs, subrBias: getSubrBias(subrs.length) };
}

function readFDSelect(reader: SFNTReader, offset: number, glyphCount: number): FDSelect {
  const format = reader.uint8(offset);
  if (format === 0) {
    return {
      format,
      fds: readBytes(reader, offset + 1, glyphCount)
    };
  }
  if (format === 3) {
    const ranges: { first: number; fd: number }[] = [];
    const nRanges = reader.uint16(offset + 1);
    let cursor = offset + 3;
    for (let i = 0; i < nRanges; i++) {
      ranges.push({
        first: reader.uint16(cursor),
        fd: reader.uint8(cursor + 2)
      });
      cursor += 3;
    }
    return {
      format,
      ranges,
      sentinel: reader.uint16(cursor)
    };
  }
  throw new Error(`Unsupported CFF FDSelect format: ${format}`);
}

function readIndex(reader: SFNTReader, offset: number): CFFIndex {
  const count = reader.uint16(offset);
  if (count === 0) {
    return { objects: [], endOffset: offset + 2 };
  }
  const offSize = reader.uint8(offset + 2);
  const offsetsStart = offset + 3;
  const dataStart = offsetsStart + (count + 1) * offSize;
  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) {
    offsets.push(readOffset(reader, offsetsStart + i * offSize, offSize));
  }
  const objects: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < count; i++) {
    const start = dataStart + offsets[i] - 1;
    const end = dataStart + offsets[i + 1] - 1;
    objects.push(readBytes(reader, start, Math.max(end - start, 0)));
  }
  return {
    objects,
    endOffset: dataStart + offsets[count] - 1
  };
}

function readOffset(reader: SFNTReader, offset: number, size: number) {
  let value = 0;
  for (let i = 0; i < size; i++) {
    value = value * 256 + reader.uint8(offset + i);
  }
  return value;
}

function readBytes(reader: SFNTReader, offset: number, length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(reader.buffer.slice(offset, offset + length));
}

function parseDict(bytes: Uint8Array<ArrayBuffer>, kind: 'dict' | 'charstring') {
  const dict: CFFDict = new Map();
  const stack: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (isDictOperatorByte(b)) {
      let op = String(b);
      if (b === 12) {
        op = `12 ${bytes[i++]}`;
      }
      dict.set(op, stack.splice(0));
    } else {
      const parsed = readNumber(bytes, i - 1, kind);
      stack.push(parsed.value);
      i = parsed.next;
    }
  }
  return dict;
}

function isDictOperatorByte(b: number) {
  return b <= 21 && b !== 28 && b !== 29 && b !== 30;
}

function getDictNumber(dict: CFFDict, key: string, index = 0) {
  const values = dict.get(key);
  return values && index < values.length ? values[index] : null;
}

function getSubrBias(count: number) {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

type ParseStatus = 'continue' | 'return' | 'end';

class Type2CharStringInterpreter {
  private readonly _globalSubrs: Uint8Array<ArrayBuffer>[];
  private readonly _globalSubrBias: number;
  private readonly _localSubrs: Uint8Array<ArrayBuffer>[];
  private readonly _localSubrBias: number;
  private readonly _stack: number[];
  private readonly _transient: number[];
  private readonly _contours: GlyphContour[];
  private _currentContour: GlyphContour | null;
  private _x: number;
  private _y: number;
  private _hintCount: number;
  private _widthConsumed: boolean;
  constructor(
    globalSubrs: Uint8Array<ArrayBuffer>[],
    globalSubrBias: number,
    localSubrs: Uint8Array<ArrayBuffer>[],
    localSubrBias: number
  ) {
    this._globalSubrs = globalSubrs;
    this._globalSubrBias = globalSubrBias;
    this._localSubrs = localSubrs;
    this._localSubrBias = localSubrBias;
    this._stack = [];
    this._transient = new Array(32).fill(0);
    this._contours = [];
    this._currentContour = null;
    this._x = 0;
    this._y = 0;
    this._hintCount = 0;
    this._widthConsumed = false;
  }
  parse(bytes: Uint8Array<ArrayBuffer>) {
    this.execute(bytes, 0);
    this.closeContour();
    return this._contours;
  }
  private execute(bytes: Uint8Array<ArrayBuffer>, depth: number): ParseStatus {
    if (depth > 32) {
      throw new Error('CFF Type2 charstring subroutine nesting too deep');
    }
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      if (isType2NumberByte(b)) {
        const parsed = readNumber(bytes, i - 1, 'charstring');
        this._stack.push(parsed.value);
        i = parsed.next;
        continue;
      }
      if (b === 12) {
        const status = this.handleEscapedOperator(bytes[i++]);
        if (status !== 'continue') {
          return status;
        }
        continue;
      }
      if (b === 19 || b === 20) {
        this.consumeStemHints();
        i += Math.ceil(this._hintCount / 8);
        this._stack.length = 0;
        continue;
      }
      const status = this.handleOperator(b, depth);
      if (status !== 'continue') {
        return status;
      }
    }
    return 'continue';
  }
  private handleOperator(op: number, depth: number): ParseStatus {
    switch (op) {
      case 1:
      case 3:
      case 18:
      case 23:
        this.consumeStemHints();
        this._stack.length = 0;
        break;
      case 4: {
        const [dy] = this.consumeMoveArgs(1);
        this.moveTo(0, dy);
        break;
      }
      case 5:
        this.applyRLineTo(this.consumeArgs());
        break;
      case 6:
        this.applyHVLineTo(this.consumeArgs(), true);
        break;
      case 7:
        this.applyHVLineTo(this.consumeArgs(), false);
        break;
      case 8:
        this.applyRRCurveTo(this.consumeArgs());
        break;
      case 10:
        return this.callSubr(false, depth);
      case 11:
        return 'return';
      case 14:
        this._stack.length = 0;
        this.closeContour();
        return 'end';
      case 21: {
        const [dx, dy] = this.consumeMoveArgs(2);
        this.moveTo(dx, dy);
        break;
      }
      case 22: {
        const [dx] = this.consumeMoveArgs(1);
        this.moveTo(dx, 0);
        break;
      }
      case 24:
        this.applyRCurveLine(this.consumeArgs());
        break;
      case 25:
        this.applyRLineCurve(this.consumeArgs());
        break;
      case 26:
        this.applyVVCurveTo(this.consumeArgs());
        break;
      case 27:
        this.applyHHCurveTo(this.consumeArgs());
        break;
      case 29:
        return this.callSubr(true, depth);
      case 30:
        this.applyVHCurveTo(this.consumeArgs());
        break;
      case 31:
        this.applyHVCurveTo(this.consumeArgs());
        break;
      default:
        this._stack.length = 0;
        break;
    }
    return 'continue';
  }
  private handleEscapedOperator(op: number): ParseStatus {
    switch (op) {
      case 3:
        this.binaryStackOp((a, b) => (a && b ? 1 : 0));
        break;
      case 4:
        this.binaryStackOp((a, b) => (a || b ? 1 : 0));
        break;
      case 5: {
        const a = this._stack.pop() ?? 0;
        this._stack.push(a ? 0 : 1);
        break;
      }
      case 9: {
        const a = this._stack.pop() ?? 0;
        this._stack.push(Math.abs(a));
        break;
      }
      case 10:
        this.binaryStackOp((a, b) => a + b);
        break;
      case 11:
        this.binaryStackOp((a, b) => a - b);
        break;
      case 12:
        this.binaryStackOp((a, b) => a / b);
        break;
      case 14: {
        const a = this._stack.pop() ?? 0;
        this._stack.push(-a);
        break;
      }
      case 15:
        this.binaryStackOp((a, b) => (a === b ? 1 : 0));
        break;
      case 18:
        this._stack.pop();
        break;
      case 20: {
        const value = this._stack.pop() ?? 0;
        const index = this._stack.pop() ?? 0;
        this._transient[index | 0] = value;
        break;
      }
      case 21: {
        const index = this._stack.pop() ?? 0;
        this._stack.push(this._transient[index | 0] ?? 0);
        break;
      }
      case 22:
        this.applyIfElse();
        break;
      case 23:
        this._stack.push(Math.random());
        break;
      case 24:
        this.binaryStackOp((a, b) => a * b);
        break;
      case 26: {
        const a = this._stack.pop() ?? 0;
        this._stack.push(Math.sqrt(Math.max(a, 0)));
        break;
      }
      case 27: {
        const a = this._stack[this._stack.length - 1] ?? 0;
        this._stack.push(a);
        break;
      }
      case 28:
        this.exchangeStackTop();
        break;
      case 29:
        this.indexStack();
        break;
      case 30:
        this.rollStack();
        break;
      case 34:
        this.applyHFlex(this.consumeArgs());
        break;
      case 35:
        this.applyFlex(this.consumeArgs());
        break;
      case 36:
        this.applyHFlex1(this.consumeArgs());
        break;
      case 37:
        this.applyFlex1(this.consumeArgs());
        break;
      default:
        this._stack.length = 0;
        break;
    }
    return 'continue';
  }
  private consumeStemHints() {
    if (!this._widthConsumed && this._stack.length % 2 === 1) {
      this._stack.shift();
      this._widthConsumed = true;
    }
    this._hintCount += Math.floor(this._stack.length / 2);
  }
  private consumeMoveArgs(count: number) {
    if (!this._widthConsumed && this._stack.length > count) {
      this._stack.shift();
      this._widthConsumed = true;
    }
    const args = this._stack.splice(Math.max(0, this._stack.length - count), count);
    this._stack.length = 0;
    while (args.length < count) {
      args.unshift(0);
    }
    return args;
  }
  private consumeArgs() {
    return this._stack.splice(0);
  }
  private callSubr(global: boolean, depth: number): ParseStatus {
    const operand = this._stack.pop();
    if (operand === undefined) {
      return 'continue';
    }
    const subrs = global ? this._globalSubrs : this._localSubrs;
    const bias = global ? this._globalSubrBias : this._localSubrBias;
    const subr = subrs[(operand + bias) | 0];
    if (subr) {
      const status = this.execute(subr, depth + 1);
      return status === 'return' ? 'continue' : status;
    }
    return 'continue';
  }
  private moveTo(dx: number, dy: number) {
    this.closeContour();
    this._x += dx;
    this._y += dy;
    this._currentContour = [{ x: this._x, y: this._y, onCurve: true }];
  }
  private lineTo(dx: number, dy: number) {
    this.ensureContour();
    this._x += dx;
    this._y += dy;
    this._currentContour!.push({ x: this._x, y: this._y, onCurve: true });
  }
  private curveTo(dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) {
    this.ensureContour();
    const p0 = { x: this._x, y: this._y };
    const p1 = { x: p0.x + dx1, y: p0.y + dy1 };
    const p2 = { x: p1.x + dx2, y: p1.y + dy2 };
    const p3 = { x: p2.x + dx3, y: p2.y + dy3 };
    appendCubicAsQuadratics(this._currentContour!, p0, p1, p2, p3);
    this._x = p3.x;
    this._y = p3.y;
  }
  private ensureContour() {
    if (!this._currentContour) {
      this._currentContour = [{ x: this._x, y: this._y, onCurve: true }];
    }
  }
  private closeContour() {
    const contour = this._currentContour;
    if (contour && contour.length > 0) {
      const first = contour[0];
      const last = contour[contour.length - 1];
      if (first.onCurve && last.onCurve && samePoint(first, last)) {
        contour.pop();
      }
      if (contour.length > 0) {
        this._contours.push(contour);
      }
    }
    this._currentContour = null;
  }
  private applyRLineTo(args: number[]) {
    for (let i = 0; i + 1 < args.length; i += 2) {
      this.lineTo(args[i], args[i + 1]);
    }
  }
  private applyHVLineTo(args: number[], horizontalFirst: boolean) {
    let horizontal = horizontalFirst;
    for (const arg of args) {
      if (horizontal) {
        this.lineTo(arg, 0);
      } else {
        this.lineTo(0, arg);
      }
      horizontal = !horizontal;
    }
  }
  private applyRRCurveTo(args: number[]) {
    for (let i = 0; i + 5 < args.length; i += 6) {
      this.curveTo(args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], args[i + 5]);
    }
  }
  private applyRCurveLine(args: number[]) {
    let i = 0;
    for (; i + 7 < args.length; i += 6) {
      this.curveTo(args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], args[i + 5]);
    }
    if (i + 1 < args.length) {
      this.lineTo(args[i], args[i + 1]);
    }
  }
  private applyRLineCurve(args: number[]) {
    let i = 0;
    for (; i + 7 < args.length; i += 2) {
      this.lineTo(args[i], args[i + 1]);
    }
    if (i + 5 < args.length) {
      this.curveTo(args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], args[i + 5]);
    }
  }
  private applyVVCurveTo(args: number[]) {
    let i = 0;
    let dx1 = 0;
    if (args.length % 4 === 1) {
      dx1 = args[i++];
    }
    while (i + 3 < args.length) {
      this.curveTo(dx1, args[i], args[i + 1], args[i + 2], 0, args[i + 3]);
      dx1 = 0;
      i += 4;
    }
  }
  private applyHHCurveTo(args: number[]) {
    let i = 0;
    let dy1 = 0;
    if (args.length % 4 === 1) {
      dy1 = args[i++];
    }
    while (i + 3 < args.length) {
      this.curveTo(args[i], dy1, args[i + 1], args[i + 2], args[i + 3], 0);
      dy1 = 0;
      i += 4;
    }
  }
  private applyVHCurveTo(args: number[]) {
    let i = 0;
    let vertical = true;
    while (i + 3 < args.length) {
      if (vertical) {
        const dy1 = args[i++];
        const dx2 = args[i++];
        const dy2 = args[i++];
        const dx3 = args[i++];
        const dy3 = i === args.length - 1 ? args[i++] : 0;
        this.curveTo(0, dy1, dx2, dy2, dx3, dy3);
      } else {
        const dx1 = args[i++];
        const dx2 = args[i++];
        const dy2 = args[i++];
        const dy3 = args[i++];
        const dx3 = i === args.length - 1 ? args[i++] : 0;
        this.curveTo(dx1, 0, dx2, dy2, dx3, dy3);
      }
      vertical = !vertical;
    }
  }
  private applyHVCurveTo(args: number[]) {
    let i = 0;
    let horizontal = true;
    while (i + 3 < args.length) {
      if (horizontal) {
        const dx1 = args[i++];
        const dx2 = args[i++];
        const dy2 = args[i++];
        const dy3 = args[i++];
        const dx3 = i === args.length - 1 ? args[i++] : 0;
        this.curveTo(dx1, 0, dx2, dy2, dx3, dy3);
      } else {
        const dy1 = args[i++];
        const dx2 = args[i++];
        const dy2 = args[i++];
        const dx3 = args[i++];
        const dy3 = i === args.length - 1 ? args[i++] : 0;
        this.curveTo(0, dy1, dx2, dy2, dx3, dy3);
      }
      horizontal = !horizontal;
    }
  }
  private applyHFlex(args: number[]) {
    if (args.length < 7) {
      return;
    }
    this.curveTo(args[0], 0, args[1], args[2], args[3], 0);
    this.curveTo(args[4], 0, args[5], -args[2], args[6], 0);
  }
  private applyFlex(args: number[]) {
    if (args.length < 12) {
      return;
    }
    this.curveTo(args[0], args[1], args[2], args[3], args[4], args[5]);
    this.curveTo(args[6], args[7], args[8], args[9], args[10], args[11]);
  }
  private applyHFlex1(args: number[]) {
    if (args.length < 9) {
      return;
    }
    this.curveTo(args[0], args[1], args[2], args[3], args[4], 0);
    this.curveTo(args[5], 0, args[6], args[7], args[8], -(args[1] + args[3] + args[7]));
  }
  private applyFlex1(args: number[]) {
    if (args.length < 11) {
      return;
    }
    const dx = args[0] + args[2] + args[4] + args[6] + args[8];
    const dy = args[1] + args[3] + args[5] + args[7] + args[9];
    const dx6 = Math.abs(dx) > Math.abs(dy) ? args[10] : -dx;
    const dy6 = Math.abs(dx) > Math.abs(dy) ? -dy : args[10];
    this.curveTo(args[0], args[1], args[2], args[3], args[4], args[5]);
    this.curveTo(args[6], args[7], args[8], args[9], dx6, dy6);
  }
  private binaryStackOp(op: (a: number, b: number) => number) {
    const b = this._stack.pop() ?? 0;
    const a = this._stack.pop() ?? 0;
    this._stack.push(op(a, b));
  }
  private applyIfElse() {
    const s2 = this._stack.pop() ?? 0;
    const s1 = this._stack.pop() ?? 0;
    const v2 = this._stack.pop() ?? 0;
    const v1 = this._stack.pop() ?? 0;
    this._stack.push(v1 <= v2 ? s1 : s2);
  }
  private exchangeStackTop() {
    const a = this._stack.pop();
    const b = this._stack.pop();
    if (a !== undefined && b !== undefined) {
      this._stack.push(a, b);
    }
  }
  private indexStack() {
    const index = this._stack.pop() ?? 0;
    const i = Math.max(0, this._stack.length - 1 - (index | 0));
    this._stack.push(this._stack[i] ?? 0);
  }
  private rollStack() {
    const j = this._stack.pop() ?? 0;
    const n = this._stack.pop() ?? 0;
    const count = n | 0;
    if (count <= 0 || count > this._stack.length) {
      return;
    }
    const segment = this._stack.splice(this._stack.length - count, count);
    const shift = (((j | 0) % count) + count) % count;
    this._stack.push(...segment.slice(count - shift), ...segment.slice(0, count - shift));
  }
}

function isType2NumberByte(b: number) {
  return b === 28 || b === 255 || b >= 32;
}

function readNumber(bytes: Uint8Array<ArrayBuffer>, offset: number, kind: 'dict' | 'charstring') {
  const b0 = bytes[offset];
  if (b0 >= 32 && b0 <= 246) {
    return { value: b0 - 139, next: offset + 1 };
  }
  if (b0 >= 247 && b0 <= 250) {
    return { value: (b0 - 247) * 256 + bytes[offset + 1] + 108, next: offset + 2 };
  }
  if (b0 >= 251 && b0 <= 254) {
    return { value: -(b0 - 251) * 256 - bytes[offset + 1] - 108, next: offset + 2 };
  }
  if (b0 === 28) {
    const value = toInt16((bytes[offset + 1] << 8) | bytes[offset + 2]);
    return { value, next: offset + 3 };
  }
  if (b0 === 29 && kind === 'dict') {
    const value =
      (bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4];
    return { value, next: offset + 5 };
  }
  if (b0 === 30 && kind === 'dict') {
    return readRealNumber(bytes, offset + 1);
  }
  if (b0 === 255) {
    const value =
      ((bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4]) /
      65536;
    return { value, next: offset + 5 };
  }
  throw new Error(`Invalid CFF number byte: ${b0}`);
}

function readRealNumber(bytes: Uint8Array<ArrayBuffer>, offset: number) {
  let text = '';
  let i = offset;
  let done = false;
  while (!done && i < bytes.length) {
    const b = bytes[i++];
    for (const nibble of [b >> 4, b & 15]) {
      if (nibble <= 9) {
        text += String(nibble);
      } else if (nibble === 10) {
        text += '.';
      } else if (nibble === 11) {
        text += 'E';
      } else if (nibble === 12) {
        text += 'E-';
      } else if (nibble === 14) {
        text += '-';
      } else if (nibble === 15) {
        done = true;
        break;
      }
    }
  }
  return { value: Number(text), next: i };
}

function toInt16(value: number) {
  return value & 0x8000 ? value - 0x10000 : value;
}

function appendCubicAsQuadratics(
  contour: GlyphContour,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number }
) {
  const segments = 6;
  for (let i = 1; i <= segments; i++) {
    const t0 = (i - 1) / segments;
    const t1 = i / segments;
    const tm = (t0 + t1) * 0.5;
    const q0 = cubicPoint(p0, p1, p2, p3, t0);
    const q2 = cubicPoint(p0, p1, p2, p3, t1);
    const qm = cubicPoint(p0, p1, p2, p3, tm);
    const q1 = {
      x: 2 * qm.x - 0.5 * q0.x - 0.5 * q2.x,
      y: 2 * qm.y - 0.5 * q0.y - 0.5 * q2.y
    };
    contour.push({ x: q1.x, y: q1.y, onCurve: false }, { x: q2.x, y: q2.y, onCurve: true });
  }
}

function cubicPoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function computeBounds(contours: GlyphContour[]) {
  if (contours.length === 0) {
    return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  }
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const contour of contours) {
    for (const point of contour) {
      xMin = Math.min(xMin, point.x);
      yMin = Math.min(yMin, point.y);
      xMax = Math.max(xMax, point.x);
      yMax = Math.max(yMax, point.y);
    }
  }
  return { xMin, yMin, xMax, yMax };
}
