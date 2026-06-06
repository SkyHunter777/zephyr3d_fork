import type { PBInsideFunctionScope, PBShaderExp } from '@zephyr3d/device';
import { ShaderHelper } from '../material';
import { LIGHT_TYPE_DIRECTIONAL, LIGHT_TYPE_POINT, LIGHT_TYPE_SPOT } from '../values';

function getShadowReceiverBiasFactors(scope: PBInsideFunctionScope) {
  const pb = scope.$builder;
  const alphaCutoff = (scope as PBInsideFunctionScope & { zAlphaCutoff?: PBShaderExp }).zAlphaCutoff;
  if (alphaCutoff) {
    // Thin masked geometry such as layered hair cards needs a tighter receiver bias,
    // otherwise nearby layers lose self-shadow before the shadow map is even sampled.
    const cutoff = pb.clamp(alphaCutoff, 0, 1);
    return pb.vec2(pb.mix(0.22, 0.4, cutoff), pb.mix(0.05, 0.16, cutoff)) as PBShaderExp;
  }
  return pb.vec2(1, 1) as PBShaderExp;
}

function isMaskedPerspectiveShadowLight(scope: PBInsideFunctionScope, lightType: number) {
  const alphaCutoff = (scope as PBInsideFunctionScope & { zAlphaCutoff?: PBShaderExp }).zAlphaCutoff;
  return !!alphaCutoff && (lightType === LIGHT_TYPE_SPOT || lightType === LIGHT_TYPE_POINT);
}

function getShadowReceiverNoL(scope: PBInsideFunctionScope, NdotL: PBShaderExp, lightType?: number) {
  const pb = scope.$builder;
  const alphaCutoff = (scope as PBInsideFunctionScope & { zAlphaCutoff?: PBShaderExp }).zAlphaCutoff;
  if (alphaCutoff) {
    // Layered masked cards should not explode slope bias at grazing angles.
    // This is especially visible for back / rim spot lights on hair cards.
    const cutoff = pb.clamp(alphaCutoff, 0, 1);
    if (lightType != null && isMaskedPerspectiveShadowLight(scope, lightType)) {
      return pb.max(NdotL, pb.mix(0.85, 0.95, cutoff)) as PBShaderExp;
    }
    return pb.max(NdotL, pb.mix(0.45, 0.65, cutoff)) as PBShaderExp;
  }
  return NdotL as PBShaderExp;
}

function getShadowReceiverPerspectiveBiasScale(
  scope: PBInsideFunctionScope,
  lightType: number,
  linearDepth: PBShaderExp,
  farNearRatio: PBShaderExp
) {
  const pb = scope.$builder;
  const alphaCutoff = (scope as PBInsideFunctionScope & { zAlphaCutoff?: PBShaderExp }).zAlphaCutoff;
  if (alphaCutoff && isMaskedPerspectiveShadowLight(scope, lightType)) {
    const cutoff = pb.clamp(alphaCutoff, 0, 1);
    // Perspective shadow cameras (spot / point) can over-amplify receiver bias at depth.
    // Keep masked layered geometry in a much tighter range so hair cards can still self-occlude.
    const cappedFarNearRatio = pb.min(farNearRatio, pb.mix(1.15, 1.6, cutoff));
    return pb.mix(1, cappedFarNearRatio, linearDepth) as PBShaderExp;
  }
  return pb.mix(1, farNearRatio, linearDepth) as PBShaderExp;
}

export function computeShadowBiasCSM(scope: PBInsideFunctionScope, NdotL: PBShaderExp, split: PBShaderExp) {
  const pb = scope.$builder;
  const depthBiasParam = ShaderHelper.getDepthBiasValues(scope);
  const splitFlags = pb.vec4(
    pb.float(pb.equal(split, 0)),
    pb.float(pb.equal(split, 1)),
    pb.float(pb.equal(split, 2)),
    pb.float(pb.equal(split, 3))
  );
  const depthBiasScale = pb.dot(ShaderHelper.getDepthBiasScales(scope), splitFlags);
  const receiverBiasFactors = getShadowReceiverBiasFactors(scope);
  const receiverNoL = getShadowReceiverNoL(scope, NdotL);
  return pb.dot(
    pb.mul(depthBiasParam.xy, receiverBiasFactors, pb.vec2(1, pb.sub(1, receiverNoL)), depthBiasScale),
    pb.vec2(1, 1)
  );
}

export function computeShadowBias(
  lightType: number,
  scope: PBInsideFunctionScope,
  z: PBShaderExp,
  NdotL: PBShaderExp,
  linear: boolean
) {
  const pb = scope.$builder;
  const depthBiasParam = ShaderHelper.getDepthBiasValues(scope);
  const receiverBiasFactors = getShadowReceiverBiasFactors(scope);
  const receiverNoL = getShadowReceiverNoL(scope, NdotL, lightType);
  if (lightType === LIGHT_TYPE_DIRECTIONAL) {
    return pb.dot(
      pb.mul(depthBiasParam.xy, receiverBiasFactors, pb.vec2(1, pb.sub(1, receiverNoL))),
      pb.vec2(1, 1)
    );
  } else {
    const nearFar = ShaderHelper.getShadowCameraParams(scope).xy;
    const linearDepth = linear ? z : ShaderHelper.nonLinearDepthToLinearNormalized(scope, z, nearFar);
    const biasScaleFactor = getShadowReceiverPerspectiveBiasScale(
      scope,
      lightType,
      linearDepth,
      depthBiasParam.w
    );
    let bias = pb.dot(
      pb.mul(depthBiasParam.xy, receiverBiasFactors, pb.vec2(1, pb.sub(1, receiverNoL)), biasScaleFactor),
      pb.vec2(1, 1)
    );
    if (isMaskedPerspectiveShadowLight(scope, lightType)) {
      const alphaCutoff = (scope as PBInsideFunctionScope & { zAlphaCutoff?: PBShaderExp }).zAlphaCutoff!;
      bias = pb.mul(bias, pb.mix(0.12, 0.22, pb.clamp(alphaCutoff, 0, 1))) as PBShaderExp;
    }
    return bias;
  }
}
