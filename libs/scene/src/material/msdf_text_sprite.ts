import type { BindGroup, PBFunctionScope } from '@zephyr3d/device';
import type { Clonable } from '@zephyr3d/base';
import { ShaderHelper } from './shader/helper';
import { MeshMaterial } from './meshmaterial';
import { MSDFTextMaterial } from './msdf_text';
import type { DrawContext } from '../render';

/**
 * Billboard MSDF text material.
 *
 * @public
 */
export class MSDFTextSpriteMaterial extends MSDFTextMaterial implements Clonable<MSDFTextSpriteMaterial> {
  private _rotation: number;
  constructor() {
    super();
    this._rotation = 0;
  }
  get rotation() {
    return this._rotation;
  }
  set rotation(value: number) {
    if (this._rotation !== value) {
      this._rotation = value;
      this.uniformChanged();
    }
  }
  clone() {
    const other = new MSDFTextSpriteMaterial();
    other.copyFrom(this);
    return other;
  }
  copyFrom(other: this) {
    super.copyFrom(other);
    this.rotation = other.rotation;
  }
  vertexShader(scope: PBFunctionScope) {
    MeshMaterial.prototype.vertexShader.call(this, scope);
    const pb = scope.$builder;
    scope.$l.oPos = ShaderHelper.resolveVertexPosition(scope);
    scope.$inputs.zMSDFUV = pb.vec2().attrib('texCoord0');
    scope.$outputs.zMSDFUV = scope.$inputs.zMSDFUV;
    scope.$outputs.zMSDFLocalPos = scope.oPos.xy;
    scope.zMSDFSpriteRotation = pb.float().uniform(2);
    scope.$l.worldPos = ShaderHelper.getWorldMatrix(scope)[3].xyz;
    scope.$l.scaleX = pb.sqrt(
      pb.dot(ShaderHelper.getWorldMatrix(scope)[0].xyz, ShaderHelper.getWorldMatrix(scope)[0].xyz)
    );
    scope.$l.scaleY = pb.sqrt(
      pb.dot(ShaderHelper.getWorldMatrix(scope)[1].xyz, ShaderHelper.getWorldMatrix(scope)[1].xyz)
    );
    scope.$l.localPos = scope.oPos.xy;
    const viewMatrix = ShaderHelper.getViewMatrix(scope);
    scope.$l.forward = pb.vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z);
    scope.$l.axis = scope.$choice(
      pb.lessThan(pb.abs(scope.forward.y), 0.999),
      pb.vec3(0, 1, 0),
      pb.vec3(1, 0, 0)
    );
    scope.$l.right = pb.normalize(pb.cross(scope.axis, scope.forward));
    scope.$l.up = pb.normalize(pb.cross(scope.forward, scope.right));
    scope.$l.c = pb.cos(scope.zMSDFSpriteRotation);
    scope.$l.s = pb.sin(scope.zMSDFSpriteRotation);
    scope.$l.rightRot = pb.add(pb.mul(scope.up, scope.s), pb.mul(scope.right, scope.c));
    scope.$l.upRot = pb.sub(pb.mul(scope.up, scope.c), pb.mul(scope.right, scope.s));
    scope.$outputs.worldPos = pb.add(
      scope.worldPos,
      pb.mul(scope.rightRot, pb.mul(scope.localPos.x, scope.scaleX)),
      pb.mul(scope.upRot, pb.mul(scope.localPos.y, scope.scaleY))
    );
    ShaderHelper.setClipSpacePosition(
      scope,
      pb.mul(ShaderHelper.getViewProjectionMatrix(scope), pb.vec4(scope.$outputs.worldPos, 1))
    );
  }
  applyUniformValues(bindGroup: BindGroup, ctx: DrawContext, pass: number) {
    super.applyUniformValues(bindGroup, ctx, pass);
    bindGroup.setValue('zMSDFSpriteRotation', this._rotation);
  }
}
