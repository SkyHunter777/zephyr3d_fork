import { getEngine } from '../../../app/api';
import { GraphNode, MSDFText, type SceneNode } from '../../../scene';
import { defineProps, type SerializableClass } from '../types';
import { Vector3 } from '@zephyr3d/base';
import { TextSprite } from '../../../scene/textsprite';
import { MSDFTextSprite } from '../../../scene/msdftextsprite';

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
          get(this: TextSprite, value) {
            value.num[0] = this.anchorX;
            value.num[1] = this.anchorY;
          },
          set(this: TextSprite, value) {
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

/** @internal */
export function getMSDFTextSpriteClass(): SerializableClass {
  return {
    ctor: MSDFTextSprite,
    name: 'MSDFTextSprite',
    parent: GraphNode,
    noTitle: true,
    createFunc(ctx: SceneNode) {
      const node = new MSDFTextSprite(ctx.scene!);
      node.parent = ctx;
      return { obj: node };
    },
    getProps() {
      return defineProps([
        {
          name: 'Anchor',
          description: 'Sprite pivot in normalized layout-box space',
          type: 'vec2',
          default: [0.5, 0.5],
          get(this: MSDFTextSprite, value) {
            value.num[0] = this.anchorX;
            value.num[1] = this.anchorY;
          },
          set(this: MSDFTextSprite, value) {
            this.anchorX = value.num[0];
            this.anchorY = value.num[1];
          }
        },
        {
          name: 'FontAsset',
          description: 'Font asset path used to build the runtime MSDF glyph atlas',
          type: 'object',
          default: '',
          options: {
            mimeTypes: ['font/ttf', 'font/otf']
          },
          isNullable() {
            return true;
          },
          get(this: MSDFTextSprite, value) {
            value.str[0] = this.fontAsset
              ? (getEngine().resourceManager.getAssetId(this.fontAsset) ?? '')
              : '';
          },
          async set(this: MSDFTextSprite, value) {
            this.fontAsset = value.str[0]
              ? await getEngine().resourceManager.fetchFontAsset(value.str[0])
              : null;
          }
        },
        {
          name: 'FontSize',
          description: 'Font size in local-space units before node scaling',
          type: 'float',
          default: 32,
          options: {
            minValue: 1,
            maxValue: 4096
          },
          get(this: MSDFTextSprite, value) {
            value.num[0] = this.fontSize;
          },
          set(this: MSDFTextSprite, value) {
            this.fontSize = value.num[0];
          }
        },
        {
          name: 'MaxWidth',
          description: 'Maximum layout width in local-space units, 0 disables wrapping',
          type: 'float',
          default: 0,
          options: {
            minValue: 0,
            maxValue: 4096
          },
          get(this: MSDFTextSprite, value) {
            value.num[0] = this.maxWidth;
          },
          set(this: MSDFTextSprite, value) {
            this.maxWidth = value.num[0];
          }
        },
        {
          name: 'TextAlign',
          description: 'Horizontal alignment within the layout width',
          type: 'string',
          default: 'left',
          options: {
            enum: {
              labels: ['Left', 'Center', 'Right'],
              values: ['left', 'center', 'right']
            }
          },
          get(this: MSDFTextSprite, value) {
            value.str[0] = this.textAlign;
          },
          set(this: MSDFTextSprite, value) {
            this.textAlign = value.str[0] as 'left' | 'center' | 'right';
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
          get(this: MSDFTextSprite, value) {
            value.str[0] = this.text;
          },
          set(this: MSDFTextSprite, value) {
            this.text = value.str[0];
          }
        },
        {
          name: 'TextColor',
          description: 'Color of the rendered text',
          type: 'rgb',
          default: [1, 1, 1],
          get(this: MSDFTextSprite, value) {
            const c = this.textColor;
            value.num[0] = c.x;
            value.num[1] = c.y;
            value.num[2] = c.z;
          },
          set(this: MSDFTextSprite, value) {
            this.textColor = new Vector3(value.num[0], value.num[1], value.num[2]);
          }
        },
        {
          name: 'OutlineColor',
          description: 'Color of the SDF outline rendered around the text',
          type: 'rgb',
          default: [0, 0, 0],
          get(this: MSDFTextSprite, value) {
            const c = this.outlineColor;
            value.num[0] = c.x;
            value.num[1] = c.y;
            value.num[2] = c.z;
          },
          set(this: MSDFTextSprite, value) {
            this.outlineColor = new Vector3(value.num[0], value.num[1], value.num[2]);
          }
        },
        {
          name: 'OutlineWidth',
          description:
            'Outline thickness in text local-space units; it scales with the text when moving closer or farther',
          type: 'float',
          default: 0,
          options: {
            minValue: 0,
            maxValue: 4096
          },
          get(this: MSDFTextSprite, value) {
            value.num[0] = this.outlineWidth;
          },
          set(this: MSDFTextSprite, value) {
            this.outlineWidth = value.num[0];
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getMSDFTextClass(): SerializableClass {
  return {
    ctor: MSDFText,
    name: 'MSDFText',
    parent: GraphNode,
    noTitle: true,
    createFunc(ctx: SceneNode) {
      const node = new MSDFText(ctx.scene!);
      node.parent = ctx;
      return { obj: node };
    },
    getProps() {
      return defineProps([
        {
          name: 'Anchor',
          description: 'Sprite pivot in normalized layout-box space',
          type: 'vec2',
          default: [0.5, 0.5],
          get(this: MSDFText, value) {
            value.num[0] = this.anchorX;
            value.num[1] = this.anchorY;
          },
          set(this: MSDFText, value) {
            this.anchorX = value.num[0];
            this.anchorY = value.num[1];
          }
        },
        {
          name: 'FontAsset',
          description: 'Font asset path used to build the runtime MSDF glyph atlas',
          type: 'object',
          default: '',
          options: {
            mimeTypes: ['font/ttf', 'font/otf']
          },
          isNullable() {
            return true;
          },
          get(this: MSDFText, value) {
            value.str[0] = this.fontAsset
              ? (getEngine().resourceManager.getAssetId(this.fontAsset) ?? '')
              : '';
          },
          async set(this: MSDFText, value) {
            this.fontAsset = value.str[0]
              ? await getEngine().resourceManager.fetchFontAsset(value.str[0])
              : null;
          }
        },
        {
          name: 'FontSize',
          description: 'Font size in local-space units before node scaling',
          type: 'float',
          default: 32,
          options: {
            minValue: 1,
            maxValue: 4096
          },
          get(this: MSDFText, value) {
            value.num[0] = this.fontSize;
          },
          set(this: MSDFText, value) {
            this.fontSize = value.num[0];
          }
        },
        {
          name: 'MaxWidth',
          description: 'Maximum layout width in local-space units, 0 disables wrapping',
          type: 'float',
          default: 0,
          options: {
            minValue: 0,
            maxValue: 4096
          },
          get(this: MSDFText, value) {
            value.num[0] = this.maxWidth;
          },
          set(this: MSDFText, value) {
            this.maxWidth = value.num[0];
          }
        },
        {
          name: 'TextAlign',
          description: 'Horizontal alignment within the layout width',
          type: 'string',
          default: 'left',
          options: {
            enum: {
              labels: ['Left', 'Center', 'Right'],
              values: ['left', 'center', 'right']
            }
          },
          get(this: MSDFText, value) {
            value.str[0] = this.textAlign;
          },
          set(this: MSDFText, value) {
            this.textAlign = value.str[0] as 'left' | 'center' | 'right';
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
          get(this: MSDFText, value) {
            value.str[0] = this.text;
          },
          set(this: MSDFText, value) {
            this.text = value.str[0];
          }
        },
        {
          name: 'TextColor',
          description: 'Color of the rendered text',
          type: 'rgb',
          default: [1, 1, 1],
          get(this: MSDFText, value) {
            const c = this.textColor;
            value.num[0] = c.x;
            value.num[1] = c.y;
            value.num[2] = c.z;
          },
          set(this: MSDFText, value) {
            this.textColor = new Vector3(value.num[0], value.num[1], value.num[2]);
          }
        },
        {
          name: 'OutlineColor',
          description: 'Color of the SDF outline rendered around the text',
          type: 'rgb',
          default: [0, 0, 0],
          get(this: MSDFText, value) {
            const c = this.outlineColor;
            value.num[0] = c.x;
            value.num[1] = c.y;
            value.num[2] = c.z;
          },
          set(this: MSDFText, value) {
            this.outlineColor = new Vector3(value.num[0], value.num[1], value.num[2]);
          }
        },
        {
          name: 'OutlineWidth',
          description:
            'Outline thickness in text local-space units; it scales with the text when moving closer or farther',
          type: 'float',
          default: 0,
          options: {
            minValue: 0,
            maxValue: 4096
          },
          get(this: MSDFText, value) {
            value.num[0] = this.outlineWidth;
          },
          set(this: MSDFText, value) {
            this.outlineWidth = value.num[0];
          }
        }
      ]);
    }
  };
}
