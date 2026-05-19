import type { AABB, Immutable } from '@zephyr3d/base';
import { Vector2, Vector3 } from '@zephyr3d/base';
import type { Scene } from './scene';
import { BoundingBox } from '../utility/bounding_volume';
import { Primitive } from '../render';
import type { FontAsset } from '../text/font';
import type { MSDFGlyphAtlas } from '../text/runtime';
import { layoutText, type TextAlign, type TextLayoutResult } from '../text/runtime';
import { getEngine } from '../app/api';
import { MeshDrawable } from './meshdrawable';
import { GraphNode } from './graph_node';
import { MSDFTextMaterial } from '../material/msdf_text';

/**
 * Billboard MSDF text node.
 *
 * @public
 */
export class MSDFText extends GraphNode {
  private _fontAsset: FontAsset | null;
  private _atlas: MSDFGlyphAtlas | null;
  private _castShadow: boolean;
  private _text: string;
  private _fontSize: number;
  private _maxWidth: number;
  private _textAlign: TextAlign;
  private _anchor: Vector2;
  private _color: Vector3;
  private _outlineWidth: number;
  private _outlineColor: Vector3;
  private _pageBatches: MeshDrawable<MSDFTextMaterial>[];
  constructor(scene: Scene) {
    super(scene);
    this._castShadow = false;
    this._fontAsset = null;
    this._atlas = null;
    this._text = '';
    this._fontSize = 32;
    this._maxWidth = 0;
    this._textAlign = 'left';
    this._anchor = new Vector2(0.5, 0.5);
    this._color = new Vector3(1, 1, 1);
    this._outlineWidth = 0;
    this._outlineColor = new Vector3(0, 0, 0);
    this._pageBatches = [];
    this.scene!.queueUpdateNode(this);
  }
  get castShadow() {
    return this._castShadow;
  }
  set castShadow(value) {
    this._castShadow = value;
  }
  get fontAsset() {
    return this._fontAsset;
  }
  set fontAsset(font: FontAsset | null) {
    if (this._fontAsset !== font) {
      this._fontAsset = font;
      this._atlas = font ? getEngine().msdfTextAtlasManager.getAtlas(font) : null;
      this.scene!.queueUpdateNode(this);
    }
  }
  get text() {
    return this._text;
  }
  set text(value) {
    if (this._text !== value) {
      this._text = value ?? '';
      this.scene!.queueUpdateNode(this);
    }
  }
  get fontSize() {
    return this._fontSize;
  }
  set fontSize(value) {
    if (this._fontSize !== value) {
      this._fontSize = Math.max(1, value);
      this.scene!.queueUpdateNode(this);
    }
  }
  get maxWidth() {
    return this._maxWidth;
  }
  set maxWidth(value) {
    if (this._maxWidth !== value) {
      this._maxWidth = Math.max(0, value);
      this.scene!.queueUpdateNode(this);
    }
  }
  get textAlign() {
    return this._textAlign;
  }
  set textAlign(value: TextAlign) {
    if (this._textAlign !== value) {
      this._textAlign = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get anchorX() {
    return this._anchor.x;
  }
  set anchorX(value) {
    if (this._anchor.x !== value) {
      this._anchor.x = value;
      this.scene!.queueUpdateNode(this);
      this.invalidateWorldBoundingVolume(false);
    }
  }
  get anchorY() {
    return this._anchor.y;
  }
  set anchorY(value) {
    if (this._anchor.y !== value) {
      this._anchor.y = value;
      this.scene!.queueUpdateNode(this);
      this.invalidateWorldBoundingVolume(false);
    }
  }
  get anchor(): Immutable<Vector2> {
    return this._anchor;
  }
  set anchor(value: Immutable<Vector2>) {
    if (!this._anchor.equalsTo(value)) {
      this._anchor.set(value);
      this.scene!.queueUpdateNode(this);
      this.invalidateWorldBoundingVolume(false);
    }
  }
  get textColor(): Immutable<Vector3> {
    return this._color;
  }
  set textColor(value: Immutable<Vector3>) {
    if (!this._color.equalsTo(value)) {
      this._color.set(value);
      for (const batch of this._pageBatches) {
        batch.material!.textColor = value;
      }
    }
  }
  get outlineWidth() {
    return this._outlineWidth;
  }
  set outlineWidth(value) {
    if (this._outlineWidth !== value) {
      this._outlineWidth = value;
      for (const batch of this._pageBatches) {
        batch.material!.outlineWidth = value;
      }
    }
  }
  get outlineColor(): Immutable<Vector3> {
    return this._outlineColor;
  }
  set outlineColor(value: Immutable<Vector3>) {
    if (!this._outlineColor.equalsTo(value)) {
      this._outlineColor.set(value);
      for (const batch of this._pageBatches) {
        batch.material!.outlineColor = value;
      }
    }
  }
  get batches() {
    return this._pageBatches;
  }
  update(): void {
    if (!this._fontAsset || !this._atlas || !this._text) {
      this.disposePageBatches();
      return;
    }
    const layout = layoutText(this._atlas, this._fontAsset, this._text, this._fontSize, this._maxWidth);
    const bv = new BoundingBox();
    bv.beginExtend();
    const geometries = buildPagedSpriteGeometry(
      layout,
      this._fontAsset.metrics.unitsPerEm,
      this._fontAsset.metrics.ascent,
      this._fontSize,
      this._anchor,
      this._textAlign,
      bv
    );
    const pageIndices = [...geometries.pages.keys()].sort((a, b) => a - b);
    for (let i = 0; i < pageIndices.length; i++) {
      const pageIndex = pageIndices[i];
      const geometry = geometries.pages.get(pageIndex)!;
      const batch = this.ensurePageBatch(i);
      updatePrimitiveGeometry(batch.primitive!, geometry.positions, geometry.uvs, geometry.indices);
      batch.primitive!.setBoundingVolume(bv);
      batch.material!.atlasTexture = this._atlas.getAtlasTexture(pageIndex) ?? null;
      batch.material!.textColor = this._color;
      batch.material!.distanceRange = this._atlas.distanceRange;
      batch.material!.outlineWidth = this._outlineWidth;
      batch.material!.outlineColor = this._outlineColor;
    }
    this.disposePageBatches(pageIndices.length);
    this.setBoundingVolume(bv);
  }
  isMSDFText(): this is MSDFText {
    return true;
  }
  protected onDispose() {
    this._atlas = null;
    this.disposePageBatches();
    super.onDispose();
  }
  private ensurePageBatch(index: number) {
    let batch = this._pageBatches[index];
    if (!batch) {
      batch = new MeshDrawable(this, new MSDFTextMaterial(), new Primitive());
      this._pageBatches[index] = batch;
    }
    return batch;
  }
  private disposePageBatches(fromIndex = 0) {
    for (let i = this._pageBatches.length - 1; i >= fromIndex; i--) {
      this._pageBatches[i].dispose();
      this._pageBatches.splice(i, 1);
    }
  }
}

function buildPagedSpriteGeometry(
  layout: TextLayoutResult,
  unitsPerEm: number,
  ascent: number,
  fontSize: number,
  anchor: Immutable<Vector2>,
  textAlign: TextAlign,
  bv: AABB
) {
  const scale = fontSize / unitsPerEm;
  const top = ascent * scale;
  const bottom = top - layout.height;
  const anchorOffsetX = layout.boxWidth * anchor.x;
  const anchorOffsetY = bottom + layout.height * anchor.y;
  const lineOffsets = layout.lines.map((line) => {
    const gap = Math.max(layout.boxWidth - line.width, 0);
    switch (textAlign) {
      case 'center':
        return gap * 0.5;
      case 'right':
        return gap;
      default:
        return 0;
    }
  });
  let minX = -anchorOffsetX;
  let maxX = layout.boxWidth - anchorOffsetX;
  let minY = bottom - anchorOffsetY;
  let maxY = top - anchorOffsetY;
  const pageGlyphs = new Map<number, TextLayoutResult['glyphs']>();
  for (const glyph of layout.glyphs) {
    let list = pageGlyphs.get(glyph.atlasGlyph.atlasIndex);
    if (!list) {
      list = [];
      pageGlyphs.set(glyph.atlasGlyph.atlasIndex, list);
    }
    list.push(glyph);
  }
  const pages = new Map<
    number,
    { positions: Float32Array; uvs: Float32Array; indices: Uint16Array | Uint32Array }
  >();
  for (const [atlasIndex, glyphs] of pageGlyphs) {
    const glyphCount = glyphs.length;
    const positions = new Float32Array(glyphCount * 4 * 3);
    const uvs = new Float32Array(glyphCount * 4 * 2);
    const indices =
      glyphCount * 4 > 65535 ? new Uint32Array(glyphCount * 6) : new Uint16Array(glyphCount * 6);
    for (let i = 0; i < glyphCount; i++) {
      const glyph = glyphs[i];
      const atlasGlyph = glyph.atlasGlyph;
      const lineOffsetX = lineOffsets[glyph.lineIndex] ?? 0;
      const x0 = lineOffsetX + glyph.x + glyph.xOffset + atlasGlyph.planeLeft * scale - anchorOffsetX;
      const y0 = -glyph.y + atlasGlyph.planeTop * scale - anchorOffsetY;
      const x1 = lineOffsetX + glyph.x + glyph.xOffset + atlasGlyph.planeRight * scale - anchorOffsetX;
      const y1 = -glyph.y + atlasGlyph.planeBottom * scale - anchorOffsetY;
      minX = Math.min(minX, x0, x1);
      maxX = Math.max(maxX, x0, x1);
      minY = Math.min(minY, y0, y1);
      maxY = Math.max(maxY, y0, y1);
      const p = i * 12;
      positions[p + 0] = x0;
      positions[p + 1] = y0;
      positions[p + 2] = 0;
      positions[p + 3] = x1;
      positions[p + 4] = y0;
      positions[p + 5] = 0;
      positions[p + 6] = x0;
      positions[p + 7] = y1;
      positions[p + 8] = 0;
      positions[p + 9] = x1;
      positions[p + 10] = y1;
      positions[p + 11] = 0;
      for (let k = 0; k < 4; k++) {
        bv.extend3(positions[p + k * 3], positions[p + k * 3 + 1], positions[p + k * 3 + 2]);
      }
      const t = i * 8;
      uvs[t + 0] = atlasGlyph.uMin;
      uvs[t + 1] = atlasGlyph.vMin;
      uvs[t + 2] = atlasGlyph.uMax;
      uvs[t + 3] = atlasGlyph.vMin;
      uvs[t + 4] = atlasGlyph.uMin;
      uvs[t + 5] = atlasGlyph.vMax;
      uvs[t + 6] = atlasGlyph.uMax;
      uvs[t + 7] = atlasGlyph.vMax;
      const baseVertex = i * 4;
      const indexOffset = i * 6;
      indices[indexOffset + 0] = baseVertex + 0;
      indices[indexOffset + 1] = baseVertex + 1;
      indices[indexOffset + 2] = baseVertex + 2;
      indices[indexOffset + 3] = baseVertex + 2;
      indices[indexOffset + 4] = baseVertex + 1;
      indices[indexOffset + 5] = baseVertex + 3;
    }
    pages.set(atlasIndex, { positions, uvs, indices });
  }
  return {
    pages,
    bounds: {
      minX,
      minY,
      maxX,
      maxY
    }
  };
}

function updatePrimitiveGeometry(
  primitive: Primitive,
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array | Uint32Array
) {
  primitive.removeVertexBuffer('position');
  primitive.removeVertexBuffer('texCoord0');
  primitive.setIndexBuffer(null);
  primitive.createAndSetVertexBuffer('position_f32x3', positions as Float32Array<ArrayBuffer>);
  primitive.createAndSetVertexBuffer('tex0_f32x2', uvs as Float32Array<ArrayBuffer>);
  primitive.createAndSetIndexBuffer(indices as Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>);
  primitive.indexCount = indices.length;
}
