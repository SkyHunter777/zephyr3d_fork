import { splitStringByGraphemes } from '@zephyr3d/base';
import type { FontAsset } from '../font';
import type { MSDFGlyphAtlas, MSDFGlyphInfo } from './msdf_glyph_atlas';

export type TextAlign = 'left' | 'center' | 'right';

export type LayoutGlyph = {
  char: string;
  glyphIndex: number;
  atlasGlyph: MSDFGlyphInfo;
  lineIndex: number;
  x: number;
  y: number;
  xOffset: number;
  advance: number;
};

export type TextLayoutLine = {
  width: number;
  glyphStart: number;
  glyphEnd: number;
};

export type TextLayoutResult = {
  glyphs: LayoutGlyph[];
  width: number;
  boxWidth: number;
  height: number;
  lineHeight: number;
  lines: TextLayoutLine[];
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
  const lines: TextLayoutLine[] = [];
  let x = 0;
  let y = 0;
  let maxLineWidth = 0;
  let prevGlyphIndex = 0;
  let lineIndex = 0;
  let lineStartGlyph = 0;
  const chars = splitStringByGraphemes(text);
  for (const ch of chars) {
    if (ch === '\n') {
      maxLineWidth = Math.max(maxLineWidth, x);
      lines.push({
        width: x,
        glyphStart: lineStartGlyph,
        glyphEnd: glyphs.length
      });
      x = 0;
      y += lineHeight;
      prevGlyphIndex = 0;
      lineIndex++;
      lineStartGlyph = glyphs.length;
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
      lines.push({
        width: x,
        glyphStart: lineStartGlyph,
        glyphEnd: glyphs.length
      });
      x = 0;
      y += lineHeight;
      prevGlyphIndex = 0;
      lineIndex++;
      lineStartGlyph = glyphs.length;
    } else {
      x += kerning;
    }
    if (atlasGlyph) {
      glyphs.push({
        char: ch,
        glyphIndex,
        atlasGlyph,
        lineIndex,
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
  lines.push({
    width: x,
    glyphStart: lineStartGlyph,
    glyphEnd: glyphs.length
  });
  return {
    glyphs,
    width: maxLineWidth,
    boxWidth: maxWidth > 0 ? Math.max(maxLineWidth, maxWidth) : maxLineWidth,
    height: Math.max(lineHeight, y + lineHeight),
    lineHeight,
    lines
  } satisfies TextLayoutResult;
}
