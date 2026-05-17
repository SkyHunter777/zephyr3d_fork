import { TextureAtlasManager } from '@zephyr3d/device';
import type { AbstractDevice, Texture2D } from '@zephyr3d/device';
import type { FontAsset, GlyphData } from '../font';
import { generateMSDF } from '../msdf';

export type MSDFGlyphInfo = {
  glyphIndex: number;
  advanceWidth: number;
  leftSideBearing: number;
  atlasIndex: number;
  width: number;
  height: number;
  uMin: number;
  vMin: number;
  uMax: number;
  vMax: number;
  planeLeft: number;
  planeBottom: number;
  planeRight: number;
  planeTop: number;
};

/**
 * Runtime dynamic MSDF glyph atlas.
 *
 * @public
 */
export class MSDFGlyphAtlas extends TextureAtlasManager {
  private readonly _font: FontAsset;
  private readonly _glyphs: Map<string, MSDFGlyphInfo>;
  private readonly _range: number;
  private readonly _glyphSize: number;
  private readonly _padding: number;
  constructor(
    device: AbstractDevice,
    font: FontAsset,
    glyphSize = 64,
    atlasSize = 1024,
    range = 6,
    padding = 2
  ) {
    super(device, atlasSize, atlasSize, 0, true);
    this._font = font;
    this._glyphs = new Map();
    this._range = range;
    this._glyphSize = glyphSize;
    this._padding = padding;
    this.atlasTextureRestoreHandler = async () => {
      const glyphs = [...this._glyphs.values()];
      this._glyphs.clear();
      if (!this.isEmpty()) {
        this.clear();
      }
      for (const glyph of glyphs) {
        this.ensureGlyph(glyph.glyphIndex);
      }
    };
  }
  get font() {
    return this._font;
  }
  get glyphSize() {
    return this._glyphSize;
  }
  get distanceRange() {
    return this._range;
  }
  getAtlasTexture(index: number): Texture2D | undefined {
    return super.getAtlasTexture(index);
  }
  ensureGlyph(glyphIndex: number) {
    const key = String(glyphIndex);
    const cached = this._glyphs.get(key);
    if (cached) {
      return cached;
    }
    const glyph = this._font.getGlyph(glyphIndex);
    if (!glyph) {
      return null;
    }
    try {
      const info = this.createGlyph(glyph);
      this._glyphs.set(key, info);
      return info;
    } catch {
      return null;
    }
  }
  private createGlyph(glyph: GlyphData): MSDFGlyphInfo {
    if (glyph.contours.length === 0 || glyph.xMax <= glyph.xMin || glyph.yMax <= glyph.yMin) {
      throw new Error(`Invalid glyph outline for glyph ${glyph.glyphIndex}`);
    }
    const targetScale = this._glyphSize / this._font.metrics.unitsPerEm;
    const bitmapWidth = Math.max(8, Math.ceil((glyph.xMax - glyph.xMin) * targetScale) + this._padding * 2);
    const bitmapHeight = Math.max(8, Math.ceil((glyph.yMax - glyph.yMin) * targetScale) + this._padding * 2);
    const bitmap = generateMSDF(glyph, {
      width: bitmapWidth,
      height: bitmapHeight,
      range: this._range,
      padding: this._padding
    });
    const atlasInfo = this.pushBitmap(
      String(glyph.glyphIndex),
      new ImageData(new Uint8ClampedArray(bitmap.pixels.buffer.slice(0)), bitmap.width, bitmap.height)
    );
    if (!atlasInfo) {
      throw new Error(`MSDF glyph atlas is full for glyph ${glyph.glyphIndex}`);
    }
    const xShift = glyph.leftSideBearing - glyph.xMin;
    return {
      glyphIndex: glyph.glyphIndex,
      advanceWidth: glyph.advanceWidth,
      leftSideBearing: glyph.leftSideBearing,
      atlasIndex: atlasInfo.atlasIndex,
      width: atlasInfo.width,
      height: atlasInfo.height,
      uMin: atlasInfo.uMin,
      vMin: atlasInfo.vMin,
      uMax: atlasInfo.uMax,
      vMax: atlasInfo.vMax,
      planeLeft: (-bitmap.translateX + 0.5) / bitmap.scale + xShift,
      planeBottom: -(bitmap.height - bitmap.translateY - 0.5) / bitmap.scale,
      planeRight: (bitmap.width - bitmap.translateX - 0.5) / bitmap.scale + xShift,
      planeTop: (bitmap.translateY - 0.5) / bitmap.scale
    };
  }
}
