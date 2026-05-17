import { clamp } from '@zephyr3d/base';
import type { GlyphData } from '../font';
import { buildMSDFShape } from './shape';
import type { ColoredEdge, MSDFBitmap, MSDFOptions } from './types';

const DEFAULT_PADDING = 1;

/**
 * Generate a minimal RGB MSDF bitmap from a parsed glyph.
 *
 * @public
 */
export function generateMSDF(glyph: GlyphData, options: MSDFOptions): MSDFBitmap {
  const shape = buildMSDFShape(glyph.contours);
  const useMonochromeSDF = !hasCompleteMSDFColoring(shape.contours);
  const width = Math.max(1, options.width | 0);
  const height = Math.max(1, options.height | 0);
  const padding = options.padding ?? DEFAULT_PADDING;
  const boundsWidth = Math.max(1, glyph.xMax - glyph.xMin);
  const boundsHeight = Math.max(1, glyph.yMax - glyph.yMin);
  const drawableWidth = Math.max(1, width - padding * 2);
  const drawableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(drawableWidth / boundsWidth, drawableHeight / boundsHeight);
  const placedWidth = boundsWidth * scale;
  const placedHeight = boundsHeight * scale;
  const translateX = padding + (drawableWidth - placedWidth) * 0.5 - glyph.xMin * scale;
  const translateY = padding + (drawableHeight - placedHeight) * 0.5 + glyph.yMax * scale;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5 - translateX) / scale;
      const sourceY = -(y + 0.5 - translateY) / scale;
      const inside = pointInShape(sourceX, sourceY, shape.contours);
      const signedDistance = computeSignedDistance(sourceX, sourceY, shape.contours, inside);
      const r = useMonochromeSDF
        ? signedDistance
        : computeChannelDistance(sourceX, sourceY, shape.contours, 0, inside);
      const g = useMonochromeSDF
        ? signedDistance
        : computeChannelDistance(sourceX, sourceY, shape.contours, 1, inside);
      const b = useMonochromeSDF
        ? signedDistance
        : computeChannelDistance(sourceX, sourceY, shape.contours, 2, inside);
      const base = (y * width + x) * 4;
      pixels[base + 0] = encodeDistance(r, options.range);
      pixels[base + 1] = encodeDistance(g, options.range);
      pixels[base + 2] = encodeDistance(b, options.range);
      pixels[base + 3] = encodeDistance(signedDistance, options.range);
    }
  }
  return {
    width,
    height,
    pixels,
    scale,
    translateX,
    translateY
  };
}

function encodeDistance(distance: number, range: number) {
  return Math.round(clamp(0.5 + distance / (2 * Math.max(range, 1e-6)), 0, 1) * 255);
}

function computeSignedDistance(x: number, y: number, contours: ColoredEdge[][], inside: boolean) {
  let minDistance = Number.POSITIVE_INFINITY;
  for (const contour of contours) {
    for (const edge of contour) {
      const dist = edgeDistance(edge, x, y);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }
  }
  return inside ? minDistance : -minDistance;
}

function computeChannelDistance(
  x: number,
  y: number,
  contours: ColoredEdge[][],
  color: 0 | 1 | 2,
  inside: boolean
) {
  let minDistance = Number.POSITIVE_INFINITY;
  let closestSigned = 0;
  for (const contour of contours) {
    for (const edge of contour) {
      if (edge.color !== color) {
        continue;
      }
      const dist = edgeDistance(edge, x, y);
      if (dist < minDistance) {
        minDistance = dist;
        closestSigned = inside ? dist : -dist;
      }
    }
  }
  if (!Number.isFinite(minDistance)) {
    return 0;
  }
  return closestSigned;
}

function hasCompleteMSDFColoring(contours: ColoredEdge[][]) {
  const used = [false, false, false];
  for (const contour of contours) {
    for (const edge of contour) {
      used[edge.color] = true;
    }
  }
  return used[0] && used[1] && used[2];
}

function pointInShape(x: number, y: number, contours: ColoredEdge[][]) {
  let winding = 0;
  for (const contour of contours) {
    winding += contourWinding(x, y, contour);
  }
  return winding !== 0;
}

function edgeDistance(edge: ColoredEdge, x: number, y: number) {
  if (edge.kind === 'line') {
    return distanceToLineSegment(edge.p0.x, edge.p0.y, edge.p1.x, edge.p1.y, x, y);
  }
  return distanceToQuadratic(edge, x, y);
}

function distanceToLineSegment(x0: number, y0: number, x1: number, y1: number, px: number, py: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    return Math.hypot(px - x0, py - y0);
  }
  const t = clamp(((px - x0) * dx + (py - y0) * dy) / lenSq, 0, 1);
  const cx = x0 + dx * t;
  const cy = y0 + dy * t;
  return Math.hypot(px - cx, py - cy);
}

function distanceToQuadratic(edge: Extract<ColoredEdge, { kind: 'quadratic' }>, px: number, py: number) {
  let minDistance = Number.POSITIVE_INFINITY;
  const steps = 24;
  let prevX = edge.p0.x;
  let prevY = edge.p0.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * edge.p0.x + 2 * mt * t * edge.p1.x + t * t * edge.p2.x;
    const y = mt * mt * edge.p0.y + 2 * mt * t * edge.p1.y + t * t * edge.p2.y;
    minDistance = Math.min(minDistance, distanceToLineSegment(prevX, prevY, x, y, px, py));
    prevX = x;
    prevY = y;
  }
  return minDistance;
}

function contourWinding(x: number, y: number, contour: ColoredEdge[]) {
  let winding = 0;
  for (const edge of contour) {
    if (edge.kind === 'line') {
      winding += windingContribution(x, y, edge.p0.x, edge.p0.y, edge.p1.x, edge.p1.y);
    } else {
      let prevX = edge.p0.x;
      let prevY = edge.p0.y;
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const cx = mt * mt * edge.p0.x + 2 * mt * t * edge.p1.x + t * t * edge.p2.x;
        const cy = mt * mt * edge.p0.y + 2 * mt * t * edge.p1.y + t * t * edge.p2.y;
        winding += windingContribution(x, y, prevX, prevY, cx, cy);
        prevX = cx;
        prevY = cy;
      }
    }
  }
  return winding;
}

function windingContribution(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  if (y0 <= py) {
    if (y1 > py && cross(x1 - x0, y1 - y0, px - x0, py - y0) > 0) {
      return 1;
    }
  } else if (y1 <= py && cross(x1 - x0, y1 - y0, px - x0, py - y0) < 0) {
    return -1;
  }
  return 0;
}

function cross(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx;
}
