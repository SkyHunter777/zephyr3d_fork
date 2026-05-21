import type { BoundingBox } from '../utility/bounding_volume';

/** @internal */
export function calculateMorphBoundingBox(
  morphBoundingBox: BoundingBox,
  keyframeBoundingBox: BoundingBox[],
  weights: Float32Array,
  numTargets: number
) {
  morphBoundingBox.minPoint.setXYZ(0, 0, 0);
  morphBoundingBox.maxPoint.setXYZ(0, 0, 0);
  for (let i = 0; i < numTargets; i++) {
    const weight = weights[i];
    const keyframeBox = keyframeBoundingBox[i];
    morphBoundingBox.minPoint.x += keyframeBox.minPoint.x * weight;
    morphBoundingBox.minPoint.y += keyframeBox.minPoint.y * weight;
    morphBoundingBox.minPoint.y += keyframeBox.minPoint.z * weight;
    morphBoundingBox.maxPoint.x += keyframeBox.maxPoint.x * weight;
    morphBoundingBox.maxPoint.y += keyframeBox.maxPoint.y * weight;
    morphBoundingBox.maxPoint.y += keyframeBox.maxPoint.z * weight;
  }
}
