import type { BindGroup, PBInsideFunctionScope, Texture2D } from '@zephyr3d/device';
import type { Clonable, Immutable } from '@zephyr3d/base';
import { DRef, Vector3, Vector4 } from '@zephyr3d/base';
import type { DrawContext } from '../render/drawable';
import { SpriteMaterial } from './sprite';
import { fetchSampler } from '../utility/misc';

/**
 * Single-channel signed-distance-field sprite material.
 *
 * @public
 */
export class SDFSpriteMaterial extends SpriteMaterial implements Clonable<SDFSpriteMaterial> {
  static FEATURE_SPRITE_TEXTURE = this.defineFeature();
  protected _texture: DRef<Texture2D>;
  protected _color: Vector3;
  protected _sdfParams: Vector4;
  constructor() {
    super();
    this._texture = new DRef();
    this._color = new Vector3(1, 1, 1);
    this._sdfParams = new Vector4(8, 1, 1, 0);
    this.blendMode = 'blend';
  }
  get spriteTexture() {
    return this._texture.get();
  }
  set spriteTexture(tex) {
    tex = tex ?? null;
    if (tex !== this._texture.get()) {
      this._texture.set(tex);
      this.useFeature(SDFSpriteMaterial.FEATURE_SPRITE_TEXTURE, !!tex);
      this.uniformChanged();
    }
  }
  get textColor(): Immutable<Vector3> {
    return this._color;
  }
  set textColor(value: Immutable<Vector3>) {
    if (!this._color.equalsTo(value)) {
      this._color.set(value);
      this.uniformChanged();
    }
  }
  get sdfDistanceRange() {
    return this._sdfParams.x;
  }
  set sdfDistanceRange(value: number) {
    if (this._sdfParams.x !== value) {
      this._sdfParams.x = value;
      this.uniformChanged();
    }
  }
  setSDFTextureInfo(distanceRange: number, width: number, height: number) {
    if (this._sdfParams.x !== distanceRange || this._sdfParams.y !== width || this._sdfParams.z !== height) {
      this._sdfParams.setXYZW(distanceRange, width, height, 0);
      this.uniformChanged();
    }
  }
  clone() {
    const other = new SDFSpriteMaterial();
    other.copyFrom(this);
    return other;
  }
  copyFrom(other: this) {
    super.copyFrom(other);
    this.spriteTexture = other.spriteTexture;
    this.textColor = other.textColor;
    this._sdfParams.set(other._sdfParams);
  }
  protected internalApplyUniforms(bindGroup: BindGroup, ctx: DrawContext) {
    if (this.needFragmentColor(ctx)) {
      bindGroup.setValue('zTextColor', this._color);
      bindGroup.setValue('zSDFParams', this._sdfParams);
      if (this.spriteTexture) {
        bindGroup.setTexture('zSpriteTexture', this.spriteTexture, fetchSampler('clamp_linear'));
      }
    }
  }
  protected internalSetupUniforms(scope: PBInsideFunctionScope) {
    const pb = scope.$builder;
    if (pb.shaderKind === 'fragment' && this.needFragmentColor()) {
      scope.zTextColor = pb.vec3().uniform(2);
      scope.zSDFParams = pb.vec4().uniform(2);
      if (this.spriteTexture) {
        scope.zSpriteTexture = pb.tex2D().uniform(2);
      }
    }
  }
  protected calcFragmentColor(scope: PBInsideFunctionScope) {
    const pb = scope.$builder;
    if (!this.spriteTexture) {
      return pb.vec4(scope.zTextColor, 1);
    }
    scope.$l.sdf = pb.textureSample(scope.zSpriteTexture, scope.$inputs.zVertexUV).r;
    scope.$l.unitRange = pb.div(
      pb.vec2(scope.zSDFParams.x),
      pb.max(pb.vec2(scope.zSDFParams.y, scope.zSDFParams.z), pb.vec2(1))
    );
    scope.$l.screenTexSize = pb.div(pb.vec2(1), pb.max(pb.fwidth(scope.$inputs.zVertexUV), pb.vec2(1e-4)));
    scope.$l.screenPxRange = pb.max(pb.mul(0.5, pb.dot(scope.unitRange, scope.screenTexSize)), 1);
    scope.$l.screenPxDistance = pb.mul(scope.screenPxRange, pb.sub(scope.sdf, 0.5));
    scope.$l.alpha = pb.clamp(pb.add(scope.screenPxDistance, 0.5), 0, 1);
    return pb.vec4(scope.zTextColor, scope.alpha);
  }
  protected onDispose() {
    super.onDispose();
    this._texture.dispose();
  }
}
