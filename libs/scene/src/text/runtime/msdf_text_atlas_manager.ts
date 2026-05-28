import { getDevice } from '../../app/api';
import type { FontAsset } from '../font';
import { MSDFGlyphAtlas } from './msdf_glyph_atlas';

const DEFAULT_DISTANCE_RANGE = 8;
const DEFAULT_PADDING = 6;

/**
 * Manages MSDF glyph atlases for font assets.
 * @public
 */
export class MSDFTextAtlasManager {
  private readonly _atlases: Map<FontAsset, MSDFGlyphAtlas>;
  constructor() {
    this._atlases = new Map();
  }
  getAtlas(font: FontAsset) {
    let atlas = this._atlases.get(font);
    if (!atlas) {
      atlas = new MSDFGlyphAtlas(
        getDevice(),
        font,
        font.msdfGlyphSize,
        font.msdfAtlasPageSize,
        DEFAULT_DISTANCE_RANGE,
        DEFAULT_PADDING
      );
      this._atlases.set(font, atlas);
    }
    return atlas;
  }
  configureAtlas(
    font: FontAsset,
    glyphSize: number,
    atlasSize: number,
    distanceRange = DEFAULT_DISTANCE_RANGE,
    padding = DEFAULT_PADDING
  ) {
    let atlas = this._atlases.get(font);
    if (atlas) {
      atlas.clear();
      this._atlases.delete(font);
    }
    atlas = new MSDFGlyphAtlas(getDevice(), font, glyphSize, atlasSize, distanceRange, padding);
    this._atlases.set(font, atlas);
    return atlas;
  }
  releaseAtlas(font: FontAsset) {
    const atlas = this._atlases.get(font);
    if (atlas) {
      atlas.clear();
      this._atlases.delete(font);
      return true;
    }
    return false;
  }
  clear() {
    for (const atlas of this._atlases.values()) {
      atlas.clear();
    }
    this._atlases.clear();
  }
}
