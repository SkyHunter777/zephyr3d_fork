import { clamp } from '@zephyr3d/base';
import type { GlyphData } from '../font';
import { buildMSDFShape } from './shape';
import type { ColoredEdge, MSDFBitmap, MSDFOptions } from './types';

const DEFAULT_PADDING = 1;
const CHANNEL_MASKS = [1, 2, 4] as const;
const EPSILON = 1e-8;
const CONTOUR_PROBE_DISTANCES = [1, 4, 16] as const;

type DistanceSample = {
  distance: number;
  absDistance: number;
  dot: number;
};

/**
 * Generate a runtime RGB(A) distance field bitmap from a parsed glyph.
 *
 * Distances are encoded in output texel units, which matches the shader-side
 * `distanceRange` logic and keeps the field scale-invariant across font sizes.
 *
 * @public
 */
export function generateMSDF(glyph: GlyphData, options: MSDFOptions): MSDFBitmap {
  const shape = buildMSDFShape(glyph.contours);
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
  const contourInsideSigns = shape.contours.map((contour) =>
    determineContourInsideSign(contour, shape.contours)
  );
  const fields = new Float32Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5 - translateX) / scale;
      const sourceY = -(y + 0.5 - translateY) / scale;
      const inside = pointInShape(sourceX, sourceY, shape.contours);
      let minDistance = Number.POSITIVE_INFINITY;
      const channelSamples: [DistanceSample | null, DistanceSample | null, DistanceSample | null] = [
        null,
        null,
        null
      ];
      for (let contourIndex = 0; contourIndex < shape.contours.length; contourIndex++) {
        const contour = shape.contours[contourIndex];
        const insideSign = contourInsideSigns[contourIndex];
        for (const edge of contour) {
          const sample = sampleEdge(edge, sourceX, sourceY, insideSign);
          if (sample.absDistance < minDistance) {
            minDistance = sample.absDistance;
          }
          for (let channelIndex = 0; channelIndex < CHANNEL_MASKS.length; channelIndex++) {
            if (
              (edge.color & CHANNEL_MASKS[channelIndex]) !== 0 &&
              betterSample(sample, channelSamples[channelIndex])
            ) {
              channelSamples[channelIndex] = sample;
            }
          }
        }
      }
      if (!Number.isFinite(minDistance)) {
        minDistance = 0;
      }
      const sdfDistance = (inside ? minDistance : -minDistance) * scale;
      const base = (y * width + x) * 4;
      fields[base + 0] = (channelSamples[0]?.distance ?? (inside ? minDistance : -minDistance)) * scale;
      fields[base + 1] = (channelSamples[1]?.distance ?? (inside ? minDistance : -minDistance)) * scale;
      fields[base + 2] = (channelSamples[2]?.distance ?? (inside ? minDistance : -minDistance)) * scale;
      fields[base + 3] = sdfDistance;
    }
  }

  applyMedianCorrection(fields, width, height, options.range);

  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const base = i * 4;
    pixels[base + 0] = encodeDistance(fields[base + 0], options.range);
    pixels[base + 1] = encodeDistance(fields[base + 1], options.range);
    pixels[base + 2] = encodeDistance(fields[base + 2], options.range);
    pixels[base + 3] = encodeDistance(fields[base + 3], options.range);
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

function betterSample(next: DistanceSample, current: DistanceSample | null) {
  return (
    !current ||
    next.absDistance < current.absDistance - 1e-6 ||
    (Math.abs(next.absDistance - current.absDistance) <= 1e-6 && next.dot < current.dot)
  );
}

function sampleEdge(edge: ColoredEdge, x: number, y: number, insideSign: number): DistanceSample {
  return edge.kind === 'line'
    ? sampleLineEdge(edge, x, y, insideSign)
    : sampleQuadraticEdge(edge, x, y, insideSign);
}

function sampleLineEdge(
  edge: Extract<ColoredEdge, { kind: 'line' }>,
  x: number,
  y: number,
  insideSign: number
) {
  const dx = edge.p1.x - edge.p0.x;
  const dy = edge.p1.y - edge.p0.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= EPSILON) {
    return sampleEndpoint(edge.p0.x, edge.p0.y, 1, 0, x, y, insideSign);
  }
  const qx = x - edge.p0.x;
  const qy = y - edge.p0.y;
  const t = (qx * dx + qy * dy) / lenSq;
  if (t <= 0) {
    return sampleEndpoint(edge.p0.x, edge.p0.y, dx, dy, x, y, insideSign);
  }
  if (t >= 1) {
    return sampleEndpoint(edge.p1.x, edge.p1.y, dx, dy, x, y, insideSign);
  }
  const cx = edge.p0.x + dx * t;
  const cy = edge.p0.y + dy * t;
  const deltaX = x - cx;
  const deltaY = y - cy;
  const absDistance = Math.hypot(deltaX, deltaY);
  return {
    distance: signedPerpendicularDistance(dx, dy, deltaX, deltaY, insideSign),
    absDistance,
    dot: directionDot(deltaX, deltaY, dx, dy, absDistance)
  };
}

function sampleQuadraticEdge(
  edge: Extract<ColoredEdge, { kind: 'quadratic' }>,
  x: number,
  y: number,
  insideSign: number
) {
  const t = findNearestQuadraticParameter(edge, x, y);
  if (t <= EPSILON) {
    const tangent = quadraticEndpointTangent(edge, true);
    return sampleEndpoint(edge.p0.x, edge.p0.y, tangent.x, tangent.y, x, y, insideSign);
  }
  if (t >= 1 - EPSILON) {
    const tangent = quadraticEndpointTangent(edge, false);
    return sampleEndpoint(edge.p2.x, edge.p2.y, tangent.x, tangent.y, x, y, insideSign);
  }
  const point = evaluateQuadratic(edge, t);
  const tangent = quadraticTangent(edge, t);
  const deltaX = x - point.x;
  const deltaY = y - point.y;
  const absDistance = Math.hypot(deltaX, deltaY);
  return {
    distance: signedPerpendicularDistance(tangent.x, tangent.y, deltaX, deltaY, insideSign),
    absDistance,
    dot: directionDot(deltaX, deltaY, tangent.x, tangent.y, absDistance)
  };
}

function sampleEndpoint(
  px: number,
  py: number,
  tx: number,
  ty: number,
  x: number,
  y: number,
  insideSign: number
): DistanceSample {
  const deltaX = x - px;
  const deltaY = y - py;
  const absDistance = Math.hypot(deltaX, deltaY);
  return {
    distance: signedPerpendicularDistance(tx, ty, deltaX, deltaY, insideSign),
    absDistance,
    dot: directionDot(deltaX, deltaY, tx, ty, absDistance)
  };
}

function signedPerpendicularDistance(tx: number, ty: number, dx: number, dy: number, insideSign: number) {
  const tangentLength = Math.hypot(tx, ty);
  if (tangentLength <= EPSILON) {
    return 0;
  }
  return (insideSign * cross(tx, ty, dx, dy)) / tangentLength;
}

function directionDot(dx: number, dy: number, tx: number, ty: number, absDistance: number) {
  const tangentLength = Math.hypot(tx, ty);
  if (absDistance <= EPSILON || tangentLength <= EPSILON) {
    return 0;
  }
  return Math.abs((dx * tx + dy * ty) / (absDistance * tangentLength));
}

function findNearestQuadraticParameter(
  edge: Extract<ColoredEdge, { kind: 'quadratic' }>,
  x: number,
  y: number
) {
  const ax = edge.p0.x - 2 * edge.p1.x + edge.p2.x;
  const ay = edge.p0.y - 2 * edge.p1.y + edge.p2.y;
  const bx = 2 * (edge.p1.x - edge.p0.x);
  const by = 2 * (edge.p1.y - edge.p0.y);
  const cx = edge.p0.x - x;
  const cy = edge.p0.y - y;
  const roots = solveCubic(
    2 * dot(ax, ay, ax, ay),
    3 * dot(ax, ay, bx, by),
    dot(bx, by, bx, by) + 2 * dot(ax, ay, cx, cy),
    dot(bx, by, cx, cy)
  );
  let nearestT = 0;
  let minDistanceSq = Number.POSITIVE_INFINITY;
  for (const candidate of [0, ...roots, 1]) {
    const t = clamp(candidate, 0, 1);
    const point = evaluateQuadratic(edge, t);
    const distX = x - point.x;
    const distY = y - point.y;
    const distanceSq = distX * distX + distY * distY;
    if (distanceSq < minDistanceSq - 1e-6) {
      minDistanceSq = distanceSq;
      nearestT = t;
    }
  }
  return nearestT;
}

function evaluateQuadratic(edge: Extract<ColoredEdge, { kind: 'quadratic' }>, t: number) {
  const mt = 1 - t;
  return {
    x: mt * mt * edge.p0.x + 2 * mt * t * edge.p1.x + t * t * edge.p2.x,
    y: mt * mt * edge.p0.y + 2 * mt * t * edge.p1.y + t * t * edge.p2.y
  };
}

function quadraticTangent(edge: Extract<ColoredEdge, { kind: 'quadratic' }>, t: number) {
  const x = 2 * ((1 - t) * (edge.p1.x - edge.p0.x) + t * (edge.p2.x - edge.p1.x));
  const y = 2 * ((1 - t) * (edge.p1.y - edge.p0.y) + t * (edge.p2.y - edge.p1.y));
  if (Math.hypot(x, y) > EPSILON) {
    return { x, y };
  }
  return quadraticEndpointTangent(edge, t < 0.5);
}

function quadraticEndpointTangent(edge: Extract<ColoredEdge, { kind: 'quadratic' }>, atStart: boolean) {
  const tx = atStart ? edge.p1.x - edge.p0.x : edge.p2.x - edge.p1.x;
  const ty = atStart ? edge.p1.y - edge.p0.y : edge.p2.y - edge.p1.y;
  if (Math.hypot(tx, ty) > EPSILON) {
    return { x: tx, y: ty };
  }
  const fallbackX = edge.p2.x - edge.p0.x;
  const fallbackY = edge.p2.y - edge.p0.y;
  if (Math.hypot(fallbackX, fallbackY) > EPSILON) {
    return { x: fallbackX, y: fallbackY };
  }
  return { x: 1, y: 0 };
}

function solveCubic(a: number, b: number, c: number, d: number): number[] {
  if (Math.abs(a) <= EPSILON) {
    return solveQuadratic(b, c, d);
  }
  const invA = 1 / a;
  const B = b * invA;
  const C = c * invA;
  const D = d * invA;
  const p = C - (B * B) / 3;
  const q = (2 * B * B * B) / 27 - (B * C) / 3 + D;
  const disc = (q * q) / 4 + (p * p * p) / 27;
  const shift = -B / 3;
  if (disc > EPSILON) {
    const sqrtDisc = Math.sqrt(disc);
    return [Math.cbrt(-q / 2 + sqrtDisc) + Math.cbrt(-q / 2 - sqrtDisc) + shift];
  }
  if (disc < -EPSILON) {
    const acosArg = clamp(-q / 2 / Math.sqrt((-p * p * p) / 27), -1, 1);
    const theta = Math.acos(acosArg);
    const rho = 2 * Math.sqrt(-p / 3);
    return dedupeRoots([
      rho * Math.cos(theta / 3) + shift,
      rho * Math.cos((theta + 2 * Math.PI) / 3) + shift,
      rho * Math.cos((theta + 4 * Math.PI) / 3) + shift
    ]);
  }
  const u = Math.cbrt(-q / 2);
  return dedupeRoots([2 * u + shift, -u + shift]);
}

function solveQuadratic(a: number, b: number, c: number): number[] {
  if (Math.abs(a) <= EPSILON) {
    return Math.abs(b) <= EPSILON ? [] : [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < -EPSILON) {
    return [];
  }
  if (Math.abs(disc) <= EPSILON) {
    return [-b / (2 * a)];
  }
  const sqrtDisc = Math.sqrt(Math.max(disc, 0));
  return dedupeRoots([(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)]);
}

function dedupeRoots(values: number[]) {
  const roots: number[] = [];
  for (const value of values) {
    if (!roots.some((root) => Math.abs(root - value) <= 1e-7)) {
      roots.push(value);
    }
  }
  return roots;
}

function determineContourInsideSign(contour: ColoredEdge[], allContours: ColoredEdge[][]) {
  for (const edge of contour) {
    const probe = edgeProbe(edge);
    const tangentLength = Math.hypot(probe.tangent.x, probe.tangent.y);
    if (tangentLength <= EPSILON) {
      continue;
    }
    const normalX = -probe.tangent.y / tangentLength;
    const normalY = probe.tangent.x / tangentLength;
    for (const distance of CONTOUR_PROBE_DISTANCES) {
      const leftInside = pointInShape(
        probe.point.x + normalX * distance,
        probe.point.y + normalY * distance,
        allContours
      );
      const rightInside = pointInShape(
        probe.point.x - normalX * distance,
        probe.point.y - normalY * distance,
        allContours
      );
      if (leftInside !== rightInside) {
        return leftInside ? 1 : -1;
      }
    }
  }
  return approximateContourSign(contour);
}

function edgeProbe(edge: ColoredEdge) {
  if (edge.kind === 'line') {
    return {
      point: {
        x: (edge.p0.x + edge.p1.x) * 0.5,
        y: (edge.p0.y + edge.p1.y) * 0.5
      },
      tangent: {
        x: edge.p1.x - edge.p0.x,
        y: edge.p1.y - edge.p0.y
      }
    };
  }
  return {
    point: evaluateQuadratic(edge, 0.5),
    tangent: quadraticTangent(edge, 0.5)
  };
}

function approximateContourSign(contour: ColoredEdge[]) {
  let area = 0;
  for (const edge of contour) {
    if (edge.kind === 'line') {
      area += cross(edge.p0.x, edge.p0.y, edge.p1.x, edge.p1.y);
    } else {
      area += cross(edge.p0.x, edge.p0.y, edge.p1.x, edge.p1.y);
      area += cross(edge.p1.x, edge.p1.y, edge.p2.x, edge.p2.y);
    }
  }
  return area >= 0 ? 1 : -1;
}

function applyMedianCorrection(fields: Float32Array, width: number, height: number, range: number) {
  const correctionThreshold = 1;
  const edgeThreshold = Math.max(range + 1, 1);
  for (let i = 0; i < width * height; i++) {
    const base = i * 4;
    const median = median3(fields[base + 0], fields[base + 1], fields[base + 2]);
    const sdf = fields[base + 3];
    if (Math.abs(sdf) <= edgeThreshold && Math.abs(median - sdf) > correctionThreshold) {
      fields[base + 0] = sdf;
      fields[base + 1] = sdf;
      fields[base + 2] = sdf;
    }
  }
}

function pointInShape(x: number, y: number, contours: ColoredEdge[][]) {
  let winding = 0;
  for (const contour of contours) {
    winding += contourWinding(x, y, contour);
  }
  return winding !== 0;
}

function contourWinding(x: number, y: number, contour: ColoredEdge[]) {
  let winding = 0;
  for (const edge of contour) {
    if (edge.kind === 'line') {
      winding += windingContribution(x, y, edge.p0.x, edge.p0.y, edge.p1.x, edge.p1.y);
    } else {
      let prevX = edge.p0.x;
      let prevY = edge.p0.y;
      const steps = 16;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const point = evaluateQuadratic(edge, t);
        winding += windingContribution(x, y, prevX, prevY, point.x, point.y);
        prevX = point.x;
        prevY = point.y;
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

function median3(a: number, b: number, c: number) {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}

function cross(ax: number, ay: number, bx: number, by: number) {
  return ax * by - ay * bx;
}

function dot(ax: number, ay: number, bx: number, by: number) {
  return ax * bx + ay * by;
}
