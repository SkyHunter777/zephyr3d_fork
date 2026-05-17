import type { GlyphContour, GlyphPoint } from '../font';
import type { ColoredEdge, MSDFShape } from './types';

export function buildMSDFShape(contours: GlyphContour[]): MSDFShape {
  return {
    sourceContours: contours.map((contour) => contour.map(clonePoint)),
    contours: contours.map((contour) => colorizeContour(buildContourEdges(contour)))
  };
}

function clonePoint(point: GlyphPoint) {
  return { x: point.x, y: point.y, onCurve: point.onCurve };
}

function buildContourEdges(contour: GlyphContour): ColoredEdge[] {
  contour = normalizeContourStart(contour);
  if (contour.length < 2) {
    return [];
  }
  const edges: ColoredEdge[] = [];
  let i = 0;
  while (i < contour.length) {
    const p0 = contour[i];
    const p1 = contour[(i + 1) % contour.length];
    if (p0.onCurve && p1.onCurve) {
      edges.push({
        kind: 'line',
        color: 0,
        p0: { x: p0.x, y: p0.y },
        p1: { x: p1.x, y: p1.y }
      });
      i += 1;
      continue;
    }
    if (p0.onCurve && !p1.onCurve) {
      const p2 = contour[(i + 2) % contour.length];
      if (!p2.onCurve) {
        throw new Error('Implicit midpoint contours must be expanded before MSDF conversion');
      }
      edges.push({
        kind: 'quadratic',
        color: 0,
        p0: { x: p0.x, y: p0.y },
        p1: { x: p1.x, y: p1.y },
        p2: { x: p2.x, y: p2.y }
      });
      i += 2;
      continue;
    }
    throw new Error('MSDF contour must start edge on an on-curve point');
  }
  return edges;
}

function normalizeContourStart(contour: GlyphContour) {
  if (contour.length === 0) {
    return contour;
  }
  const firstOnCurve = contour.findIndex((point) => point.onCurve);
  if (firstOnCurve < 0 || firstOnCurve === 0) {
    return contour;
  }
  return contour.slice(firstOnCurve).concat(contour.slice(0, firstOnCurve));
}

function colorizeContour(edges: ColoredEdge[]) {
  if (edges.length === 0) {
    return edges;
  }
  const corners = detectCorners(edges);
  if (corners.length === 0) {
    for (let i = 0; i < edges.length; i++) {
      edges[i].color = (i % 3) as 0 | 1 | 2;
    }
    return edges;
  }
  let color: 0 | 1 | 2 = 0;
  const cornerSet = new Set(corners);
  for (let i = 0; i < edges.length; i++) {
    edges[i].color = color;
    if (cornerSet.has((i + 1) % edges.length)) {
      color = ((color + 1) % 3) as 0 | 1 | 2;
    }
  }
  return edges;
}

function detectCorners(edges: ColoredEdge[]) {
  const result: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const prev = edges[(i + edges.length - 1) % edges.length];
    const curr = edges[i];
    const prevDir = normalize(getEdgeEndDirection(prev));
    const currDir = normalize(getEdgeStartDirection(curr));
    const dot = prevDir.x * currDir.x + prevDir.y * currDir.y;
    if (dot < 0.35) {
      result.push(i);
    }
  }
  return result;
}

function getEdgeStartDirection(edge: ColoredEdge) {
  return edge.kind === 'quadratic'
    ? { x: edge.p1.x - edge.p0.x, y: edge.p1.y - edge.p0.y }
    : { x: edge.p1.x - edge.p0.x, y: edge.p1.y - edge.p0.y };
}

function getEdgeEndDirection(edge: ColoredEdge) {
  return edge.kind === 'quadratic'
    ? { x: edge.p2!.x - edge.p1.x, y: edge.p2!.y - edge.p1.y }
    : { x: edge.p1.x - edge.p0.x, y: edge.p1.y - edge.p0.y };
}

function normalize(v: { x: number; y: number }) {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-8 ? { x: v.x / len, y: v.y / len } : { x: 1, y: 0 };
}
