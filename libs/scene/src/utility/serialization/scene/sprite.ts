import { getEngine } from '../../../app/api';
import type { MeshMaterial } from '../../../material/meshmaterial';
import { GraphNode, type SceneNode } from '../../../scene';
import { defineProps, type SerializableClass } from '../types';
import { meshInstanceClsMap } from './common';
import { Sprite } from '../../../scene/sprite';
import { SpriteMaterial } from '../../../material/sprite';
import { Vector2, Vector3, Vector4 } from '@zephyr3d/base';
import { TextSprite } from '../../../scene/textsprite';

/** @internal */
export function getSpriteClass(): SerializableClass {
  return {
    ctor: Sprite,
    name: 'Sprite',
    parent: GraphNode,
    noTitle: true,
    createFunc(ctx: SceneNode) {
      const node = new Sprite(ctx.scene!);
      node.parent = ctx;
      return { obj: node };
    },
    getProps() {
      return defineProps([
        {
          name: 'Anchor',
          description: 'Sprite pivot in normalized UV space',
          type: 'vec2',
          default: [0.5, 0.5],
          get(this: Sprite, value) {
            value.num[0] = this.anchorX;
            value.num[1] = this.anchorY;
          },
          set(this: Sprite, value) {
            this.anchorX = value.num[0];
            this.anchorY = value.num[1];
          }
        },
        {
          name: 'UVTopLeft',
          description: 'Top-left UV coordinate of the sprite image',
          type: 'vec2',
          default: [0, 0],
          get(this: Sprite, value) {
            const lt = this.uvTopLeft;
            value.num[0] = lt.x;
            value.num[1] = lt.y;
          },
          set(this: Sprite, value) {
            this.uvTopLeft = new Vector2(value.num[0], value.num[1]);
          }
        },
        {
          name: 'UVBottomRight',
          description: 'Bottom-right UV coordinate of the sprite image',
          type: 'vec2',
          default: [1, 1],
          get(this: Sprite, value) {
            const rb = this.uvBottomRight;
            value.num[0] = rb.x;
            value.num[1] = rb.y;
          },
          set(this: Sprite, value) {
            this.uvBottomRight = new Vector2(value.num[0], value.num[1]);
          }
        },
        {
          name: 'Material',
          description: 'Sprite material object',
          type: 'object',
          options: {
            mimeTypes: ['application/vnd.zephyr3d.material+json']
          },
          get(this: Sprite, value) {
            const m = this.material?.coreMaterial;
            value.str[0] = getEngine().resourceManager.getAssetId(m) ?? '';
          },
          async set(this: Sprite, value) {
            if (value?.str[0]) {
              const material = await getEngine().resourceManager.fetchMaterial<MeshMaterial>(value.str[0]);
              if (material && material instanceof SpriteMaterial) {
                this.material = material;
              } else {
                console.error(
                  material ? `Not a sprite material: ${value.str[0]}` : `Material not found: ${value.str[0]}`
                );
              }
            }
          }
        },
        {
          name: 'Geometry Instance',
          description: 'If true, the sprite uses a material instance',
          type: 'bool',
          get(this: Sprite, value) {
            value.bool[0] = !!this.material?.$isInstance;
          },
          set(this: Sprite, value) {
            this.material =
              (value.bool[0] ? this.material?.createInstance() : this.material?.coreMaterial) ?? null;
          }
        },
        {
          name: 'MaterialInstanceUniforms',
          description: 'Per-instance overrides for sprite material uniforms',
          type: 'object',
          phase: 1,
          options: {
            objectTypes: []
          },
          isHidden(this: Sprite) {
            return this.material && !this.material?.$isInstance;
          },
          isNullable() {
            return true;
          },
          get(this: Sprite, value) {
            const C = this.material?.$isInstance
              ? meshInstanceClsMap.get(this.material.coreMaterial.constructor as typeof MeshMaterial)
              : null;
            value.object[0] = C ? new C.C(this.material) : null;
          },
          set(this: Sprite, value) {
            if (value.object[0]) {
              this.material = (value.object[0] as any)?.material;
            }
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getTextSpriteClass(): SerializableClass {
  return {
    ctor: TextSprite,
    name: 'TextSprite',
    parent: GraphNode,
    noTitle: true,
    createFunc(ctx: SceneNode) {
      const node = new TextSprite(ctx.scene!);
      node.parent = ctx;
      return { obj: node };
    },
    getProps() {
      return defineProps([
        {
          name: 'Anchor',
          description: 'Sprite pivot in normalized UV space',
          type: 'vec2',
          default: [0.5, 0.5],
          get(this: Sprite, value) {
            value.num[0] = this.anchorX;
            value.num[1] = this.anchorY;
          },
          set(this: Sprite, value) {
            this.anchorX = value.num[0];
            this.anchorY = value.num[1];
          }
        },
        {
          name: 'Resolution',
          description: 'Text render target resolution',
          type: 'int2',
          options: {
            minValue: 1,
            maxValue: 4096
          },
          default: [128, 128],
          get(this: TextSprite, value) {
            value.num[0] = this.resolutionX;
            value.num[1] = this.resolutionY;
          },
          set(this: TextSprite, value) {
            this.resolutionX = value.num[0];
            this.resolutionY = value.num[1];
          }
        },
        {
          name: 'Font',
          description: 'Canvas font string (e.g. "12px arial")',
          type: 'string',
          default: '12px arial',
          get(this: TextSprite, value) {
            value.str[0] = this.font;
          },
          set(this: TextSprite, value) {
            this.font = value.str[0];
          }
        },
        {
          name: 'Text',
          description: 'Displayed text content',
          type: 'string',
          default: '',
          options: {
            multiline: true
          },
          get(this: TextSprite, value) {
            value.str[0] = this.text;
          },
          set(this: TextSprite, value) {
            this.text = value.str[0];
          }
        },
        {
          name: 'TextColor',
          description: 'Color of the rendered text',
          type: 'rgb',
          default: [1, 1, 1],
          get(this: TextSprite, value) {
            const c = this.textColor;
            value.num[0] = c.x;
            value.num[1] = c.y;
            value.num[2] = c.z;
          },
          set(this: TextSprite, value) {
            this.textColor = new Vector3(value.num[0], value.num[1], value.num[2]);
          }
        }
      ]);
    }
  };
}
