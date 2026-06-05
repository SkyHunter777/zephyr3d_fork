# Text Rendering

Zephyr3D provides three scene nodes for text rendering:

- `TextSprite`: renders text into a texture first, then displays it as a camera-facing sprite.
- `MSDFText`: builds mesh geometry from a font asset and renders it with a runtime MSDF glyph atlas.
- `MSDFTextSprite`: uses the same MSDF font pipeline as `MSDFText`, but always faces the camera like a billboard.

Use `TextSprite` for small labels that change infrequently or need browser canvas font behavior. Use the MSDF nodes when the text must stay sharp under scaling, perspective, or large on-screen size.

## TextSprite

`TextSprite` uses `device.drawText()` internally. When `text`, `font`, `resolutionX`, `resolutionY`, or `textColor` changes, the node redraws its offscreen texture.

```javascript
import { Vector3 } from '@zephyr3d/base';
import { TextSprite } from '@zephyr3d/scene';

const label = new TextSprite(scene);
label.text = 'TextSprite\nCanvas texture';
label.font = 'bold 42px Arial';
label.textColor = new Vector3(1, 0.95, 0.2);
label.resolutionX = 512;
label.resolutionY = 192;
label.position.setXYZ(0, 1.6, 0);
label.scale.setXYZ(4.5, 1.7, 1);
```

Important properties:

- `text`: displayed text. Newline characters are supported.
- `font`: browser canvas font string, for example `'32px Arial'`.
- `resolutionX` / `resolutionY`: pixel size of the generated texture. Increase these when the sprite is large on screen.
- `textColor`: text color as linear RGB.
- `anchorX` / `anchorY`: normalized sprite pivot. The default is `(0.5, 0.5)`.

When using a remote font with `TextSprite`, load it through CSS `@font-face` or the browser `FontFace` API before assigning the `font` string.

Because the text is baked into a texture, avoid changing `text` every frame unless the label count is small.

## MSDF Font Assets

`MSDFText` and `MSDFTextSprite` require a `FontAsset`. Load it with `ResourceManager.fetchFontAsset()`:

```javascript
const FONT_URL = 'https://cdn.zephyr3d.org/doc/assets/fonts/Inter-Regular.otf';

const fontAsset = await getEngine().resourceManager.fetchFontAsset(FONT_URL, {
  pageSize: 1024,
  glyphSize: 64
});
```

`pageSize` controls each atlas texture size. `glyphSize` controls the base MSDF glyph resolution. Larger values improve quality for large text but use more memory and generation time. The options are applied the first time a URL is loaded; cached loads of the same URL reuse the existing `FontAsset`.

Make sure the font contains all characters used by the text. Missing glyphs are skipped during layout.

## MSDFText

`MSDFText` creates regular scene geometry. It follows the node's position, rotation, and scale, so it is useful for text placed on panels, signs, or other 3D surfaces.

```javascript
import { Vector2, Vector3 } from '@zephyr3d/base';
import { MSDFText } from '@zephyr3d/scene';

const title = new MSDFText(scene);
title.fontAsset = fontAsset;
title.text = 'MSDFText\n3D layout node';
title.fontSize = 0.45;
title.maxWidth = 4.5;
title.textAlign = 'center';
title.anchor = new Vector2(0.5, 0.5);
title.textColor = new Vector3(0.45, 0.9, 1);
title.outlineColor = new Vector3(0.02, 0.05, 0.08);
title.outlineWidth = 0.025;
title.position.setXYZ(-2.3, -0.3, 0);
title.rotation.fromEulerAngle(0, -0.35, 0);
```

Main layout properties:

- `fontAsset`: loaded `FontAsset`; no geometry is generated until this and `text` are both set.
- `fontSize`: text size in local-space units before node scaling.
- `maxWidth`: layout width in local-space units. `0` disables wrapping.
- `textAlign`: `'left'`, `'center'`, or `'right'`.
- `anchor`: normalized pivot inside the layout box.
- `textColor`, `outlineColor`, `outlineWidth`: material styling.
- `castShadow`: allow the generated geometry to render into shadow maps.

## MSDFTextSprite

`MSDFTextSprite` exposes the same text layout and styling properties as `MSDFText`, but its generated geometry is rendered as a billboard. Use it for floating labels, nameplates, and markers that should remain readable while the camera moves.

```javascript
import { Vector2, Vector3 } from '@zephyr3d/base';
import { MSDFTextSprite } from '@zephyr3d/scene';

const marker = new MSDFTextSprite(scene);
marker.fontAsset = fontAsset;
marker.text = 'MSDFTextSprite\ncamera-facing marker';
marker.fontSize = 0.36;
marker.maxWidth = 3.6;
marker.textAlign = 'center';
marker.anchor = new Vector2(0.5, 0.5);
marker.textColor = new Vector3(1, 0.85, 0.35);
marker.outlineColor = new Vector3(0, 0, 0);
marker.outlineWidth = 0.02;
marker.position.setXYZ(2.2, -1.45, 0);
```

`MSDFTextSprite` is not rendered into shadow maps. Its Z rotation is treated as an in-plane billboard rotation.

## Demo

The following demo uses the supplied Inter font and shows all three text node types.

<div class="showcase" case="tut-54"></div>
