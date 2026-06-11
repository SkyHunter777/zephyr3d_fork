import { GUI } from 'lil-gui';
import type { Material, OrbitCameraController, PerspectiveCamera, SceneNode } from '@zephyr3d/scene';
import { BoundingBox, getDevice } from '@zephyr3d/scene';
import { FurMaterial } from './materials/fur';
import type { ParallaxMappingMode } from './materials/parallax';
import { ParallaxMapMaterial } from './materials/parallax';
import { WoodMaterial } from './materials/wood';
import { AABB, Vector3 } from '@zephyr3d/base';
import { ToonMaterial, type MToonOutlineWidthMode } from './materials/toon';

interface GUIParams {
  deviceType: string;
  material: string;
}

interface FurParams {
  layerCount: number;
  layerThickness: number;
  noiseRepeat: number;
}

interface ParallaxMapParams {
  mode: string;
  parallaxScale: number;
  minLayers: number;
  maxLayers: number;
}

interface WoodParams {
  distoredX: number;
  distoredY: number;
  distoredZ: number;
  density: number;
  lightColor: string;
  darkColor: string;
}

interface ToonParams {
  shadeColorFactor: string;
  shadingShiftFactor: number;
  shadingShiftTextureScale: number;
  shadingToonyFactor: number;
  giEqualizationFactor: number;
  matcapFactor: string;
  parametricRimColorFactor: string;
  parametricRimFresnelPowerFactor: number;
  parametricRimLiftFactor: number;
  rimLightingMixFactor: number;
  outlineWidthMode: MToonOutlineWidthMode;
  outlineWidthFactor: number;
  outlineColorFactor: string;
  outlineLightingMixFactor: number;
  transparentWithZWrite: boolean;
  renderQueueOffsetNumber: number;
  uvAnimationScrollXSpeedFactor: number;
  uvAnimationScrollYSpeedFactor: number;
  uvAnimationRotationSpeedFactor: number;
  emissiveColor: string;
  emissiveStrength: number;
}

export class Panel {
  private readonly _camera: PerspectiveCamera;
  private readonly _meshes: { node: SceneNode; material: Material; name: string; bbox?: AABB }[];
  private readonly _materialNames: string[];
  private _index: number;
  private readonly _parallaxModes: ParallaxMappingMode[];
  private readonly _deviceList: string[];
  private _furParams: FurParams;
  private _parallaxMapParams: ParallaxMapParams;
  private _woodParams: WoodParams;
  private _toonParams: ToonParams;
  private _materialGroup: GUI;
  private readonly _params: GUIParams;
  private readonly _gui: GUI;
  constructor(camera: PerspectiveCamera, meshes: { node: SceneNode; material: Material; name: string }[]) {
    this._camera = camera;
    this._deviceList = ['WebGL', 'WebGL2', 'WebGPU'];
    this._meshes = meshes;
    this._materialNames = this._meshes.map((val) => val.name);
    this._index = 0;
    this._params = {
      deviceType:
        this._deviceList[this._deviceList.findIndex((val) => val.toLowerCase() === getDevice().type)],
      material: this._materialNames[this._index]
    };
    this._parallaxModes = ['basic', 'steep', 'occlusion', 'relief'];
    this._gui = new GUI({ container: document.body });
    this._furParams = null;
    this._parallaxMapParams = null;
    this._woodParams = null;
    this._toonParams = null;
    this._materialGroup = null;
    this.updateMeshShowState();
    this.updateBoundingBoxes();
    this.lookAt();
    this.create();
  }
  updateBoundingBoxes() {
    for (let i = 0; i < this._meshes.length; i++) {
      const node = this._meshes[i].node;
      const bbox = new BoundingBox();
      bbox.beginExtend();
      node.iterate((node) => {
        if (node.isGraphNode()) {
          const aabb = node.getWorldBoundingVolume()?.toAABB();
          if (aabb && aabb.isValid()) {
            bbox.extend(aabb.minPoint);
            bbox.extend(aabb.maxPoint);
          }
        }
      });
      this._meshes[i].bbox = new AABB(
        bbox.minPoint.scaleBy(node.scale.x),
        bbox.maxPoint.scaleBy(node.scale.x)
      );
    }
  }
  lookAt() {
    const bbox = this._meshes[this._index].bbox;
    const center = bbox.center;
    const extents = bbox.extents;
    const size = Math.max(extents.x, extents.y);
    const dist = size / Math.tan(this._camera.fovY * 0.5) + extents.z + this._camera.near;

    this._camera.lookAt(Vector3.add(center, Vector3.scale(Vector3.axisPZ(), dist)), center, Vector3.axisPY());
    this._camera.near = Math.min(1, this._camera.near);
    this._camera.far = Math.max(10, dist + extents.z + Math.max(extents.x, extents.y, extents.z) * 8);
    (this._camera.controller as OrbitCameraController).setOptions({ center });
  }
  updateMeshShowState() {
    for (let i = 0; i < this._meshes.length; i++) {
      this._meshes[i].node.showState = i === this._index ? 'visible' : 'hidden';
    }
  }
  css2rgb(css: string): Vector3 {
    if (css[0] === '#') {
      const hex = css.slice(1);
      let r, g, b;
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else {
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
      }
      return new Vector3(r / 255, g / 255, b / 255);
    } else {
      const rgb = css.match(/\d+/g);
      return new Vector3(parseInt(rgb[0]) / 255, parseInt(rgb[1]) / 255, parseInt(rgb[2]) / 255);
    }
  }
  rgb2css(color: { x: number; y: number; z: number }): string {
    const r = Math.round(Math.min(Math.max(color.x, 0), 1) * 255);
    const g = Math.round(Math.min(Math.max(color.y, 0), 1) * 255);
    const b = Math.round(Math.min(Math.max(color.z, 0), 1) * 255);
    return `rgb(${r}, ${g}, ${b})`;
  }
  editWoodMaterial(material: WoodMaterial) {
    this._woodParams = {
      distoredX: material.distored.x,
      distoredY: material.distored.y,
      distoredZ: material.distored.z,
      darkColor: `rgb(${Math.floor(material.darkColor.x * 255)}, ${Math.floor(
        material.darkColor.y * 255
      )}, ${Math.floor(material.darkColor.z * 255)})`,
      lightColor: `rgb(${Math.floor(material.lightColor.x * 255)}, ${Math.floor(
        material.lightColor.y * 255
      )}, ${Math.floor(material.lightColor.z * 255)})`,
      density: material.density
    };
    this._materialGroup
      .add(this._woodParams, 'distoredX', 0, 100, 0.1)
      .name('Distored X')
      .onChange((value) => {
        material.distored.x = value;
        material.uniformChanged();
      });
    this._materialGroup
      .add(this._woodParams, 'distoredY', 0, 100, 0.1)
      .name('Distored Y')
      .onChange((value) => {
        material.distored.y = value;
        material.uniformChanged();
      });
    this._materialGroup
      .add(this._woodParams, 'distoredZ', 0, 100, 0.1)
      .name('Distored Z')
      .onChange((value) => {
        material.distored.z = value;
        material.uniformChanged();
      });
    this._materialGroup
      .add(this._woodParams, 'density', 0, 100, 0.1)
      .name('Density')
      .onChange((value) => {
        material.density = value;
      });
    this._materialGroup
      .addColor(this._woodParams, 'darkColor')
      .name('Dark color')
      .onChange((value) => {
        material.darkColor = this.css2rgb(value);
      });
    this._materialGroup
      .addColor(this._woodParams, 'lightColor')
      .name('Light color')
      .onChange((value) => {
        material.lightColor = this.css2rgb(value);
      });
  }
  editParallaxMaterial(material: ParallaxMapMaterial) {
    this._parallaxMapParams = {
      minLayers: material.minParallaxLayers,
      maxLayers: material.maxParallaxLayers,
      parallaxScale: material.parallaxScale,
      mode: material.mode
    };
    this._materialGroup
      .add(this._parallaxMapParams, 'mode', this._parallaxModes)
      .name('Mode')
      .onChange((value) => {
        material.mode = value;
      });
    this._materialGroup
      .add(this._parallaxMapParams, 'parallaxScale', 0, 1, 0.01)
      .name('Parallax scale')
      .onChange((value) => {
        material.parallaxScale = value;
      });
    this._materialGroup
      .add(this._parallaxMapParams, 'minLayers', 1, 100, 1)
      .name('Min layers')
      .onChange((value) => {
        material.minParallaxLayers = value;
      });
    this._materialGroup
      .add(this._parallaxMapParams, 'maxLayers', 1, 100, 1)
      .name('Max layers')
      .onChange((value) => {
        material.maxParallaxLayers = value;
      });
  }
  editToonMaterial(material: ToonMaterial) {
    this._toonParams = {
      shadeColorFactor: this.rgb2css(material.shadeColorFactor),
      shadingShiftFactor: material.shadingShiftFactor,
      shadingShiftTextureScale: material.shadingShiftTextureScale,
      shadingToonyFactor: material.shadingToonyFactor,
      giEqualizationFactor: material.giEqualizationFactor,
      matcapFactor: this.rgb2css(material.matcapFactor),
      parametricRimColorFactor: this.rgb2css(material.parametricRimColorFactor),
      parametricRimFresnelPowerFactor: material.parametricRimFresnelPowerFactor,
      parametricRimLiftFactor: material.parametricRimLiftFactor,
      rimLightingMixFactor: material.rimLightingMixFactor,
      outlineWidthMode: material.outlineWidthMode,
      outlineWidthFactor: material.outlineWidthFactor,
      outlineColorFactor: this.rgb2css(material.outlineColorFactor),
      outlineLightingMixFactor: material.outlineLightingMixFactor,
      transparentWithZWrite: material.transparentWithZWrite,
      renderQueueOffsetNumber: material.renderQueueOffsetNumber,
      uvAnimationScrollXSpeedFactor: material.uvAnimationScrollXSpeedFactor,
      uvAnimationScrollYSpeedFactor: material.uvAnimationScrollYSpeedFactor,
      uvAnimationRotationSpeedFactor: material.uvAnimationRotationSpeedFactor,
      emissiveColor: this.rgb2css(material.emissiveColor),
      emissiveStrength: material.emissiveStrength
    };

    const shading = this._materialGroup.addFolder('MToon Shading');
    shading
      .addColor(this._toonParams, 'shadeColorFactor')
      .name('Shade color')
      .onChange((value) => {
        material.shadeColorFactor = this.css2rgb(value);
      });
    shading
      .add(this._toonParams, 'shadingShiftFactor', -1, 1, 0.01)
      .name('Shading shift')
      .onChange((value) => {
        material.shadingShiftFactor = value;
      });
    shading
      .add(this._toonParams, 'shadingShiftTextureScale', -1, 1, 0.01)
      .name('Shift tex scale')
      .onChange((value) => {
        material.shadingShiftTextureScale = value;
      });
    shading
      .add(this._toonParams, 'shadingToonyFactor', 0, 0.99, 0.01)
      .name('Shading toony')
      .onChange((value) => {
        material.shadingToonyFactor = value;
      });
    shading
      .add(this._toonParams, 'giEqualizationFactor', 0, 1, 0.01)
      .name('GI equalization')
      .onChange((value) => {
        material.giEqualizationFactor = value;
      });

    const rim = this._materialGroup.addFolder('MToon Rim');
    rim
      .addColor(this._toonParams, 'matcapFactor')
      .name('MatCap factor')
      .onChange((value) => {
        material.matcapFactor = this.css2rgb(value);
      });
    rim
      .addColor(this._toonParams, 'parametricRimColorFactor')
      .name('Rim color')
      .onChange((value) => {
        material.parametricRimColorFactor = this.css2rgb(value);
      });
    rim
      .add(this._toonParams, 'parametricRimFresnelPowerFactor', 0, 20, 0.1)
      .name('Rim power')
      .onChange((value) => {
        material.parametricRimFresnelPowerFactor = value;
      });
    rim
      .add(this._toonParams, 'parametricRimLiftFactor', -1, 1, 0.01)
      .name('Rim lift')
      .onChange((value) => {
        material.parametricRimLiftFactor = value;
      });
    rim
      .add(this._toonParams, 'rimLightingMixFactor', 0, 1, 0.01)
      .name('Rim lighting mix')
      .onChange((value) => {
        material.rimLightingMixFactor = value;
      });

    const outline = this._materialGroup.addFolder('MToon Outline');
    outline
      .add(this._toonParams, 'outlineWidthMode', [
        'none',
        'worldCoordinates',
        'screenCoordinates'
      ] satisfies MToonOutlineWidthMode[])
      .name('Width mode')
      .onChange((value: MToonOutlineWidthMode) => {
        material.outlineWidthMode = value;
      });
    outline
      .add(this._toonParams, 'outlineWidthFactor', 0, 1, 0.0005)
      .name('Width factor')
      .onChange((value) => {
        material.outlineWidthFactor = value;
      });
    outline
      .addColor(this._toonParams, 'outlineColorFactor')
      .name('Outline color')
      .onChange((value) => {
        material.outlineColorFactor = this.css2rgb(value);
      });
    outline
      .add(this._toonParams, 'outlineLightingMixFactor', 0, 1, 0.01)
      .name('Lighting mix')
      .onChange((value) => {
        material.outlineLightingMixFactor = value;
      });

    const uvAnimation = this._materialGroup.addFolder('MToon UV Animation');
    uvAnimation
      .add(this._toonParams, 'uvAnimationScrollXSpeedFactor', -2, 2, 0.01)
      .name('Scroll X')
      .onChange((value) => {
        material.uvAnimationScrollXSpeedFactor = value;
      });
    uvAnimation
      .add(this._toonParams, 'uvAnimationScrollYSpeedFactor', -2, 2, 0.01)
      .name('Scroll Y')
      .onChange((value) => {
        material.uvAnimationScrollYSpeedFactor = value;
      });
    uvAnimation
      .add(this._toonParams, 'uvAnimationRotationSpeedFactor', -6.28, 6.28, 0.01)
      .name('Rotation speed')
      .onChange((value) => {
        material.uvAnimationRotationSpeedFactor = value;
      });

    const emission = this._materialGroup.addFolder('MToon Emission');
    emission
      .addColor(this._toonParams, 'emissiveColor')
      .name('Color')
      .onChange((value) => {
        material.emissiveColor = this.css2rgb(value);
      });
    emission
      .add(this._toonParams, 'emissiveStrength', 0, 10, 0.01)
      .name('Strength')
      .onChange((value) => {
        material.emissiveStrength = value;
      });

    const rendering = this._materialGroup.addFolder('MToon Rendering');
    rendering
      .add(this._toonParams, 'transparentWithZWrite')
      .name('Transparent z write')
      .onChange((value) => {
        material.transparentWithZWrite = value;
      });
    rendering
      .add(this._toonParams, 'renderQueueOffsetNumber', -9, 9, 1)
      .name('Queue offset')
      .onChange((value) => {
        material.renderQueueOffsetNumber = value;
      });
  }
  editFurMaterial(material: FurMaterial) {
    this._furParams = {
      layerCount: material.numLayers,
      layerThickness: material.thickness,
      noiseRepeat: material.noiseRepeat
    };
    this._materialGroup
      .add(this._furParams, 'layerCount', 1, 100, 1)
      .name('Layer count')
      .onChange((value) => {
        material.numLayers = value;
      });
    this._materialGroup
      .add(this._furParams, 'layerThickness', 0, 0.5, 0.01)
      .name('Layer thickness')
      .onChange((value) => {
        material.thickness = value;
      });
    this._materialGroup
      .add(this._furParams, 'noiseRepeat', 1, 32, 1)
      .name('Noise repeat')
      .onChange((value) => {
        material.noiseRepeat = value;
      });
    /*
    const colorStart = {
      r: material.colorStart.x,
      g: material.colorStart.y,
      b: material.colorStart.z,
      a: material.colorStart.w
    };
    if (ImGui.ColorEdit4('AO start', colorStart)){
      material.colorStart = new Vector4(colorStart.r, colorStart.g, colorStart.b, colorStart.a);
    }
    const colorEnd = {
      r: material.colorEnd.x,
      g: material.colorEnd.y,
      b: material.colorEnd.z,
      a: material.colorEnd.w
    };
    if (ImGui.ColorEdit4('AO end', colorEnd)){
      material.colorEnd = new Vector4(colorEnd.r, colorEnd.g, colorEnd.b, colorEnd.a);
    }
    */
  }
  create() {
    const systemSettings = this._gui.addFolder('System');
    systemSettings
      .add(this._params, 'deviceType', this._deviceList)
      .name('Select device')
      .onChange((value) => {
        const url = new URL(window.location.href);
        url.searchParams.set('dev', value.toLowerCase());
        window.location.href = url.href;
      });
    this.updateMaterialGroup();
  }
  updateMaterialGroup() {
    if (this._materialGroup) {
      this._materialGroup.destroy();
    }
    this._materialGroup = this._gui.addFolder('Material');
    this._materialGroup
      .add(this._params, 'material', this._materialNames)
      .name('Select material')
      .onChange((value) => {
        this._params.material = value;
        this._index = this._materialNames.indexOf(value);
        this.updateMaterialGroup();
      });
    this.updateMeshShowState();
    this.lookAt();
    const material = this._meshes[this._index].material;
    if (material instanceof FurMaterial) {
      this.editFurMaterial(material);
    } else if (material instanceof ParallaxMapMaterial) {
      this.editParallaxMaterial(material);
    } else if (material instanceof WoodMaterial) {
      this.editWoodMaterial(material);
    } else if (material instanceof ToonMaterial) {
      this.editToonMaterial(material);
    }
  }
}
