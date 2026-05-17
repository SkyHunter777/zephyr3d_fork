import type { Scene } from './scene';
import { BaseSprite } from './basesprite';
import type { Immutable, Nullable } from '@zephyr3d/base';
import { splitStringByGraphemes, Vector3 } from '@zephyr3d/base';
import { Font } from '@zephyr3d/device';
import { getDevice } from '../app/api';
import { SDFSpriteMaterial } from '../material/sprite_sdf';
import type { Sprite } from './sprite';

const SDF_SOURCE_SCALE = 4;
const SDF_RADIUS = 8;
const INF = 1e20;

type TextLayoutLine = {
  text: string;
  width: number;
};

class SDFTextCanvas {
  private static _context: Nullable<CanvasRenderingContext2D> = null;
  static get context() {
    if (!this._context) {
      const canvas = document.createElement('canvas');
      this._context = canvas.getContext('2d', {
        willReadFrequently: true
      })!;
      this._context.textBaseline = 'top';
      this._context.textAlign = 'left';
      this._context.imageSmoothingEnabled = true;
      this._context.imageSmoothingQuality = 'high';
    }
    return this._context!;
  }
  static resize(width: number, height: number) {
    const canvas = this.context.canvas;
    if (canvas.width !== width) {
      canvas.width = width;
    }
    if (canvas.height !== height) {
      canvas.height = height;
    }
    const ctx = this.context;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }
}

/**
 * 3D SDF text sprite node.
 *
 * @public
 */
export class SDFTextSprite extends BaseSprite<SDFSpriteMaterial> {
  private _resolutionX: number;
  private _resolutionY: number;
  private _text: string;
  private _font: string;
  private _color: Vector3;
  constructor(scene: Scene) {
    super(scene);
    this.material = new SDFSpriteMaterial();
    this._resolutionX = 128;
    this._resolutionY = 128;
    this._text = '';
    this._font = '12px arial';
    this._color = new Vector3(1, 1, 1);
    this.material.textColor = this._color;
    this.scene!.queueUpdateNode(this);
  }
  isSprite(): this is Sprite {
    return true;
  }
  get resolutionX() {
    return this._resolutionX;
  }
  set resolutionX(value) {
    if (this._resolutionX !== value) {
      this._resolutionX = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get resolutionY() {
    return this._resolutionY;
  }
  set resolutionY(value) {
    if (this._resolutionY !== value) {
      this._resolutionY = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get text() {
    return this._text;
  }
  set text(value) {
    if (this._text !== value) {
      this._text = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get textColor(): Immutable<Vector3> {
    return this._color;
  }
  set textColor(value: Immutable<Vector3>) {
    if (!this._color.equalsTo(value)) {
      this._color.set(value);
      this.material.textColor = value;
    }
  }
  get font() {
    return this._font;
  }
  set font(value) {
    if (this._font !== value) {
      this._font = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  update(): void {
    const tex = this.ensureTexture();
    const mask = this.renderSDFTexture();
    tex.update(mask, 0, 0, this._resolutionX, this._resolutionY);
    this.material.spriteTexture = tex;
    this.material.textColor = this._color;
    this.material.setSDFTextureInfo(SDF_RADIUS, this._resolutionX, this._resolutionY);
  }
  private ensureTexture() {
    let tex = this.material.spriteTexture;
    if (
      !tex ||
      tex.width !== this._resolutionX ||
      tex.height !== this._resolutionY ||
      tex.format !== 'r8unorm'
    ) {
      tex = getDevice().createTexture2D('r8unorm', this._resolutionX, this._resolutionY, {
        mipmapping: false,
        samplerOptions: { minFilter: 'linear', magFilter: 'linear' }
      })!;
    }
    return tex;
  }
  private renderSDFTexture() {
    const sourcePadding = (SDF_RADIUS + 2) * SDF_SOURCE_SCALE;
    const sourceWidth = this._resolutionX * SDF_SOURCE_SCALE + sourcePadding * 2;
    const sourceHeight = this._resolutionY * SDF_SOURCE_SCALE + sourcePadding * 2;
    const ctx = SDFTextCanvas.resize(sourceWidth, sourceHeight);
    ctx.clearRect(0, 0, sourceWidth, sourceHeight);
    const font = Font.fetchFont(this._font, SDF_SOURCE_SCALE);
    ctx.font = font.fontNameScaled;
    ctx.fillStyle = '#ffffff';
    const lines = this.layoutText(ctx, font, this._text, this._resolutionX * SDF_SOURCE_SCALE);
    const lineHeight = font.maxHeightScaled;
    for (let i = 0; i < lines.length; i++) {
      const lineY = sourcePadding + i * lineHeight;
      if (lineY >= sourcePadding + this._resolutionY * SDF_SOURCE_SCALE) {
        break;
      }
      ctx.fillText(lines[i].text, sourcePadding, lineY - font.topScaled);
    }
    const alpha = ctx.getImageData(0, 0, sourceWidth, sourceHeight).data;
    const distToOutside = new Float32Array(sourceWidth * sourceHeight);
    const distToInside = new Float32Array(sourceWidth * sourceHeight);
    initializeDistanceGrids(alpha, distToOutside, distToInside);
    distanceTransform(distToOutside, sourceWidth, sourceHeight);
    distanceTransform(distToInside, sourceWidth, sourceHeight);
    const out = new Uint8Array(this._resolutionX * this._resolutionY);
    for (let y = 0; y < this._resolutionY; y++) {
      const sourceY = clampInt(
        Math.round(sourcePadding + (y + 0.5) * SDF_SOURCE_SCALE - 0.5),
        0,
        sourceHeight - 1
      );
      for (let x = 0; x < this._resolutionX; x++) {
        const sourceX = clampInt(
          Math.round(sourcePadding + (x + 0.5) * SDF_SOURCE_SCALE - 0.5),
          0,
          sourceWidth - 1
        );
        const sourceIndex = sourceY * sourceWidth + sourceX;
        const signedDistance =
          (Math.sqrt(distToOutside[sourceIndex]) - Math.sqrt(distToInside[sourceIndex])) / SDF_SOURCE_SCALE;
        const value = clamp01(0.5 + signedDistance / (2 * SDF_RADIUS));
        out[y * this._resolutionX + x] = Math.round(value * 255);
      }
    }
    return out;
  }
  private layoutText(
    ctx: CanvasRenderingContext2D,
    font: Font,
    text: string,
    maxWidth: number
  ): TextLayoutLine[] {
    const result: TextLayoutLine[] = [];
    const paragraphs = text.split(/\r\n|\r|\n/);
    for (const paragraph of paragraphs) {
      if (paragraph.length === 0) {
        result.push({ text: '', width: 0 });
        continue;
      }
      const chars = splitStringByGraphemes(paragraph);
      let start = 0;
      while (start < chars.length) {
        let width = 0;
        let breakPos = start;
        let lastWhitespaceBreak = -1;
        while (breakPos < chars.length) {
          const ch = chars[breakPos];
          const charWidth = measureGlyphWidth(ctx, ch);
          if (breakPos > start && width + charWidth > maxWidth) {
            break;
          }
          width += charWidth;
          breakPos++;
          if (/^\s$/u.test(ch)) {
            lastWhitespaceBreak = breakPos;
          }
        }
        if (breakPos < chars.length && lastWhitespaceBreak > start) {
          const lineText = chars.slice(start, lastWhitespaceBreak).join('').replace(/\s+$/u, '');
          result.push({
            text: lineText,
            width: this.measureLineWidth(ctx, lineText)
          });
          start = lastWhitespaceBreak;
          while (start < chars.length && /^\s$/u.test(chars[start])) {
            start++;
          }
        } else {
          const lineText = chars.slice(start, breakPos).join('');
          result.push({ text: lineText, width });
          start = Math.max(breakPos, start + 1);
        }
      }
    }
    return result;
  }
  private measureLineWidth(ctx: CanvasRenderingContext2D, text: string) {
    let width = 0;
    for (const ch of splitStringByGraphemes(text)) {
      width += measureGlyphWidth(ctx, ch);
    }
    return width;
  }
}

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function clampInt(value: number, minValue: number, maxValue: number) {
  return Math.min(Math.max(value, minValue), maxValue);
}

function square(value: number) {
  return value * value;
}

function measureGlyphWidth(ctx: CanvasRenderingContext2D, char: string) {
  const metric = ctx.measureText(char);
  let width = metric.width;
  if (width === 0) {
    return 0;
  }
  if (typeof metric.actualBoundingBoxRight === 'number') {
    width = Math.floor(Math.max(width, metric.actualBoundingBoxRight) + 0.8);
  }
  return Math.round(width);
}

function initializeDistanceGrids(alpha: Uint8ClampedArray, outside: Float32Array, inside: Float32Array) {
  for (let i = 0; i < outside.length; i++) {
    const a = alpha[i * 4 + 3] / 255;
    if (a <= 0) {
      outside[i] = INF;
      inside[i] = 0;
    } else if (a >= 1) {
      outside[i] = 0;
      inside[i] = INF;
    } else {
      outside[i] = square(Math.max(0, 0.5 - a));
      inside[i] = square(Math.max(0, a - 0.5));
    }
  }
}

function distanceTransform(grid: Float32Array, width: number, height: number) {
  const temp = new Float32Array(grid.length);
  const f = new Float32Array(Math.max(width, height));
  const d = new Float32Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float32Array(Math.max(width, height) + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = grid[y * width + x];
    }
    edt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) {
      temp[y * width + x] = d[y];
    }
  }
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      f[x] = temp[rowOffset + x];
    }
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) {
      temp[rowOffset + x] = d[x];
    }
  }
  grid.set(temp);
}

function edt1d(f: Float32Array, count: number, out: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < count; q++) {
    let s = 0;
    do {
      const r = v[k];
      s = (f[q] + q * q - (f[r] + r * r)) / (q - r) / 2;
      if (s <= z[k]) {
        k--;
      } else {
        break;
      }
    } while (k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < count; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const r = v[k];
    const delta = q - r;
    out[q] = delta * delta + f[r];
  }
}
