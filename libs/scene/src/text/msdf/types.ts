import type { GlyphContour } from '../font';

/**
 * Signed distance field generation options.
 *
 * @public
 */
export type MSDFOptions = {
  width: number;
  height: number;
  range: number;
  padding?: number;
};

/**
 * RGB MSDF bitmap and placement information.
 *
 * @public
 */
export type MSDFBitmap = {
  width: number;
  height: number;
  pixels: Uint8Array<ArrayBuffer>;
  scale: number;
  translateX: number;
  translateY: number;
};

/**
 * Colored line edge used for MSDF generation.
 *
 * @public
 */
export type ColoredLineEdge = {
  kind: 'line';
  color: 0 | 1 | 2;
  p0: { x: number; y: number };
  p1: { x: number; y: number };
};

/**
 * Colored quadratic edge used for MSDF generation.
 *
 * @public
 */
export type ColoredQuadraticEdge = {
  kind: 'quadratic';
  color: 0 | 1 | 2;
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  p2: { x: number; y: number };
};

/**
 * Colored edge used for MSDF generation.
 *
 * @public
 */
export type ColoredEdge = ColoredLineEdge | ColoredQuadraticEdge;

/**
 * Converted glyph shape ready for MSDF sampling.
 *
 * @public
 */
export type MSDFShape = {
  contours: ColoredEdge[][];
  sourceContours: GlyphContour[];
};
