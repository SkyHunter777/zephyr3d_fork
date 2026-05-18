import type {
  BindGroup,
  PBFunctionScope,
  PBInsideFunctionScope,
  PBShaderExp,
  Texture2D
} from '@zephyr3d/device';
import { DRef, type Clonable, type Immutable, Vector3 } from '@zephyr3d/base';
import type { DrawContext } from '../render';
import { MeshMaterial } from './meshmaterial';
import { ShaderHelper } from './shader/helper';
import { fetchSampler } from '../utility/misc';

/**
 * Atlas-based MSDF text material.
 *
 * @public
 */
export class MSDFTextMaterial extends MeshMaterial implements Clonable<MSDFTextMaterial> {
  static FEATURE_TEXT_ATLAS = this.defineFeature();
  private _atlas: DRef<Texture2D>;
  private _textColor: Vector3;
  private _outlineColor: Vector3;
  private _distanceRange: number;
  private _atlasSize: Float32Array<ArrayBuffer>;
  private _smallGlyphThreshold: number;
  private _outlineWidth: number;
  constructor() {
    super();
    this._atlas = new DRef();
    this._textColor = new Vector3(1, 1, 1);
    this._outlineColor = new Vector3(0, 0, 0);
    this._distanceRange = 6;
    this._atlasSize = new Float32Array([1, 1]);
    this._smallGlyphThreshold = 18;
    this._outlineWidth = 0;
    this.cullMode = 'none';
    this.blendMode = 'blend';
  }
  get atlasTexture() {
    return this._atlas.get();
  }
  set atlasTexture(tex) {
    tex = tex ?? null;
    if (tex !== this._atlas.get()) {
      this._atlas.set(tex);
      this.useFeature(MSDFTextMaterial.FEATURE_TEXT_ATLAS, !!tex);
      this.uniformChanged();
    }
  }
  get textColor(): Immutable<Vector3> {
    return this._textColor;
  }
  set textColor(value: Immutable<Vector3>) {
    if (!this._textColor.equalsTo(value)) {
      this._textColor.set(value);
      this.uniformChanged();
    }
  }
  get outlineColor(): Immutable<Vector3> {
    return this._outlineColor;
  }
  set outlineColor(value: Immutable<Vector3>) {
    if (!this._outlineColor.equalsTo(value)) {
      this._outlineColor.set(value);
      this.uniformChanged();
    }
  }
  get distanceRange() {
    return this._distanceRange;
  }
  set distanceRange(value: number) {
    if (this._distanceRange !== value) {
      this._distanceRange = value;
      this.uniformChanged();
    }
  }
  get smallGlyphThreshold() {
    return this._smallGlyphThreshold;
  }
  set smallGlyphThreshold(value: number) {
    if (this._smallGlyphThreshold !== value) {
      this._smallGlyphThreshold = value;
      this.uniformChanged();
    }
  }
  get outlineWidth() {
    return this._outlineWidth;
  }
  set outlineWidth(value: number) {
    value = Math.max(0, value);
    if (this._outlineWidth !== value) {
      this._outlineWidth = value;
      this.uniformChanged();
    }
  }
  clone() {
    const other = new MSDFTextMaterial();
    other.copyFrom(this);
    return other;
  }
  copyFrom(other: this) {
    super.copyFrom(other);
    this.atlasTexture = other.atlasTexture;
    this.textColor = other.textColor;
    this.outlineColor = other.outlineColor;
    this.distanceRange = other.distanceRange;
    this.smallGlyphThreshold = other.smallGlyphThreshold;
    this.outlineWidth = other.outlineWidth;
    this._atlasSize[0] = other._atlasSize[0];
    this._atlasSize[1] = other._atlasSize[1];
  }
  vertexShader(scope: PBFunctionScope) {
    super.vertexShader(scope);
    const pb = scope.$builder;
    scope.$l.oPos = ShaderHelper.resolveVertexPosition(scope);
    scope.$inputs.zMSDFUV = pb.vec2().attrib('texCoord0');
    scope.$outputs.zMSDFUV = scope.$inputs.zMSDFUV;
    scope.$outputs.zMSDFLocalPos = scope.oPos.xy;
    scope.$outputs.worldPos = pb.mul(ShaderHelper.getWorldMatrix(scope), pb.vec4(scope.oPos, 1)).xyz;
    ShaderHelper.setClipSpacePosition(
      scope,
      pb.mul(ShaderHelper.getViewProjectionMatrix(scope), pb.vec4(scope.$outputs.worldPos, 1))
    );
  }
  fragmentShader(scope: PBFunctionScope) {
    super.fragmentShader(scope);
    if (this.needFragmentColor()) {
      const pb = scope.$builder;
      scope.zMSDFAtlas = pb.tex2D().uniform(2);
      scope.zMSDFTextColor = pb.vec3().uniform(2);
      scope.zMSDFOutlineColor = pb.vec3().uniform(2);
      scope.zMSDFDistanceRange = pb.float().uniform(2);
      scope.zMSDFAtlasSize = pb.vec2().uniform(2);
      scope.zMSDFSmallGlyphThreshold = pb.float().uniform(2);
      scope.zMSDFOutlineWidth = pb.float().uniform(2);
      scope.$l.sample = pb.textureSample(scope.zMSDFAtlas, scope.$inputs.zMSDFUV);
      scope.$l.msdf = scope.sample.rgb;
      scope.$l.sdf = scope.sample.a;
      scope.$l.sd = median3(pb, scope.msdf.r, scope.msdf.g, scope.msdf.b);
      scope.$l.unitRange = pb.div(
        pb.vec2(scope.zMSDFDistanceRange),
        pb.max(scope.zMSDFAtlasSize, pb.vec2(1))
      );
      scope.$l.screenTexSize = pb.div(pb.vec2(1), pb.max(pb.fwidth(scope.$inputs.zMSDFUV), pb.vec2(1e-4)));
      scope.$l.screenPxRange = pb.max(pb.mul(0.5, pb.dot(scope.unitRange, scope.screenTexSize)), 1);
      scope.$l.msdfPxDistance = pb.mul(scope.screenPxRange, pb.sub(scope.sd, 0.5));
      scope.$l.sdfPxDistance = pb.mul(scope.screenPxRange, pb.sub(scope.sdf, 0.5));
      scope.$l.alphaMsdf = pb.clamp(pb.add(scope.msdfPxDistance, 0.5), 0, 1);
      scope.$l.alphaSdf = pb.clamp(pb.add(scope.sdfPxDistance, 0.5), 0, 1);
      scope.$l.glyphPixelSpan = pb.min(scope.screenTexSize.x, scope.screenTexSize.y);
      scope.$l.useSdf = pb.lessThan(scope.glyphPixelSpan, scope.zMSDFSmallGlyphThreshold);
      scope.$l.alpha = pb.mix(scope.alphaMsdf, scope.alphaSdf, pb.float(scope.useSdf));
      scope.$l.localUnitsPerPixel = pb.max(
        pb.min(pb.fwidth(scope.$inputs.zMSDFLocalPos.x), pb.fwidth(scope.$inputs.zMSDFLocalPos.y)),
        1e-4
      );
      scope.$l.outlinePxWidth = pb.div(scope.zMSDFOutlineWidth, scope.localUnitsPerPixel);
      scope.$l.outlineAlpha = pb.clamp(pb.add(scope.sdfPxDistance, pb.add(0.5, scope.outlinePxWidth)), 0, 1);
      scope.$l.outlineMask = pb.max(pb.sub(scope.outlineAlpha, scope.alpha), 0);
      scope.$l.finalColor = pb.add(
        pb.mul(scope.zMSDFTextColor, scope.alpha),
        pb.mul(scope.zMSDFOutlineColor, scope.outlineMask)
      );
      scope.$l.finalAlpha = pb.max(scope.alpha, scope.outlineMask);
      this.outputFragmentColor(scope, scope.$inputs.worldPos, pb.vec4(scope.finalColor, scope.finalAlpha));
    } else {
      this.outputFragmentColor(scope, scope.$inputs.worldPos, null);
    }
  }
  applyUniformValues(bindGroup: BindGroup, ctx: DrawContext, pass: number) {
    super.applyUniformValues(bindGroup, ctx, pass);
    if (this.needFragmentColor(ctx) && this.atlasTexture) {
      bindGroup.setValue('zMSDFTextColor', this._textColor);
      bindGroup.setValue('zMSDFOutlineColor', this._outlineColor);
      bindGroup.setValue('zMSDFDistanceRange', this._distanceRange);
      this._atlasSize[0] = this.atlasTexture.width;
      this._atlasSize[1] = this.atlasTexture.height;
      bindGroup.setValue('zMSDFAtlasSize', this._atlasSize);
      bindGroup.setValue('zMSDFSmallGlyphThreshold', this._smallGlyphThreshold);
      bindGroup.setValue('zMSDFOutlineWidth', this._outlineWidth);
      bindGroup.setTexture('zMSDFAtlas', this.atlasTexture, fetchSampler('clamp_linear'));
    }
  }
  protected onDispose() {
    super.onDispose();
    this._atlas.dispose();
  }
}

function median3(pb: PBInsideFunctionScope['$builder'], a: PBShaderExp, b: PBShaderExp, c: PBShaderExp) {
  return pb.sub(pb.sub(pb.add(a, b, c), pb.min(pb.min(a, b), c)), pb.max(pb.max(a, b), c));
}
