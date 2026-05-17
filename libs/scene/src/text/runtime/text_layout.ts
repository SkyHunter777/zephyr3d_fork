import { splitStringByGraphemes } from '@zephyr3d/base';
import type { FontAsset } from '../font';
import type { MSDFGlyphAtlas, MSDFGlyphInfo } from './msdf_glyph_atlas';

export type LayoutGlyph = {
  char: string;
  glyphIndex: number;
  atlasGlyph: MSDFGlyphInfo;
  x: number;
  y: number;
  xOffset: number;
  advance: number;
};

export type TextLayoutResult = {
  glyphs: LayoutGlyph[];
  width: number;
  height: number;
  lineHeight: number;
};

export function layoutText(
  atlas: MSDFGlyphAtlas,
  font: FontAsset,
  text: string,
  fontSize: number,
  maxWidth = 0
) {
  const scale = fontSize / font.metrics.unitsPerEm;
  const lineHeight = (font.metrics.ascent - font.metrics.descent + font.metrics.lineGap) * scale;
  const glyphs: LayoutGlyph[] = [];
  let x = 0;
  let y = 0;
  let maxLineWidth = 0;
  let prevGlyphIndex = 0;
  const chars = splitStringByGraphemes(text);
  for (const ch of chars) {
    if (ch === '\n') {
      maxLineWidth = Math.max(maxLineWidth, x);
      x = 0;
      y += lineHeight;
      prevGlyphIndex = 0;
      continue;
    }
    const codePoint = ch.codePointAt(0);
    if (typeof codePoint !== 'number') {
      continue;
    }
    const glyphIndex = font.getGlyphIndex(codePoint);
    if (glyphIndex === 0) {
      prevGlyphIndex = 0;
      continue;
    }
    const glyph = font.getGlyph(glyphIndex);
    if (!glyph) {
      prevGlyphIndex = 0;
      continue;
    }
    const atlasGlyph = atlas.ensureGlyph(glyphIndex);
    const pairAdjustment = prevGlyphIndex ? font.getPairAdjustment(prevGlyphIndex, glyphIndex) : null;
    const kerning = prevGlyphIndex ? font.getKerning(prevGlyphIndex, glyphIndex) * scale : 0;
    const xOffset = pairAdjustment ? pairAdjustment.secondXPlacement * scale : 0;
    const advance = glyph.advanceWidth * scale;
    if (maxWidth > 0 && x > 0 && x + kerning + advance > maxWidth) {
      maxLineWidth = Math.max(maxLineWidth, x);
      x = 0;
      y += lineHeight;
      prevGlyphIndex = 0;
    } else {
      x += kerning;
    }
    if (atlasGlyph) {
      glyphs.push({
        char: ch,
        glyphIndex,
        atlasGlyph,
        x,
        y,
        xOffset,
        advance
      });
    }
    x += advance;
    prevGlyphIndex = glyphIndex;
  }
  maxLineWidth = Math.max(maxLineWidth, x);
  return {
    glyphs,
    width: maxLineWidth,
    height: Math.max(lineHeight, y + lineHeight),
    lineHeight
  } satisfies TextLayoutResult;
}
