import { backendWebGL2 } from '@zephyr3d/backend-webgl';
import { Vector2, Vector3 } from '@zephyr3d/base';
import {
  Application,
  MSDFText,
  MSDFTextSprite,
  OrbitCameraController,
  PerspectiveCamera,
  Scene,
  TextSprite,
  getEngine,
  getInput
} from '@zephyr3d/scene';

const FONT_URL = 'https://cdn.zephyr3d.org/doc/assets/fonts/Inter-Regular.otf';

const myApp = new Application({
  backend: backendWebGL2,
  canvas: document.querySelector('#my-canvas')
});

myApp.ready().then(async () => {
  const scene = new Scene();
  scene.env.light.type = 'none';

  const canvasFontFamily = await loadCanvasFont();
  const textureLabel = createTextSprite(scene, canvasFontFamily);
  const fontAsset = await loadMSDFFontAsset();
  let msdfText = null;
  let msdfSprite = null;

  if (fontAsset) {
    msdfText = createMSDFText(scene, fontAsset);
    msdfSprite = createMSDFTextSprite(scene, fontAsset);
  } else {
    textureLabel.text = 'Font asset failed to load';
  }

  scene.mainCamera = new PerspectiveCamera(scene, Math.PI / 3, 0.1, 100);
  scene.mainCamera.lookAt(new Vector3(0, 0, 7), new Vector3(0, 0, 0), Vector3.axisPY());
  scene.mainCamera.controller = new OrbitCameraController({ center: Vector3.zero() });
  getInput().use(scene.mainCamera.handleEvent, scene.mainCamera);

  getEngine().setRenderable(scene, 0);

  myApp.on('tick', () => {
    const time = myApp.device.frameInfo.elapsedOverall * 0.001;
    textureLabel.rotation.fromEulerAngle(0, 0, Math.sin(time) * 0.08);
    if (msdfText) {
      msdfText.rotation.fromEulerAngle(0, Math.sin(time * 0.7) * 0.4, 0);
    }
    if (msdfSprite) {
      msdfSprite.position.setXYZ(2.15, -1.45 + Math.sin(time * 1.4) * 0.12, 0);
    }
  });

  myApp.run();
});

async function loadCanvasFont() {
  if (!('FontFace' in window) || !document.fonts) {
    return 'Arial';
  }
  try {
    const font = new FontFace('InterDemo', `url(${FONT_URL})`);
    await font.load();
    document.fonts.add(font);
    await document.fonts.ready;
    return 'InterDemo';
  } catch (err) {
    console.warn('Failed to load canvas font:', err);
    return 'Arial';
  }
}

async function loadMSDFFontAsset() {
  try {
    return await getEngine().resourceManager.fetchFontAsset(FONT_URL, {
      pageSize: 1024,
      glyphSize: 64
    });
  } catch (err) {
    console.warn('Failed to load MSDF font asset:', err);
    return null;
  }
}

function createTextSprite(scene, fontFamily) {
  const label = new TextSprite(scene);
  label.text = 'TextSprite\ncanvas texture';
  label.font = `bold 42px ${fontFamily}, Arial`;
  label.textColor = new Vector3(1, 0, 0);
  label.resolutionX = 512;
  label.resolutionY = 192;
  label.position.setXYZ(0, 1.55, 0);
  label.scale.setXYZ(4.6, 1.7, 1);
  return label;
}

function createMSDFText(scene, fontAsset) {
  const text = new MSDFText(scene);
  text.fontAsset = fontAsset;
  text.text = 'MSDFText\n3D transform';
  text.fontSize = 0.46;
  text.maxWidth = 4.5;
  text.textAlign = 'center';
  text.anchor = new Vector2(0.5, 0.5);
  text.textColor = new Vector3(0.45, 0.9, 1);
  text.outlineColor = new Vector3(0.01, 0.04, 0.08);
  text.outlineWidth = 0.025;
  text.position.setXYZ(-2.15, -0.55, 0);
  return text;
}

function createMSDFTextSprite(scene, fontAsset) {
  const text = new MSDFTextSprite(scene);
  text.fontAsset = fontAsset;
  text.text = 'MSDFTextSprite\nbillboard label';
  text.fontSize = 0.34;
  text.maxWidth = 3.7;
  text.textAlign = 'center';
  text.anchor = new Vector2(0.5, 0.5);
  text.textColor = new Vector3(1, 0.82, 0.35);
  text.outlineColor = new Vector3(0, 0, 0);
  text.outlineWidth = 0.02;
  text.position.setXYZ(2.15, -1.45, 0);
  return text;
}
