import type { Scene } from './scene';
import { Mesh } from './mesh';
import { BoundingBox } from '../utility/bounding_volume';
import { Primitive } from '../render';
import { MSDFTextMaterial } from '../material/msdf_text';
import { type Immutable, Vector3 } from '@zephyr3d/base';
import type { FontAsset } from '../text/font';
import { MSDFGlyphAtlas, layoutText, type TextLayoutResult } from '../text/runtime';
import { getDevice } from '../app/api';

/**
 * Atlas-based runtime MSDF text mesh.
 *
 * @public
 */
export class MSDFText extends Mesh {
  private _fontAsset: FontAsset | null;
  private _atlas: MSDFGlyphAtlas | null;
  private _text: string;
  private _fontSize: number;
  private _maxWidth: number;
  private _color: Vector3;
  constructor(scene: Scene) {
    super(scene, new Primitive(), new MSDFTextMaterial());
    this._fontAsset = null;
    this._atlas = null;
    this._text = '';
    this._fontSize = 32;
    this._maxWidth = 0;
    this._color = new Vector3(1, 1, 1);
    this.material.textColor = this._color;
    this.scene!.queueUpdateNode(this);
  }
  get material() {
    return super.material as MSDFTextMaterial;
  }
  set material(m) {
    super.material = m;
  }
  get fontAsset() {
    return this._fontAsset;
  }
  set fontAsset(font: FontAsset | null) {
    if (this._fontAsset !== font) {
      this._fontAsset = font;
      this._atlas = font ? new MSDFGlyphAtlas(getDevice(), font) : null;
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
  get textColor(): Immutable<Vector3> {
    return this._color;
  }
  set textColor(value: Immutable<Vector3>) {
    if (!this._color.equalsTo(value)) {
      this._color.set(value);
      this.material.textColor = value;
    }
  }
  update(): void {
    const primitive = this.primitive ?? new Primitive();
    if (!this.primitive) {
      this.primitive = primitive;
    }
    primitive.removeVertexBuffer('position');
    primitive.removeVertexBuffer('texCoord0');
    primitive.setIndexBuffer(null);
    if (!this._fontAsset || !this._atlas || !this._text) {
      primitive.indexCount = 0;
      primitive.setBoundingVolume(new BoundingBox());
      this.material.atlasTexture = null;
      return;
    }
    const layout = layoutText(this._atlas, this._fontAsset, this._text, this._fontSize, this._maxWidth);
    const geometry = buildGeometry(layout, this._fontAsset.metrics.unitsPerEm, this._fontSize);
    primitive.createAndSetVertexBuffer('position_f32x3', geometry.positions);
    primitive.createAndSetVertexBuffer('tex0_f32x2', geometry.uvs);
    primitive.createAndSetIndexBuffer(geometry.indices);
    primitive.setBoundingVolume(
      new BoundingBox(new Vector3(0, -layout.height, 0), new Vector3(layout.width, layout.lineHeight, 0))
    );
    primitive.indexCount = geometry.indices.length;
    this.material.atlasTexture = this._atlas.getAtlasTexture(0) ?? null;
    this.material.textColor = this._color;
    this.material.distanceRange = this._atlas.distanceRange;
  }
}

function buildGeometry(layout: TextLayoutResult, unitsPerEm: number, fontSize: number) {
  const scale = fontSize / unitsPerEm;
  const glyphCount = layout.glyphs.length;
  const positions = new Float32Array(glyphCount * 4 * 3);
  const uvs = new Float32Array(glyphCount * 4 * 2);
  const indices = new Uint16Array(glyphCount * 6);
  for (let i = 0; i < glyphCount; i++) {
    const glyph = layout.glyphs[i];
    const atlasGlyph = glyph.atlasGlyph;
    const x0 = glyph.x + glyph.xOffset + atlasGlyph.planeLeft * scale;
    const y0 = -glyph.y + atlasGlyph.planeTop * scale;
    const x1 = glyph.x + glyph.xOffset + atlasGlyph.planeRight * scale;
    const y1 = -glyph.y + atlasGlyph.planeBottom * scale;
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
  return { positions, uvs, indices };
}
