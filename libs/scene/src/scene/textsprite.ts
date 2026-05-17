import type { Scene } from './scene';
import { StandardSpriteMaterial } from '../material/sprite_std';
import { BaseSprite } from './basesprite';
import type { Immutable, Nullable } from '@zephyr3d/base';
import { Vector3 } from '@zephyr3d/base';
import { Vector2, Vector4 } from '@zephyr3d/base';
import type { RenderStateSet } from '@zephyr3d/device';
import { getDevice } from '../app/api';
import type { Sprite } from './sprite';

/**
 * 3D Text Sprite node
 * @public
 */
export class TextSprite extends BaseSprite<StandardSpriteMaterial> {
  private _resolutionX: number;
  private _resolutionY: number;
  private _text: string;
  private _font: string;
  private _color: Vector3;
  private static _textRenderState: Nullable<RenderStateSet> = null;
  constructor(scene: Scene) {
    super(scene);
    this.material = new StandardSpriteMaterial();
    this._resolutionX = 128;
    this._resolutionY = 128;
    this._text = '';
    this._font = '12px arial';
    this._color = new Vector3(1, 1, 1);
    this.uvTopLeft = new Vector2(0, 1);
    this.uvBottomRight = new Vector2(1, 0);
    this.material.blendMode = 'blend';
    this.scene!.queueUpdateNode(this);
  }
  isSprite(): this is Sprite {
    return true;
  }
  get resolutionX() {
    return this._resolutionX;
  }
  set resolutionX(value) {
    if (this._resolutionX !== value) {
      this._resolutionX = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get resolutionY() {
    return this._resolutionY;
  }
  set resolutionY(value) {
    if (this._resolutionY !== value) {
      this._resolutionY = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get text() {
    return this._text;
  }
  set text(value) {
    if (this._text !== value) {
      this._text = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  get textColor(): Immutable<Vector3> {
    return this._color;
  }
  set textColor(value: Immutable<Vector3>) {
    if (!this._color.equalsTo(value)) {
      this._color.set(value);
      this.scene!.queueUpdateNode(this);
    }
  }
  get font() {
    return this._font;
  }
  set font(value) {
    if (this._font !== value) {
      this._font = value;
      this.scene!.queueUpdateNode(this);
    }
  }
  update(): void {
    let tex = this._material.get()!.spriteTexture;
    if (!tex || tex.width !== this._resolutionX || tex.height !== this._resolutionY) {
      tex = getDevice().createTexture2D('rgba8unorm', this._resolutionX, this._resolutionY, {
        mipmapping: false,
        samplerOptions: { minFilter: 'linear', magFilter: 'linear' }
      })!;
    }
    if (!TextSprite._textRenderState) {
      TextSprite._textRenderState = getDevice().createRenderStateSet();
      TextSprite._textRenderState.useRasterizerState().setCullMode('none');
      TextSprite._textRenderState.useDepthState().enableTest(false).enableWrite(false);
    }
    const fb = getDevice().createFrameBuffer([tex], null);
    getDevice().pushDeviceStates();
    getDevice().setFramebuffer(fb);
    getDevice().clearFrameBuffer(new Vector4(0, 0, 0, 0), null, null);
    getDevice().setFont(this._font);
    getDevice().setTextRenderStates(TextSprite._textRenderState);
    getDevice().drawText(
      this._text,
      { x: 0, y: 0, width: this._resolutionX, height: this._resolutionY },
      this._color,
      { halign: 'left', valign: 'top', wordWrap: true }
    );
    getDevice().setFont(null);
    getDevice().setTextRenderStates(null);
    getDevice().popDeviceStates();
    this._material.get()!.spriteTexture = tex;
    fb.dispose();
  }
}
