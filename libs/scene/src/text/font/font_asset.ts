import { SFNTReader } from './sfnt_reader';
import type { FontMetrics, GlyphContour, GlyphData, GlyphPoint } from './types';

type TableRecord = {
  offset: number;
  length: number;
};

type GlyphHeader = {
  numberOfContours: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
};

type CompositeComponent = {
  glyphIndex: number;
  dx: number;
  dy: number;
  xx: number;
  xy: number;
  yx: number;
  yy: number;
};

type CoverageTable =
  | { format: 1; glyphs: Uint16Array<ArrayBuffer> }
  | { format: 2; ranges: { start: number; end: number; startIndex: number }[] };

type ClassDefTable =
  | { format: 1; startGlyphId: number; classes: Uint16Array<ArrayBuffer> }
  | { format: 2; ranges: { start: number; end: number; classId: number }[] };

type GPOSPairSubtable =
  | {
      kind: 'format1';
      coverage: CoverageTable;
      pairs: Map<number, Map<number, PairAdjustment>>;
    }
  | {
      kind: 'format2';
      coverage: CoverageTable;
      classDef1: ClassDefTable;
      classDef2: ClassDefTable;
      class1Count: number;
      class2Count: number;
      values: PairAdjustment[];
    };

/**
 * Minimal horizontal pair adjustment extracted from GPOS.
 *
 * @public
 */
export type PairAdjustment = {
  firstXPlacement: number;
  firstXAdvance: number;
  secondXPlacement: number;
  secondXAdvance: number;
};

const ARG_1_AND_2_ARE_WORDS = 1 << 0;
const ARGS_ARE_XY_VALUES = 1 << 1;
const WE_HAVE_A_SCALE = 1 << 3;
const MORE_COMPONENTS = 1 << 5;
const WE_HAVE_AN_X_AND_Y_SCALE = 1 << 6;
const WE_HAVE_A_TWO_BY_TWO = 1 << 7;

/**
 * Minimal runtime font asset for TrueType outlines.
 *
 * @public
 */
export class FontAsset {
  private readonly _reader: SFNTReader;
  private readonly _tables: Map<string, TableRecord>;
  private readonly _glyphOffsets: Uint32Array<ArrayBuffer>;
  private readonly _advanceWidths: Uint16Array<ArrayBuffer>;
  private readonly _leftSideBearings: Int16Array<ArrayBuffer>;
  private readonly _glyphCache: Map<number, GlyphData | null>;
  private readonly _cmapFormat4: { offset: number; platformId: number; encodingId: number } | null;
  private readonly _cmapFormat12: { offset: number; platformId: number; encodingId: number } | null;
  private readonly _kernPairs: Map<number, number>;
  private readonly _gposPairs: GPOSPairSubtable[];
  private readonly _metrics: FontMetrics;
  private readonly _numberOfHMetrics: number;
  private constructor(buffer: ArrayBuffer) {
    this._reader = new SFNTReader(buffer);
    this._tables = parseTableDirectory(this._reader);
    const head = this.requireTable('head');
    const maxp = this.requireTable('maxp');
    const hhea = this.requireTable('hhea');
    const hmtx = this.requireTable('hmtx');
    const loca = this.requireTable('loca');
    this.requireTable('glyf');
    this.requireTable('cmap');
    this._numberOfHMetrics = this._reader.uint16(hhea.offset + 34);
    this._metrics = {
      unitsPerEm: this._reader.uint16(head.offset + 18),
      ascent: this._reader.int16(hhea.offset + 4),
      descent: this._reader.int16(hhea.offset + 6),
      lineGap: this._reader.int16(hhea.offset + 8),
      glyphCount: this._reader.uint16(maxp.offset + 4)
    };
    this._glyphOffsets = parseGlyphOffsets(
      this._reader,
      loca.offset,
      this._metrics.glyphCount,
      this._reader.int16(head.offset + 50)
    );
    const metrics = parseHorizontalMetrics(
      this._reader,
      hmtx.offset,
      this._metrics.glyphCount,
      this._numberOfHMetrics
    );
    this._advanceWidths = metrics.advanceWidths;
    this._leftSideBearings = metrics.leftSideBearings;
    const cmap = parseBestCMap(this._reader, this.requireTable('cmap').offset);
    this._cmapFormat4 = cmap.format4;
    this._cmapFormat12 = cmap.format12;
    this._kernPairs = parseKernPairs(this._reader, this.getTable('kern'));
    this._gposPairs = parseGPOSPairs(this._reader, this.getTable('GPOS'));
    this._glyphCache = new Map();
  }
  static fromBuffer(buffer: ArrayBuffer) {
    return new FontAsset(buffer);
  }
  get metrics(): FontMetrics {
    return this._metrics;
  }
  getGlyphIndex(codePoint: number) {
    if (this._cmapFormat12) {
      const glyphIndex = lookupCMapFormat12(this._reader, this._cmapFormat12.offset, codePoint);
      if (glyphIndex !== 0) {
        return glyphIndex;
      }
    }
    if (this._cmapFormat4 && codePoint <= 0xffff) {
      return lookupCMapFormat4(this._reader, this._cmapFormat4.offset, codePoint);
    }
    return 0;
  }
  getKerning(leftGlyphIndex: number, rightGlyphIndex: number) {
    const gpos = this.getPairAdjustment(leftGlyphIndex, rightGlyphIndex);
    if (gpos) {
      return gpos.firstXAdvance + gpos.secondXAdvance;
    }
    return this._kernPairs.get((leftGlyphIndex << 16) | rightGlyphIndex) ?? 0;
  }
  getPairAdjustment(leftGlyphIndex: number, rightGlyphIndex: number): PairAdjustment | null {
    return lookupGPOSPair(this._gposPairs, leftGlyphIndex, rightGlyphIndex);
  }
  getGlyph(glyphIndex: number): GlyphData | null {
    if (glyphIndex < 0 || glyphIndex >= this._metrics.glyphCount) {
      return null;
    }
    if (this._glyphCache.has(glyphIndex)) {
      return this._glyphCache.get(glyphIndex)!;
    }
    const glyph = this.loadGlyph(glyphIndex, 0);
    this._glyphCache.set(glyphIndex, glyph);
    return glyph;
  }
  private getTable(tag: string) {
    return this._tables.get(tag) ?? null;
  }
  private requireTable(tag: string) {
    const table = this.getTable(tag);
    if (!table) {
      throw new Error(`Font table not found: ${tag}`);
    }
    return table;
  }
  private loadGlyph(glyphIndex: number, depth: number): GlyphData | null {
    if (depth > 16) {
      throw new Error(`Composite glyph nesting too deep: ${glyphIndex}`);
    }
    const glyf = this.requireTable('glyf');
    const offset = this._glyphOffsets[glyphIndex];
    const nextOffset = this._glyphOffsets[glyphIndex + 1];
    if (offset === nextOffset) {
      return buildGlyphData(glyphIndex, this._advanceWidths, this._leftSideBearings, [], 0, 0, 0, 0);
    }
    const glyphOffset = glyf.offset + offset;
    const header = parseGlyphHeader(this._reader, glyphOffset);
    if (header.numberOfContours >= 0) {
      const contours = parseSimpleGlyph(this._reader, glyphOffset, header.numberOfContours);
      return buildGlyphData(
        glyphIndex,
        this._advanceWidths,
        this._leftSideBearings,
        contours,
        header.xMin,
        header.yMin,
        header.xMax,
        header.yMax
      );
    }
    const contours = parseCompositeGlyph(this._reader, glyphOffset, (childIndex) =>
      this.loadGlyph(childIndex, depth + 1)
    );
    const bounds = computeBounds(contours);
    return buildGlyphData(
      glyphIndex,
      this._advanceWidths,
      this._leftSideBearings,
      contours,
      bounds.xMin,
      bounds.yMin,
      bounds.xMax,
      bounds.yMax
    );
  }
}

function parseTableDirectory(reader: SFNTReader) {
  const numTables = reader.uint16(4);
  const tables = new Map<string, TableRecord>();
  let offset = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = reader.tag(offset);
    tables.set(tag, {
      offset: reader.uint32(offset + 8),
      length: reader.uint32(offset + 12)
    });
    offset += 16;
  }
  return tables;
}

function parseGlyphOffsets(reader: SFNTReader, offset: number, glyphCount: number, indexToLocFormat: number) {
  const result = new Uint32Array(glyphCount + 1);
  if (indexToLocFormat === 0) {
    for (let i = 0; i <= glyphCount; i++) {
      result[i] = reader.uint16(offset + i * 2) * 2;
    }
  } else {
    for (let i = 0; i <= glyphCount; i++) {
      result[i] = reader.uint32(offset + i * 4);
    }
  }
  return result;
}

function parseHorizontalMetrics(
  reader: SFNTReader,
  offset: number,
  glyphCount: number,
  numberOfHMetrics: number
) {
  const advanceWidths = new Uint16Array(glyphCount);
  const leftSideBearings = new Int16Array(glyphCount);
  let cursor = offset;
  let lastAdvanceWidth = 0;
  for (let i = 0; i < glyphCount; i++) {
    if (i < numberOfHMetrics) {
      lastAdvanceWidth = reader.uint16(cursor);
      advanceWidths[i] = lastAdvanceWidth;
      leftSideBearings[i] = reader.int16(cursor + 2);
      cursor += 4;
    } else {
      advanceWidths[i] = lastAdvanceWidth;
      leftSideBearings[i] = reader.int16(cursor);
      cursor += 2;
    }
  }
  return { advanceWidths, leftSideBearings };
}

function parseBestCMap(reader: SFNTReader, offset: number) {
  const numTables = reader.uint16(offset + 2);
  let format4: { offset: number; platformId: number; encodingId: number } | null = null;
  let format12: { offset: number; platformId: number; encodingId: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const recordOffset = offset + 4 + i * 8;
    const platformId = reader.uint16(recordOffset);
    const encodingId = reader.uint16(recordOffset + 2);
    const subtableOffset = offset + reader.uint32(recordOffset + 4);
    const format = reader.uint16(subtableOffset);
    if (format === 12) {
      if (!format12 || isPreferredCMap(platformId, encodingId, format12.platformId, format12.encodingId)) {
        format12 = { offset: subtableOffset, platformId, encodingId };
      }
    } else if (format === 4) {
      if (!format4 || isPreferredCMap(platformId, encodingId, format4.platformId, format4.encodingId)) {
        format4 = { offset: subtableOffset, platformId, encodingId };
      }
    }
  }
  return { format4, format12 };
}

function isPreferredCMap(
  platformId: number,
  encodingId: number,
  currentPlatformId: number,
  currentEncodingId: number
) {
  const nextScore = getCMapScore(platformId, encodingId);
  const currentScore = getCMapScore(currentPlatformId, currentEncodingId);
  return nextScore > currentScore;
}

function getCMapScore(platformId: number, encodingId: number) {
  if (platformId === 3 && encodingId === 10) {
    return 5;
  }
  if (platformId === 0 && encodingId <= 6) {
    return 4;
  }
  if (platformId === 3 && encodingId === 1) {
    return 3;
  }
  if (platformId === 0) {
    return 2;
  }
  return 1;
}

function lookupCMapFormat12(reader: SFNTReader, offset: number, codePoint: number) {
  const nGroups = reader.uint32(offset + 12);
  let low = 0;
  let high = nGroups - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const groupOffset = offset + 16 + mid * 12;
    const startCharCode = reader.uint32(groupOffset);
    const endCharCode = reader.uint32(groupOffset + 4);
    if (codePoint < startCharCode) {
      high = mid - 1;
    } else if (codePoint > endCharCode) {
      low = mid + 1;
    } else {
      return reader.uint32(groupOffset + 8) + (codePoint - startCharCode);
    }
  }
  return 0;
}

function lookupCMapFormat4(reader: SFNTReader, offset: number, codePoint: number) {
  const segCount = reader.uint16(offset + 6) >> 1;
  const endCodeOffset = offset + 14;
  const startCodeOffset = endCodeOffset + segCount * 2 + 2;
  const idDeltaOffset = startCodeOffset + segCount * 2;
  const idRangeOffsetOffset = idDeltaOffset + segCount * 2;
  for (let i = 0; i < segCount; i++) {
    const endCode = reader.uint16(endCodeOffset + i * 2);
    if (codePoint > endCode) {
      continue;
    }
    const startCode = reader.uint16(startCodeOffset + i * 2);
    if (codePoint < startCode) {
      return 0;
    }
    const idDelta = reader.int16(idDeltaOffset + i * 2);
    const idRangeOffset = reader.uint16(idRangeOffsetOffset + i * 2);
    if (idRangeOffset === 0) {
      return (codePoint + idDelta) & 0xffff;
    }
    const glyphIndexAddress = idRangeOffsetOffset + i * 2 + idRangeOffset + (codePoint - startCode) * 2;
    const glyphIndex = reader.uint16(glyphIndexAddress);
    return glyphIndex === 0 ? 0 : (glyphIndex + idDelta) & 0xffff;
  }
  return 0;
}

function parseKernPairs(reader: SFNTReader, table: TableRecord | null) {
  const result = new Map<number, number>();
  if (!table || table.length < 4) {
    return result;
  }
  const version = reader.uint16(table.offset);
  if (version !== 0) {
    return result;
  }
  const nTables = reader.uint16(table.offset + 2);
  let cursor = table.offset + 4;
  for (let i = 0; i < nTables; i++) {
    const length = reader.uint16(cursor + 2);
    const coverage = reader.uint16(cursor + 4);
    const format = coverage >> 8;
    if (format === 0) {
      const nPairs = reader.uint16(cursor + 6);
      let pairOffset = cursor + 14;
      for (let j = 0; j < nPairs; j++) {
        const left = reader.uint16(pairOffset);
        const right = reader.uint16(pairOffset + 2);
        const value = reader.int16(pairOffset + 4);
        result.set((left << 16) | right, value);
        pairOffset += 6;
      }
    }
    cursor += length;
  }
  return result;
}

function parseGPOSPairs(reader: SFNTReader, table: TableRecord | null) {
  if (!table || table.length < 10) {
    return [];
  }
  const majorVersion = reader.uint16(table.offset);
  if (majorVersion !== 1) {
    return [];
  }
  const featureListOffset = reader.uint16(table.offset + 6);
  const lookupListOffset = reader.uint16(table.offset + 8);
  if (!featureListOffset || !lookupListOffset) {
    return [];
  }
  const featureLookupIndices = collectGPOSFeatureLookupIndices(reader, table.offset + featureListOffset);
  if (featureLookupIndices.length === 0) {
    return [];
  }
  return parseGPOSLookupSubtables(
    reader,
    table.offset + lookupListOffset,
    table.offset,
    featureLookupIndices
  );
}

function collectGPOSFeatureLookupIndices(reader: SFNTReader, featureListOffset: number) {
  const featureCount = reader.uint16(featureListOffset);
  const featureTags = new Set(['kern']);
  const lookupIndices = new Set<number>();
  for (let i = 0; i < featureCount; i++) {
    const recordOffset = featureListOffset + 2 + i * 6;
    const tag = reader.tag(recordOffset);
    if (!featureTags.has(tag)) {
      continue;
    }
    const featureOffset = featureListOffset + reader.uint16(recordOffset + 4);
    const lookupIndexCount = reader.uint16(featureOffset + 2);
    for (let j = 0; j < lookupIndexCount; j++) {
      lookupIndices.add(reader.uint16(featureOffset + 4 + j * 2));
    }
  }
  return [...lookupIndices].sort((a, b) => a - b);
}

function parseGPOSLookupSubtables(
  reader: SFNTReader,
  lookupListOffset: number,
  gposOffset: number,
  lookupIndices: number[]
) {
  const lookupCount = reader.uint16(lookupListOffset);
  const result: GPOSPairSubtable[] = [];
  for (const lookupIndex of lookupIndices) {
    if (lookupIndex >= lookupCount) {
      continue;
    }
    const lookupOffset = lookupListOffset + reader.uint16(lookupListOffset + 2 + lookupIndex * 2);
    const lookupType = reader.uint16(lookupOffset);
    const subtableCount = reader.uint16(lookupOffset + 4);
    for (let i = 0; i < subtableCount; i++) {
      const subtableOffset = lookupOffset + reader.uint16(lookupOffset + 6 + i * 2);
      if (lookupType === 2) {
        const parsed = parsePairPosSubtable(reader, subtableOffset);
        if (parsed) {
          result.push(parsed);
        }
      } else if (lookupType === 9) {
        const extensionLookupType = reader.uint16(subtableOffset + 2);
        const extensionOffset = reader.uint32(subtableOffset + 4);
        if (extensionLookupType === 2) {
          const parsed = parsePairPosSubtable(reader, subtableOffset + extensionOffset);
          if (parsed) {
            result.push(parsed);
          }
        }
      }
    }
  }
  return result;
}

function parsePairPosSubtable(reader: SFNTReader, offset: number): GPOSPairSubtable | null {
  const format = reader.uint16(offset);
  if (format === 1) {
    return parsePairPosFormat1(reader, offset);
  }
  if (format === 2) {
    return parsePairPosFormat2(reader, offset);
  }
  return null;
}

function parsePairPosFormat1(reader: SFNTReader, offset: number): GPOSPairSubtable {
  const coverage = parseCoverageTable(reader, offset + reader.uint16(offset + 2));
  const valueFormat1 = reader.uint16(offset + 4);
  const valueFormat2 = reader.uint16(offset + 6);
  const pairSetCount = reader.uint16(offset + 8);
  const pairs = new Map<number, Map<number, PairAdjustment>>();
  for (let i = 0; i < pairSetCount; i++) {
    const firstGlyph = getCoverageGlyph(coverage, i);
    if (firstGlyph < 0) {
      continue;
    }
    const pairSetOffset = offset + reader.uint16(offset + 10 + i * 2);
    const pairValueCount = reader.uint16(pairSetOffset);
    let cursor = pairSetOffset + 2;
    const secondMap = new Map<number, PairAdjustment>();
    for (let j = 0; j < pairValueCount; j++) {
      const secondGlyph = reader.uint16(cursor);
      cursor += 2;
      const value1 = readValueRecordX(reader, cursor, valueFormat1);
      cursor += getValueRecordSize(valueFormat1);
      const value2 = readValueRecordX(reader, cursor, valueFormat2);
      cursor += getValueRecordSize(valueFormat2);
      const adjustment = {
        firstXPlacement: value1.xPlacement,
        firstXAdvance: value1.xAdvance,
        secondXPlacement: value2.xPlacement,
        secondXAdvance: value2.xAdvance
      } satisfies PairAdjustment;
      if (
        adjustment.firstXPlacement !== 0 ||
        adjustment.firstXAdvance !== 0 ||
        adjustment.secondXPlacement !== 0 ||
        adjustment.secondXAdvance !== 0
      ) {
        secondMap.set(secondGlyph, adjustment);
      }
    }
    pairs.set(firstGlyph, secondMap);
  }
  return { kind: 'format1', coverage, pairs };
}

function parsePairPosFormat2(reader: SFNTReader, offset: number): GPOSPairSubtable {
  const coverage = parseCoverageTable(reader, offset + reader.uint16(offset + 2));
  const valueFormat1 = reader.uint16(offset + 4);
  const valueFormat2 = reader.uint16(offset + 6);
  const classDef1 = parseClassDefTable(reader, offset + reader.uint16(offset + 8));
  const classDef2 = parseClassDefTable(reader, offset + reader.uint16(offset + 10));
  const class1Count = reader.uint16(offset + 12);
  const class2Count = reader.uint16(offset + 14);
  const values: PairAdjustment[] = new Array(class1Count * class2Count);
  let cursor = offset + 16;
  for (let c1 = 0; c1 < class1Count; c1++) {
    for (let c2 = 0; c2 < class2Count; c2++) {
      const value1 = readValueRecordX(reader, cursor, valueFormat1);
      cursor += getValueRecordSize(valueFormat1);
      const value2 = readValueRecordX(reader, cursor, valueFormat2);
      cursor += getValueRecordSize(valueFormat2);
      values[c1 * class2Count + c2] = {
        firstXPlacement: value1.xPlacement,
        firstXAdvance: value1.xAdvance,
        secondXPlacement: value2.xPlacement,
        secondXAdvance: value2.xAdvance
      };
    }
  }
  return { kind: 'format2', coverage, classDef1, classDef2, class1Count, class2Count, values };
}

function parseCoverageTable(reader: SFNTReader, offset: number): CoverageTable {
  const format = reader.uint16(offset);
  if (format === 1) {
    const glyphCount = reader.uint16(offset + 2);
    const glyphs = new Uint16Array(glyphCount);
    for (let i = 0; i < glyphCount; i++) {
      glyphs[i] = reader.uint16(offset + 4 + i * 2);
    }
    return { format: 1, glyphs };
  }
  const rangeCount = reader.uint16(offset + 2);
  const ranges: { start: number; end: number; startIndex: number }[] = [];
  for (let i = 0; i < rangeCount; i++) {
    const rangeOffset = offset + 4 + i * 6;
    ranges.push({
      start: reader.uint16(rangeOffset),
      end: reader.uint16(rangeOffset + 2),
      startIndex: reader.uint16(rangeOffset + 4)
    });
  }
  return { format: 2, ranges };
}

function getCoverageGlyph(coverage: CoverageTable, index: number) {
  if (coverage.format === 1) {
    return coverage.glyphs[index] ?? -1;
  }
  for (const range of coverage.ranges) {
    const rangeLength = range.end - range.start + 1;
    if (index >= range.startIndex && index < range.startIndex + rangeLength) {
      return range.start + (index - range.startIndex);
    }
  }
  return -1;
}

function coverageContains(coverage: CoverageTable, glyphIndex: number) {
  if (coverage.format === 1) {
    return binarySearchU16(coverage.glyphs, glyphIndex) >= 0;
  }
  for (const range of coverage.ranges) {
    if (glyphIndex >= range.start && glyphIndex <= range.end) {
      return true;
    }
  }
  return false;
}

function parseClassDefTable(reader: SFNTReader, offset: number): ClassDefTable {
  const format = reader.uint16(offset);
  if (format === 1) {
    const startGlyphId = reader.uint16(offset + 2);
    const glyphCount = reader.uint16(offset + 4);
    const classes = new Uint16Array(glyphCount);
    for (let i = 0; i < glyphCount; i++) {
      classes[i] = reader.uint16(offset + 6 + i * 2);
    }
    return { format: 1, startGlyphId, classes };
  }
  const classRangeCount = reader.uint16(offset + 2);
  const ranges: { start: number; end: number; classId: number }[] = [];
  for (let i = 0; i < classRangeCount; i++) {
    const rangeOffset = offset + 4 + i * 6;
    ranges.push({
      start: reader.uint16(rangeOffset),
      end: reader.uint16(rangeOffset + 2),
      classId: reader.uint16(rangeOffset + 4)
    });
  }
  return { format: 2, ranges };
}

function getGlyphClass(classDef: ClassDefTable, glyphIndex: number) {
  if (classDef.format === 1) {
    const index = glyphIndex - classDef.startGlyphId;
    return index >= 0 && index < classDef.classes.length ? classDef.classes[index] : 0;
  }
  for (const range of classDef.ranges) {
    if (glyphIndex >= range.start && glyphIndex <= range.end) {
      return range.classId;
    }
  }
  return 0;
}

function readValueRecordX(reader: SFNTReader, offset: number, valueFormat: number) {
  let cursor = offset;
  let xPlacement = 0;
  let xAdvance = 0;
  if (valueFormat & 0x0001) {
    xPlacement = reader.int16(cursor);
    cursor += 2;
  }
  if (valueFormat & 0x0002) {
    cursor += 2;
  }
  if (valueFormat & 0x0004) {
    xAdvance = reader.int16(cursor);
    cursor += 2;
  }
  if (valueFormat & 0x0008) {
    cursor += 2;
  }
  if (valueFormat & 0x0010) {
    cursor += 2;
  }
  if (valueFormat & 0x0020) {
    cursor += 2;
  }
  if (valueFormat & 0x0040) {
    cursor += 2;
  }
  if (valueFormat & 0x0080) {
    cursor += 2;
  }
  return { xPlacement, xAdvance };
}

function getValueRecordSize(valueFormat: number) {
  let size = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (valueFormat & (1 << bit)) {
      size += 2;
    }
  }
  return size;
}

function lookupGPOSPair(subtables: GPOSPairSubtable[], leftGlyphIndex: number, rightGlyphIndex: number) {
  let merged: PairAdjustment | null = null;
  for (const subtable of subtables) {
    if (!coverageContains(subtable.coverage, leftGlyphIndex)) {
      continue;
    }
    if (subtable.kind === 'format1') {
      const secondMap = subtable.pairs.get(leftGlyphIndex);
      if (secondMap) {
        const adjustment = secondMap.get(rightGlyphIndex);
        if (adjustment) {
          merged = mergePairAdjustment(merged, adjustment);
        }
      }
    } else {
      const class1 = getGlyphClass(subtable.classDef1, leftGlyphIndex);
      const class2 = getGlyphClass(subtable.classDef2, rightGlyphIndex);
      if (class1 < subtable.class1Count && class2 < subtable.class2Count) {
        const adjustment = subtable.values[class1 * subtable.class2Count + class2];
        if (adjustment) {
          merged = mergePairAdjustment(merged, adjustment);
        }
      }
    }
  }
  return merged;
}

function binarySearchU16(values: Uint16Array<ArrayBuffer>, target: number) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = values[mid];
    if (value < target) {
      low = mid + 1;
    } else if (value > target) {
      high = mid - 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function mergePairAdjustment(base: PairAdjustment | null, next: PairAdjustment): PairAdjustment {
  if (!base) {
    return { ...next };
  }
  return {
    firstXPlacement: base.firstXPlacement + next.firstXPlacement,
    firstXAdvance: base.firstXAdvance + next.firstXAdvance,
    secondXPlacement: base.secondXPlacement + next.secondXPlacement,
    secondXAdvance: base.secondXAdvance + next.secondXAdvance
  };
}

function parseGlyphHeader(reader: SFNTReader, offset: number): GlyphHeader {
  return {
    numberOfContours: reader.int16(offset),
    xMin: reader.int16(offset + 2),
    yMin: reader.int16(offset + 4),
    xMax: reader.int16(offset + 6),
    yMax: reader.int16(offset + 8)
  };
}

function parseSimpleGlyph(reader: SFNTReader, offset: number, numberOfContours: number): GlyphContour[] {
  const endPts: number[] = [];
  let cursor = offset + 10;
  for (let i = 0; i < numberOfContours; i++) {
    endPts.push(reader.uint16(cursor));
    cursor += 2;
  }
  const pointCount = endPts[numberOfContours - 1] + 1;
  const instructionLength = reader.uint16(cursor);
  cursor += 2 + instructionLength;
  const flags = new Uint8Array(pointCount);
  for (let i = 0; i < pointCount; ) {
    const flag = reader.uint8(cursor++);
    flags[i++] = flag;
    if (flag & 0x08) {
      const repeatCount = reader.uint8(cursor++);
      for (let j = 0; j < repeatCount; j++) {
        flags[i++] = flag;
      }
    }
  }
  const xs = new Int16Array(pointCount);
  const ys = new Int16Array(pointCount);
  let currentX = 0;
  for (let i = 0; i < pointCount; i++) {
    const flag = flags[i];
    if (flag & 0x02) {
      const dx = reader.uint8(cursor++);
      currentX += flag & 0x10 ? dx : -dx;
    } else if (!(flag & 0x10)) {
      currentX += reader.int16(cursor);
      cursor += 2;
    }
    xs[i] = currentX;
  }
  let currentY = 0;
  for (let i = 0; i < pointCount; i++) {
    const flag = flags[i];
    if (flag & 0x04) {
      const dy = reader.uint8(cursor++);
      currentY += flag & 0x20 ? dy : -dy;
    } else if (!(flag & 0x20)) {
      currentY += reader.int16(cursor);
      cursor += 2;
    }
    ys[i] = currentY;
  }
  const points: GlyphPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    points.push({
      x: xs[i],
      y: ys[i],
      onCurve: !!(flags[i] & 0x01)
    });
  }
  const contours: GlyphContour[] = [];
  let start = 0;
  for (const end of endPts) {
    contours.push(expandImplicitPoints(points.slice(start, end + 1)));
    start = end + 1;
  }
  return contours;
}

function parseCompositeGlyph(
  reader: SFNTReader,
  offset: number,
  loadGlyph: (glyphIndex: number) => GlyphData | null
): GlyphContour[] {
  let cursor = offset + 10;
  const contours: GlyphContour[] = [];
  let flags = 0;
  do {
    flags = reader.uint16(cursor);
    const glyphIndex = reader.uint16(cursor + 2);
    cursor += 4;
    const component = parseCompositeComponent(reader, cursor, flags, glyphIndex);
    cursor = component.cursor;
    const child = loadGlyph(component.data.glyphIndex);
    if (child) {
      for (const contour of child.contours) {
        contours.push(
          contour.map((point) => ({
            x: point.x * component.data.xx + point.y * component.data.xy + component.data.dx,
            y: point.x * component.data.yx + point.y * component.data.yy + component.data.dy,
            onCurve: point.onCurve
          }))
        );
      }
    }
  } while (flags & MORE_COMPONENTS);
  return contours;
}

function parseCompositeComponent(reader: SFNTReader, offset: number, flags: number, glyphIndex: number) {
  let cursor = offset;
  let arg1 = 0;
  let arg2 = 0;
  if (flags & ARG_1_AND_2_ARE_WORDS) {
    arg1 = reader.int16(cursor);
    arg2 = reader.int16(cursor + 2);
    cursor += 4;
  } else {
    arg1 = reader.int8(cursor);
    arg2 = reader.int8(cursor + 1);
    cursor += 2;
  }
  let dx = 0;
  let dy = 0;
  if (flags & ARGS_ARE_XY_VALUES) {
    dx = arg1;
    dy = arg2;
  }
  let xx = 1;
  let xy = 0;
  let yx = 0;
  let yy = 1;
  if (flags & WE_HAVE_A_SCALE) {
    const scale = readF2Dot14(reader, cursor);
    cursor += 2;
    xx = scale;
    yy = scale;
  } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
    xx = readF2Dot14(reader, cursor);
    yy = readF2Dot14(reader, cursor + 2);
    cursor += 4;
  } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
    xx = readF2Dot14(reader, cursor);
    xy = readF2Dot14(reader, cursor + 2);
    yx = readF2Dot14(reader, cursor + 4);
    yy = readF2Dot14(reader, cursor + 6);
    cursor += 8;
  }
  return {
    data: { glyphIndex, dx, dy, xx, xy, yx, yy } satisfies CompositeComponent,
    cursor
  };
}

function readF2Dot14(reader: SFNTReader, offset: number) {
  return reader.int16(offset) / 16384;
}

function expandImplicitPoints(points: GlyphPoint[]) {
  if (points.length === 0) {
    return points;
  }
  const result: GlyphPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    result.push(current);
    if (!current.onCurve && !next.onCurve) {
      result.push({
        x: (current.x + next.x) * 0.5,
        y: (current.y + next.y) * 0.5,
        onCurve: true
      });
    }
  }
  return result;
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

function buildGlyphData(
  glyphIndex: number,
  advanceWidths: Uint16Array<ArrayBuffer>,
  leftSideBearings: Int16Array<ArrayBuffer>,
  contours: GlyphContour[],
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number
): GlyphData {
  return {
    glyphIndex,
    advanceWidth: advanceWidths[glyphIndex] ?? 0,
    leftSideBearing: leftSideBearings[glyphIndex] ?? 0,
    xMin,
    yMin,
    xMax,
    yMax,
    contours
  };
}
