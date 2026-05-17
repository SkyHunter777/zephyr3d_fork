/**
 * Font outline point.
 *
 * @public
 */
export type GlyphPoint = {
  x: number;
  y: number;
  onCurve: boolean;
};

/**
 * Glyph contour represented by ordered quadratic points.
 *
 * @public
 */
export type GlyphContour = GlyphPoint[];

/**
 * Parsed glyph outline and metrics.
 *
 * @public
 */
export type GlyphData = {
  glyphIndex: number;
  advanceWidth: number;
  leftSideBearing: number;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  contours: GlyphContour[];
};

/**
 * Minimal font metrics required by runtime text layout.
 *
 * @public
 */
export type FontMetrics = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  glyphCount: number;
};
