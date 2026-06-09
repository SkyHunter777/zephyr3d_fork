import { LightPass } from './lightpass';
import { ShadowMapPass } from './shadowmap_pass';
import { DepthPass } from './depthpass';
import type { Nullable } from '@zephyr3d/base';
import {
  Quaternion,
  degree2radian,
  isPowerOf2,
  Matrix4x4,
  nextPowerOf2,
  Vector3,
  Vector4
} from '@zephyr3d/base';
import type {
  BindGroup,
  ColorState,
  FrameBuffer,
  GPUDataBuffer,
  GPUProgram,
  Texture2D,
  TextureFormat
} from '@zephyr3d/device';
import { CopyBlitter } from '../blitter';
import type { DrawContext } from './drawable';
import { RenderQueue } from './render_queue';
import type { PunctualLight, Scene } from '../scene';
import { type PickResult, Camera } from '../camera';
import { AbstractPostEffect, PostEffectLayer } from '../posteffect/posteffect';
import { ClusteredLight } from './cluster_light';
import { GlobalBindGroupAllocator } from './globalbindgroup_allocator';
import { ObjectColorPass } from './objectcolorpass';
import { buildHiZ } from './hzb';
import { MaterialVaryingFlags } from '../values';
import { fetchSampler } from '../utility/misc';
import type { Primitive } from '.';
import { BoxShape } from '../shapes';
import { getDevice } from '../app/api';
import type { RenderItemList, RenderItemListInfo, RenderQueueItem } from './render_queue';
import { executeForwardPlusGraph } from './rendergraph/forward_plus_builder';

const tmpSkyScale = new Vector3();
const tmpSkyPosition = new Vector3();
const tmpSkyRootRotation = new Quaternion();
const tmpSkyExtraRotation = new Quaternion();
const tmpSkyFinalRotation = new Quaternion();
const tmpSkyWorldMatrix = Matrix4x4.identity();

/**
 * Forward render scheme
 * @internal
 */
export class SceneRenderer {
  /** @internal */
  private static _skyMotionVectorProgram: Nullable<GPUProgram> = null;
  /** @internal */
  private static _skyMotionVectorBindGroup: Nullable<BindGroup> = null;
  private static _box: Nullable<Primitive> = null;
  private static readonly _ssrSDFMaxBoxes = 24;
  private static _ssrSDFBoxBuffer: Nullable<GPUDataBuffer> = null;
  private static _ssrSDFBoxData: Nullable<Float32Array> = null;
  /** @internal */
  private static readonly _pickCamera = new Camera(null);
  /** @internal */
  private static readonly _scenePass = new LightPass();
  /** @internal */
  private static readonly _depthPass = new DepthPass();
  /** @internal */
  private static readonly _shadowMapPass = new ShadowMapPass();
  /** @internal */
  private static readonly _objectColorPass = new ObjectColorPass();
  /** @internal */
  private static _frontDepthColorState: Nullable<ColorState> = null;
  /** @internal */
  private static _backDepthColorState: Nullable<ColorState> = null;
  /** @internal */
  private static readonly _clusters: ClusteredLight[] = [];
  /** lighting render pass */
  static get sceneRenderPass() {
    return this._scenePass;
  }
  /** depth render pass */
  static get depthRenderPass() {
    return this._depthPass;
  }
  /** shadow map render pass */
  static get shadowMapRenderPass() {
    return this._shadowMapPass;
  }
  /** @internal */
  static getClusteredLight() {
    if (this._clusters.length > 0) {
      return this._clusters.pop()!;
    }
    return new ClusteredLight();
  }
  /** @internal */
  static freeClusteredLight(clusteredLight: ClusteredLight) {
    this._clusters.push(clusteredLight);
  }
  /**
   * Renders a scene by given camera
   * @param scene - The scene tondered
   * @param camera - The camera that will be used to render the scene
   * @param compositor - The compositor that will be used to apply postprocess effects
   */
  static renderScene(scene: Scene, camera: Camera): void {
    const device = getDevice();
    const colorFormat =
      camera.HDR && device.getDeviceCaps().textureCaps.supportHalfFloatColorBuffer ? 'rgba16f' : 'rgba8unorm';
    const halfFloatColorBuffer = device.getDeviceCaps().textureCaps.supportHalfFloatColorBuffer;
    const depthFormat = device.getDeviceCaps().framebufferCaps.supportDepth32floatStencil8
      ? 'd32fs8'
      : 'd24s8';
    const globalBindGroupAllocator = GlobalBindGroupAllocator.get();
    scene.frameUpdate();
    scene.frameUpdatePerCamera(camera);
    if (camera && !device.isContextLost()) {
      const defaultViewport = (!camera.TAA || device.type === 'webgl') && !camera.viewport && !camera.scissor;
      const renderX = camera.viewport ? device.screenXToDevice(camera.viewport[0]) : 0;
      const renderY = camera.viewport ? device.screenYToDevice(camera.viewport[1]) : 0;
      const renderWidth = camera.viewport
        ? device.screenXToDevice(camera.viewport[2])
        : device.getDrawingBufferWidth();
      const renderHeight = camera.viewport
        ? device.screenYToDevice(camera.viewport[3])
        : device.getDrawingBufferHeight();
      if (renderWidth <= 0 || renderHeight <= 0) {
        camera.getPickResultResolveFunc()?.(null);
        return;
      }
      const tmpFramebuffer = defaultViewport
        ? null
        : device.pool.fetchTemporalFramebuffer(false, renderWidth, renderHeight, colorFormat, depthFormat);
      const originFramebuffer = device.getFramebuffer();
      if (tmpFramebuffer) {
        device.pushDeviceStates();
        device.setFramebuffer(tmpFramebuffer);
      }
      device.clearFrameBuffer(camera.clearColor, camera.clearDepth, camera.clearStencil);
      const SSR = camera.SSR && scene.env.light.envLight && scene.env.light.envLight.hasRadiance();
      const SSS = camera.SSS;
      const needSurfaceMRT = SSR;
      const needSSSRoughness = SSR;
      const glossySurfaceFormat: TextureFormat = halfFloatColorBuffer ? 'rgba16f' : 'rgba8unorm';
      const ctx: DrawContext = {
        device,
        scene,
        renderWidth,
        renderHeight,
        oit: null,
        motionVectors:
          device.type !== 'webgl' && (camera.TAA || camera.motionBlur || (camera.SSR && camera.ssrTemporal)),
        HiZ: camera.HiZ && device.type !== 'webgl',
        HiZTexture: null,
        globalBindGroupAllocator,
        camera,
        compositor: camera.compositor,
        queue: 0,
        lightBlending: false,
        renderPass: null,
        renderPassHash: null,
        flip: false,
        depthFormat,
        colorFormat,
        drawEnvLight: false,
        env: null,
        sunLight: null,
        primaryDirectionalLight: null,
        primaryTransmissionLight: null,
        materialFlags: 0,
        SSR,
        SSS,
        SSRCalcThickness: SSR && camera.ssrCalcThickness,
        SSRRoughnessTexture: needSSSRoughness
          ? device.pool.fetchTemporalTexture2D(true, glossySurfaceFormat, renderWidth, renderHeight)
          : null,
        SSRNormalTexture: needSurfaceMRT
          ? device.pool.fetchTemporalTexture2D(true, glossySurfaceFormat, renderWidth, renderHeight)
          : null,
        SSSProfileTexture: null,
        SSSParamTexture: null,
        SSSDiffuseTexture: null,
        SSSTransmissionTexture: null,
        ssrSDFBoxBuffer: null,
        ssrSDFBoxCount: 0,
        finalFramebuffer: device.getFramebuffer(),
        intermediateFramebuffer: null
      };
      this._renderSceneByPath(ctx);
      if (tmpFramebuffer) {
        device.popDeviceStates();
        const oversizedViewport =
          renderX < 0 ||
          renderY < 0 ||
          renderX + renderWidth > device.getDrawingBufferWidth() ||
          renderY + renderHeight > device.getDrawingBufferHeight();
        const blitter = new CopyBlitter();
        if (oversizedViewport) {
          blitter.destRect = [renderX, renderY, renderWidth, renderHeight];
        } else {
          blitter.viewport = camera.viewport ? camera.viewport.slice() : null;
        }
        blitter.scissor = camera.scissor ? camera.scissor.slice() : null;
        blitter.srgbOut = !originFramebuffer;
        blitter.blit(
          tmpFramebuffer.getColorAttachments()[0],
          originFramebuffer ?? null,
          fetchSampler('clamp_nearest_nomip')
        );
        device.pool.releaseFrameBuffer(tmpFramebuffer);
      }
    }
    GlobalBindGroupAllocator.release(globalBindGroupAllocator);
  }
  /** @internal */
  private static getLightPassColorAttachments(ctx: DrawContext, colorAttachment: TextureFormat | Texture2D) {
    const attachments: (TextureFormat | Texture2D)[] = [colorAttachment];
    if (ctx.materialFlags & MaterialVaryingFlags.SSR_STORE_ROUGHNESS) {
      attachments.push(ctx.SSRRoughnessTexture!, ctx.SSRNormalTexture!);
    } else if (ctx.materialFlags & MaterialVaryingFlags.SSS_STORE_NORMAL) {
      attachments.push(ctx.SSRNormalTexture!);
    }
    if (ctx.materialFlags & MaterialVaryingFlags.SSS_STORE_PROFILE) {
      attachments.push(ctx.SSSProfileTexture!, ctx.SSSParamTexture!);
    }
    if (ctx.materialFlags & MaterialVaryingFlags.SSS_STORE_DIFFUSE) {
      attachments.push(ctx.SSSDiffuseTexture!);
    }
    if (ctx.materialFlags & MaterialVaryingFlags.SSS_STORE_TRANSMISSION) {
      attachments.push(ctx.SSSTransmissionTexture!);
    }
    return attachments.length === 1 ? attachments[0] : attachments;
  }
  private static renderSceneDepth(
    ctx: DrawContext,
    renderQueue: RenderQueue,
    depthFramebuffer: Nullable<FrameBuffer>
  ) {
    const transmission = !!depthFramebuffer;
    if (!depthFramebuffer) {
      const format: TextureFormat =
        ctx.device.type === 'webgl'
          ? ctx.SSRCalcThickness
            ? 'rgba16f'
            : 'rgba8unorm'
          : ctx.SSRCalcThickness
            ? 'rg32f'
            : 'r32f';
      const mvFormat: TextureFormat = 'rgba16f';
      if (!ctx.finalFramebuffer) {
        depthFramebuffer = ctx.device.pool.fetchTemporalFramebuffer(
          true,
          ctx.renderWidth,
          ctx.renderHeight,
          ctx.motionVectors ? [format, mvFormat] : format,
          ctx.depthFormat,
          false
        );
      } else {
        const originDepth = ctx.finalFramebuffer?.getDepthAttachment();
        depthFramebuffer = originDepth?.isTexture2D()
          ? ctx.device.pool.fetchTemporalFramebuffer(
              true,
              originDepth.width,
              originDepth.height,
              ctx.motionVectors ? [format, mvFormat] : format,
              originDepth,
              false
            )
          : ctx.device.pool.fetchTemporalFramebuffer(
              true,
              ctx.renderWidth,
              ctx.renderHeight,
              ctx.motionVectors ? [format, mvFormat] : format,
              ctx.depthFormat,
              false
            );
      }
    }
    ctx.device.pushDeviceStates();
    ctx.device.setFramebuffer(depthFramebuffer);
    this._depthPass.encodeDepth = depthFramebuffer.getColorAttachments()[0].format === 'rgba8unorm';
    this._depthPass.clearColor = transmission
      ? null
      : this._depthPass.encodeDepth
        ? new Vector4(0, 0, 0, 1)
        : new Vector4(1, 1, 1, 1);
    this._depthPass.clearDepth = transmission ? null : 1;
    this._depthPass.clearStencil = null;
    this._depthPass.transmission = transmission;
    if (ctx.SSRCalcThickness && !transmission) {
      if (!this._backDepthColorState) {
        this._backDepthColorState = ctx.device.createColorState().setColorMask(false, true, false, false);
      }
      if (!this._frontDepthColorState) {
        this._frontDepthColorState = ctx.device.createColorState().setColorMask(true, false, false, false);
      }
      ctx.forceColorState = this._backDepthColorState;
      ctx.forceCullMode = 'front';
      this._depthPass.renderBackface = true;
      this._depthPass.transmission = false;
      this._depthPass.render(ctx, null, null, renderQueue);
      this._depthPass.clearColor = null;
      this._depthPass.renderBackface = false;
      ctx.forceColorState = this._frontDepthColorState;
      ctx.forceCullMode = null;
    }
    this._depthPass.render(ctx, null, null, renderQueue);
    ctx.forceColorState = null;
    ctx.device.popDeviceStates();

    if (!transmission) {
      ctx.motionVectorTexture = ctx.motionVectors
        ? (depthFramebuffer.getColorAttachments()[1] as Texture2D)
        : null;
      ctx.linearDepthTexture = depthFramebuffer.getColorAttachments()[0] as Texture2D;
      ctx.depthTexture = depthFramebuffer.getDepthAttachment() as Texture2D;
      if (ctx.motionVectorTexture) {
        this.renderSkyMotionVectors(ctx);
      }
      if (ctx.HiZ) {
        let w = isPowerOf2(ctx.linearDepthTexture.width)
          ? ctx.linearDepthTexture.width
          : nextPowerOf2(ctx.linearDepthTexture.width);
        let h = isPowerOf2(ctx.linearDepthTexture.height)
          ? ctx.linearDepthTexture.height
          : nextPowerOf2(ctx.linearDepthTexture.height);
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        w = ctx.linearDepthTexture.width;
        h = ctx.linearDepthTexture.height;
        const HiZFrameBuffer = ctx.device.pool.fetchTemporalFramebuffer(
          true,
          w,
          h,
          ctx.linearDepthTexture.format,
          null,
          true
        );
        buildHiZ(ctx.depthTexture, HiZFrameBuffer);
        ctx.HiZTexture = HiZFrameBuffer.getColorAttachments()[0] as Texture2D;
      }
    }
    return depthFramebuffer;
  }
  /** @internal */
  protected static _renderSceneByPath(ctx: DrawContext) {
    executeForwardPlusGraph(ctx);
  }
  /** @internal */
  protected static _renderSceneForward(ctx: DrawContext) {
    const device = ctx.device;

    // Cull scene
    const renderQueue = this._scenePass.cullScene(ctx, ctx.camera);
    ctx.SSS = !!ctx.SSS && this.renderQueueHasActiveSSS(renderQueue);
    this.prepareSSRProxySDF(ctx, renderQueue);

    // Keep sky world matrix synchronized before sky.update(), so skybox rotation
    // also affects baked radiance/irradiance lighting.
    if (ctx.scene.env.sky.skyType === 'skybox') {
      const skyboxRotation = ctx.scene.env.sky.skyboxRotation;
      ctx.scene.rootNode.worldMatrix.decompose(tmpSkyScale, tmpSkyRootRotation, tmpSkyPosition);
      tmpSkyExtraRotation.fromEulerAngle(
        degree2radian(skyboxRotation.x),
        degree2radian(skyboxRotation.y),
        degree2radian(skyboxRotation.z)
      );
      Quaternion.multiply(tmpSkyRootRotation, tmpSkyExtraRotation, tmpSkyFinalRotation);
      tmpSkyWorldMatrix.compose(tmpSkyScale, tmpSkyFinalRotation, tmpSkyPosition);
      ctx.scene.env.sky.skyWorldMatrix = tmpSkyWorldMatrix;
    } else {
      ctx.scene.env.sky.skyWorldMatrix = ctx.scene.rootNode.worldMatrix;
    }

    // Update sky
    const sunLightColor = ctx.scene.env.sky.update(ctx);

    // Gather lights
    ctx.clusteredLight = this.getClusteredLight();
    ctx.clusteredLight.calculateLightIndex(ctx.camera, renderQueue);

    // Do GPU ray picking if required
    const pickResolveFunc = ctx.camera.getPickResultResolveFunc();
    if (pickResolveFunc) {
      this.renderObjectColors(ctx, pickResolveFunc, renderQueue);
    }

    // Render shadow maps
    this.renderShadowMaps(ctx, renderQueue.shadowedLights);

    // Render scene depth first (opaque only)
    const depthFramebuffer = this.renderSceneDepth(ctx, renderQueue, null);
    // When SSR is enabled and scene-color-dependent materials exist (e.g. transmission),
    // make sure their depth is present before SSR runs to avoid depth/normal mismatch artifacts.
    // Transmission depth prepass for SSR can corrupt depth-dependent scene-color materials
    // (e.g. water that samples linear depth for refraction), because their depth gets written
    // before the opaque color pass and then incorrectly occludes opaque replay.
    // Only enable this workaround for scene-color materials that do NOT also depend on scene depth.
    const needsTransmissionDepthForSSR =
      !!ctx.SSR && renderQueue.needSceneColor() && !renderQueue.needSceneColorWithDepth();
    if (needsTransmissionDepthForSSR) {
      this.renderSceneDepth(ctx, renderQueue, depthFramebuffer);
    }
    if (ctx.depthTexture === ctx.finalFramebuffer?.getDepthAttachment()) {
      ctx.intermediateFramebuffer = ctx.finalFramebuffer;
    } else {
      // TODO: fetch resizable framebuffer if ctx.defaultViewport is true
      ctx.intermediateFramebuffer = device.pool.fetchTemporalFramebuffer(
        false,
        ctx.depthTexture!.width,
        ctx.depthTexture!.height,
        ctx.colorFormat!,
        ctx.depthTexture
      );
    }
    if (ctx.intermediateFramebuffer && ctx.intermediateFramebuffer !== ctx.finalFramebuffer) {
      device.pushDeviceStates();
      device.setFramebuffer(ctx.intermediateFramebuffer);
    } else {
      device.setViewport(null);
      device.setScissor(null);
    }
    // LightPass mutates clearColor to null for transmission/scene-color replay.
    // Restore the opaque clear each frame so auxiliary MRTs (SSS/SSR) never keep stale data.
    this._scenePass.clearColor = Vector4.zero();
    this._scenePass.transmission = false; // transmission
    this._scenePass.clearDepth = ctx.depthTexture ? null : 1;
    this._scenePass.clearStencil = ctx.depthTexture ? null : 0;
    if (ctx.SSR) {
      // SSR requires roughness/spec response and normals from the light pass.
      ctx.materialFlags |= MaterialVaryingFlags.SSR_STORE_ROUGHNESS;
    }
    if (ctx.SSS) {
      ctx.materialFlags |= MaterialVaryingFlags.SSS_STORE_DIFFUSE;
    }
    ctx.compositor?.begin(ctx);
    if (ctx.SSS) {
      this.renderForwardSSSProfile(ctx, renderQueue);
    }
    if (renderQueue.needSceneColor()) {
      const compositor = ctx.compositor;
      ctx.compositor = null;
      const sceneColorFramebuffer = device.pool.fetchTemporalFramebuffer(
        true,
        ctx.depthTexture!.width,
        ctx.depthTexture!.height,
        this.getLightPassColorAttachments(ctx, ctx.colorFormat!),
        ctx.depthTexture,
        false
      );
      device.pushDeviceStates();
      device.setFramebuffer(sceneColorFramebuffer);
      this._scenePass.transmission = false;
      this._scenePass.render(ctx, null, null, renderQueue);
      device.popDeviceStates();
      ctx.sceneColorTexture = sceneColorFramebuffer.getColorAttachments()[0] as Texture2D;
      const currentFramebuffer = device.getFramebuffer();
      let blitFramebuffer = currentFramebuffer ?? null;
      if (currentFramebuffer && currentFramebuffer.getColorAttachments().length > 1) {
        const primaryColor = currentFramebuffer.getColorAttachments()[0] as Texture2D;
        blitFramebuffer = device.pool.fetchTemporalFramebuffer(
          false,
          primaryColor.width,
          primaryColor.height,
          primaryColor,
          currentFramebuffer.getDepthAttachment() ?? null
        );
      }
      new CopyBlitter().blit(ctx.sceneColorTexture, blitFramebuffer, fetchSampler('clamp_nearest_nomip'));
      if (blitFramebuffer && blitFramebuffer !== currentFramebuffer) {
        device.pool.releaseFrameBuffer(blitFramebuffer);
      }
      ctx.compositor = compositor;
      this._scenePass.transmission = true;
      this._scenePass.clearColor = null;
      this._scenePass.clearDepth = null;
      this._scenePass.clearStencil = null;
    }
    this._scenePass.render(ctx, null, null, renderQueue);
    if (renderQueue.needSceneColor() && !needsTransmissionDepthForSSR) {
      this.renderSceneDepth(ctx, renderQueue, depthFramebuffer);
    }
    ctx.compositor?.drawPostEffects(ctx, PostEffectLayer.end, ctx.linearDepthTexture!);
    ctx.compositor?.end(ctx);
    renderQueue.dispose();
    ctx.materialFlags &= ~MaterialVaryingFlags.SSR_STORE_ROUGHNESS;
    ctx.materialFlags &= ~MaterialVaryingFlags.SSS_STORE_PROFILE;
    ctx.materialFlags &= ~MaterialVaryingFlags.SSS_STORE_DIFFUSE;
    ctx.materialFlags &= ~MaterialVaryingFlags.SSS_STORE_NORMAL;
    ctx.materialFlags &= ~MaterialVaryingFlags.SSS_STORE_TRANSMISSION;

    if (ctx.intermediateFramebuffer && ctx.intermediateFramebuffer !== ctx.finalFramebuffer) {
      const blitter = new CopyBlitter();
      blitter.srgbOut = !ctx.finalFramebuffer;
      const srcTex = ctx.intermediateFramebuffer.getColorAttachments()[0] as Texture2D;
      blitter.blit(srcTex, ctx.finalFramebuffer ?? null, fetchSampler('clamp_nearest_nomip'));
      device.popDeviceStates();
      device.pool.releaseFrameBuffer(ctx.intermediateFramebuffer);
    }
    //ShadowMapper.releaseTemporalResources(ctx);
    this.freeClusteredLight(ctx.clusteredLight);

    // Restore sun color
    if (sunLightColor) {
      ctx.sunLight!.color = sunLightColor;
    }
  }
  private static renderForwardSSSProfile(ctx: DrawContext, renderQueue: RenderQueue) {
    if (!ctx.SSSProfileTexture || !ctx.SSSParamTexture || !ctx.depthTexture) {
      return;
    }
    const sssRenderQueue = this.createActualSSSRenderQueue(renderQueue);
    if (!sssRenderQueue) {
      return;
    }
    const device = ctx.device;
    const profileAttachments: (TextureFormat | Texture2D)[] = [ctx.colorFormat!];
    let profileFlags = MaterialVaryingFlags.SSS_STORE_PROFILE;
    // In hybrid/deferred we already have a valid full-screen normal buffer.
    // Reusing the shared SSR normal target here would clear non-SSS pixels and
    // corrupt later SSR/SSS shading for unrelated glossy/metal materials.
    const profileNormalTexture = ctx.SSRNormalTexture;
    const shouldWriteProfileNormals = !!profileNormalTexture;
    if (shouldWriteProfileNormals) {
      profileFlags |= MaterialVaryingFlags.SSS_STORE_NORMAL;
      profileAttachments.push(profileNormalTexture);
    }
    profileAttachments.push(ctx.SSSProfileTexture, ctx.SSSParamTexture);
    const profileFramebuffer = device.pool.fetchTemporalFramebuffer(
      false,
      ctx.depthTexture.width,
      ctx.depthTexture.height,
      profileAttachments,
      ctx.depthTexture,
      false
    );
    const savedMaterialFlags = ctx.materialFlags;
    const savedCompositor = ctx.compositor;
    const savedTransmission = this._scenePass.transmission;
    const savedRenderOpaque = this._scenePass.renderOpaque;
    const savedRenderTransparent = this._scenePass.renderTransparent;
    const savedClearColor = this._scenePass.clearColor;
    const savedClearDepth = this._scenePass.clearDepth;
    const savedClearStencil = this._scenePass.clearStencil;
    const savedCommandBufferReuse = ctx.camera.commandBufferReuse;
    device.pushDeviceStates();
    device.setFramebuffer(profileFramebuffer);
    ctx.compositor = null;
    ctx.camera.commandBufferReuse = false;
    ctx.materialFlags =
      (ctx.materialFlags &
        ~(
          MaterialVaryingFlags.SSR_STORE_ROUGHNESS |
          MaterialVaryingFlags.SSS_STORE_PROFILE |
          MaterialVaryingFlags.SSS_STORE_NORMAL |
          MaterialVaryingFlags.SSS_STORE_DIFFUSE |
          MaterialVaryingFlags.SSS_STORE_TRANSMISSION
        )) |
      profileFlags;
    this._scenePass.transmission = false;
    this._scenePass.renderOpaque = true;
    this._scenePass.renderTransparent = false;
    this._scenePass.clearColor = Vector4.zero();
    this._scenePass.clearDepth = null;
    this._scenePass.clearStencil = null;
    this._scenePass.render(ctx, null, null, sssRenderQueue);
    this._scenePass.clearColor = savedClearColor;
    this._scenePass.clearDepth = savedClearDepth;
    this._scenePass.clearStencil = savedClearStencil;
    this._scenePass.renderTransparent = savedRenderTransparent;
    this._scenePass.renderOpaque = savedRenderOpaque;
    this._scenePass.transmission = savedTransmission;
    ctx.camera.commandBufferReuse = savedCommandBufferReuse;
    ctx.materialFlags = savedMaterialFlags;
    ctx.compositor = savedCompositor;
    device.popDeviceStates();
    device.pool.releaseFrameBuffer(profileFramebuffer);
    sssRenderQueue.dispose();
  }
  private static renderQueueHasActiveSSS(renderQueue: RenderQueue) {
    const itemList = renderQueue.itemList;
    if (!itemList) {
      return false;
    }
    const lists = [
      ...itemList.opaque.lit,
      ...itemList.opaque.unlit,
      ...itemList.transmission.lit,
      ...itemList.transmission.unlit,
      ...itemList.transparent.lit,
      ...itemList.transparent.unlit,
      ...itemList.transmission_trans.lit,
      ...itemList.transmission_trans.unlit
    ];
    for (const list of lists) {
      for (const material of list.materialList) {
        const sssMaterial = material as unknown as {
          subsurfaceProfile?: unknown;
        };
        if (sssMaterial.subsurfaceProfile) {
          return true;
        }
      }
    }
    return false;
  }
  private static filterActualSSSItemList(items: RenderQueueItem[]) {
    return items.filter((item) => this.hasSSSMaterialCore(item.drawable.getMaterial?.()));
  }
  private static filterActualSSSMaterialList(materialList: Set<any>) {
    const filtered = new Set<any>();
    materialList.forEach((mat) => {
      if (this.hasSSSMaterialCore(mat)) {
        filtered.add(mat);
      }
    });
    return filtered;
  }
  private static cloneActualSSSListInfo(
    source: RenderItemListInfo,
    _targetQueue: RenderQueue
  ): RenderItemListInfo {
    return {
      itemList: this.filterActualSSSItemList(source.itemList),
      skinItemList: this.filterActualSSSItemList(source.skinItemList),
      morphItemList: this.filterActualSSSItemList(source.morphItemList),
      skinAndMorphItemList: this.filterActualSSSItemList(source.skinAndMorphItemList),
      instanceItemList: this.filterActualSSSItemList(source.instanceItemList),
      materialList: this.filterActualSSSMaterialList(source.materialList),
      instanceList: {},
      renderQueue: source.renderQueue
    };
  }
  private static cloneActualSSSBundle(
    source: RenderItemList['opaque'],
    targetQueue: RenderQueue
  ): RenderItemList['opaque'] {
    return {
      lit: source.lit.map((info) => this.cloneActualSSSListInfo(info, targetQueue)),
      unlit: source.unlit.map((info) => this.cloneActualSSSListInfo(info, targetQueue))
    };
  }
  private static createActualSSSRenderQueue(renderQueue: RenderQueue) {
    const itemList = renderQueue.itemList;
    if (!itemList) {
      return null;
    }
    const queue = new RenderQueue(this._scenePass);
    const sssOpaque = this.cloneActualSSSBundle(itemList.opaque, queue);
    if (!this.hasAnyActualSSSItems([...sssOpaque.lit, ...sssOpaque.unlit])) {
      queue.dispose();
      return null;
    }
    const emptyBundle = { lit: [], unlit: [] };
    const target = queue as unknown as {
      _itemList: RenderItemList;
      _shadowedLightList: PunctualLight[];
      _unshadowedLightList: PunctualLight[];
      _sunLight: typeof renderQueue.sunLight;
      _primaryDirectionalLight: typeof renderQueue.primaryDirectionalLight;
      _primaryTransmissionLight: typeof renderQueue.primaryTransmissionLight;
      _needSceneColor: boolean;
      _needSceneDepth: boolean;
      _needSceneColorWithDepth: boolean;
      _drawTransparent: boolean;
    };
    target._itemList = {
      opaque: sssOpaque,
      transmission: emptyBundle,
      transparent: emptyBundle,
      transmission_trans: emptyBundle
    };
    target._shadowedLightList = renderQueue.shadowedLights;
    target._unshadowedLightList = renderQueue.unshadowedLights;
    target._sunLight = renderQueue.sunLight;
    target._primaryDirectionalLight = renderQueue.primaryDirectionalLight;
    target._primaryTransmissionLight = renderQueue.primaryTransmissionLight;
    target._needSceneColor = false;
    target._needSceneDepth = false;
    target._needSceneColorWithDepth = false;
    target._drawTransparent = false;
    return queue;
  }
  private static hasAnyActualSSSItems(renderItems: RenderItemListInfo[]) {
    return renderItems.some(
      (info) =>
        info.itemList.length > 0 ||
        info.skinItemList.length > 0 ||
        info.morphItemList.length > 0 ||
        info.skinAndMorphItemList.length > 0 ||
        info.instanceItemList.length > 0
    );
  }
  private static getCoreMaterial(material: unknown) {
    return (material as { coreMaterial?: unknown } | null | undefined)?.coreMaterial ?? material ?? null;
  }
  private static hasSSSMaterialCore(material: unknown) {
    return !!(this.getCoreMaterial(material) as { subsurfaceProfile?: unknown } | null)?.subsurfaceProfile;
  }
  private static _getSkyMotionVectorProgram(ctx: DrawContext) {
    if (!this._skyMotionVectorProgram) {
      this._skyMotionVectorProgram = ctx.device.buildRenderProgram({
        vertex(pb) {
          this.$inputs.pos = pb.vec3().attrib('position');
          this.VPMatrix = pb.mat4().uniform(0);
          this.prevVPMatrix = pb.mat4().uniform(0);
          this.cameraPos = pb.vec3().uniform(0);
          this.prevCameraPos = pb.vec3().uniform(0);
          pb.main(function () {
            this.$l.worldPos = pb.add(this.$inputs.pos, this.cameraPos);
            this.$l.prevWorldPos = pb.add(this.$inputs.pos, this.prevCameraPos);
            this.$l.clipPos = pb.mul(this.VPMatrix, pb.vec4(this.worldPos, 1));
            this.$l.prevClipPos = pb.mul(this.prevVPMatrix, pb.vec4(this.prevWorldPos, 1));
            this.clipPos.z = this.clipPos.w;
            this.$builtins.position = this.clipPos;
            this.$outputs.currentPos = this.clipPos;
            this.$outputs.prevPos = this.prevClipPos;
          });
        },
        fragment(pb) {
          this.$outputs.color = pb.vec4();
          pb.main(function () {
            this.$l.motionVector = pb.mul(
              pb.sub(
                pb.div(this.$inputs.currentPos.xy, this.$inputs.currentPos.w),
                pb.div(this.$inputs.prevPos.xy, this.$inputs.prevPos.w)
              ),
              0.5
            );
            this.$outputs.color = pb.vec4(this.motionVector, 0, 1);
          });
        }
      })!;
      this._skyMotionVectorProgram.name = '@TAA_SkyMotionVector';
    }
    return this._skyMotionVectorProgram;
  }
  /** @internal */
  private static prepareSSRProxySDF(ctx: DrawContext, renderQueue: RenderQueue) {
    ctx.ssrSDFBoxBuffer = null;
    ctx.ssrSDFBoxCount = 0;
    if (!ctx.SSR || !ctx.HiZ) {
      return;
    }
    if (!this._ssrSDFBoxData || this._ssrSDFBoxData.length !== this._ssrSDFMaxBoxes * 8) {
      this._ssrSDFBoxData = new Float32Array(this._ssrSDFMaxBoxes * 8);
    }
    const data = this._ssrSDFBoxData;
    data.fill(0);
    const itemList = renderQueue.itemList;
    if (!itemList) {
      return;
    }
    const visited = new Set<number>();
    let count = 0;
    const pushDrawable = (drawable: any) => {
      if (!drawable || count >= this._ssrSDFMaxBoxes) {
        return;
      }
      const id = drawable.getDrawableId?.();
      if (typeof id === 'number' && visited.has(id)) {
        return;
      }
      const node = drawable.getNode?.();
      const bv = node?.getWorldBoundingVolume?.();
      const aabb = bv?.toAABB?.();
      if (!aabb) {
        return;
      }
      const minP = aabb.minPoint;
      const maxP = aabb.maxPoint;
      if (
        !Number.isFinite(minP.x) ||
        !Number.isFinite(minP.y) ||
        !Number.isFinite(minP.z) ||
        !Number.isFinite(maxP.x) ||
        !Number.isFinite(maxP.y) ||
        !Number.isFinite(maxP.z)
      ) {
        return;
      }
      if (maxP.x <= minP.x || maxP.y <= minP.y || maxP.z <= minP.z) {
        return;
      }
      const base = count * 8;
      data[base + 0] = minP.x;
      data[base + 1] = minP.y;
      data[base + 2] = minP.z;
      data[base + 3] = 0;
      data[base + 4] = maxP.x;
      data[base + 5] = maxP.y;
      data[base + 6] = maxP.z;
      data[base + 7] = 0;
      if (typeof id === 'number') {
        visited.add(id);
      }
      count++;
    };
    const collectFromListInfo = (listInfo: any) => {
      if (!listInfo || count >= this._ssrSDFMaxBoxes) {
        return;
      }
      const itemArrays = [
        listInfo.itemList,
        listInfo.skinItemList,
        listInfo.morphItemList,
        listInfo.skinAndMorphItemList,
        listInfo.instanceItemList
      ];
      for (const arr of itemArrays) {
        if (!arr) {
          continue;
        }
        for (const item of arr) {
          pushDrawable(item?.drawable);
          if (count >= this._ssrSDFMaxBoxes) {
            return;
          }
        }
      }
      if (listInfo.instanceList) {
        for (const key of Object.keys(listInfo.instanceList)) {
          const batchDrawables = listInfo.instanceList[key];
          if (!batchDrawables) {
            continue;
          }
          for (const drawable of batchDrawables) {
            pushDrawable(drawable);
            if (count >= this._ssrSDFMaxBoxes) {
              return;
            }
          }
        }
      }
    };
    const bundles = [
      itemList.opaque.lit,
      itemList.opaque.unlit,
      itemList.transmission.lit,
      itemList.transmission.unlit
    ];
    for (const bundle of bundles) {
      for (const listInfo of bundle) {
        collectFromListInfo(listInfo);
        if (count >= this._ssrSDFMaxBoxes) {
          break;
        }
      }
      if (count >= this._ssrSDFMaxBoxes) {
        break;
      }
    }
    if (!this._ssrSDFBoxBuffer) {
      this._ssrSDFBoxBuffer = ctx.device.createBuffer(this._ssrSDFMaxBoxes * 8 * 4, { usage: 'uniform' });
    }
    this._ssrSDFBoxBuffer.bufferSubData(0, data as unknown as Float32Array<ArrayBuffer>);
    ctx.ssrSDFBoxBuffer = this._ssrSDFBoxBuffer;
    ctx.ssrSDFBoxCount = count;
  }
  private static _getBox(_ctx: DrawContext) {
    if (!this._box) {
      this._box = new BoxShape({
        size: 2,
        needNormal: false,
        needUV: false
      });
    }
    return this._box;
  }
  /** @internal */
  private static renderSkyMotionVectors(ctx: DrawContext) {
    if (!ctx.motionVectorTexture) {
      return;
    }
    const fb = ctx.device.pool.fetchTemporalFramebuffer(
      false,
      0,
      0,
      ctx.motionVectorTexture,
      ctx.depthTexture
    );
    const program = this._getSkyMotionVectorProgram(ctx);
    if (!this._skyMotionVectorBindGroup) {
      this._skyMotionVectorBindGroup = ctx.device.createBindGroup(program.bindGroupLayouts[0]);
    }
    const box = this._getBox(ctx);
    this._skyMotionVectorBindGroup.setValue('VPMatrix', ctx.camera.viewProjectionMatrix);
    this._skyMotionVectorBindGroup.setValue('prevVPMatrix', ctx.camera.prevVPMatrix!);
    this._skyMotionVectorBindGroup.setValue('cameraPos', ctx.camera.getWorldPosition());
    this._skyMotionVectorBindGroup.setValue('prevCameraPos', ctx.camera.prevPosition!);
    ctx.device.pushDeviceStates();
    ctx.device.setProgram(program);
    ctx.device.setBindGroup(0, this._skyMotionVectorBindGroup);
    ctx.device.setRenderStates(AbstractPostEffect.getDefaultRenderState(ctx, 'le'));
    ctx.device.setFramebuffer(fb);
    box.draw();
    ctx.device.popDeviceStates();
    ctx.device.pool.releaseFrameBuffer(fb);
  }
  /** @internal */
  private static renderShadowMaps(ctx: DrawContext, lights: PunctualLight[]) {
    ctx.renderPass = this._shadowMapPass;
    ctx.device.pushDeviceStates();
    for (const light of lights) {
      light.shadow.render(ctx, this._shadowMapPass);
    }
    ctx.device.popDeviceStates();
  }
  /** @internal */
  private static decodeNormalizedFloat(rgba: Uint8Array<ArrayBuffer>) {
    const a = rgba[0] / 255;
    const b = rgba[1] / 255;
    const c = rgba[2] / 255;
    const d = rgba[3] / 255;
    return a / (256 * 256 * 256) + b / (256 * 256) + c / 256 + d;
  }
  /** @internal */
  private static renderObjectColors(
    ctx: DrawContext,
    pickResolveFunc: (result: Nullable<PickResult>) => void,
    renderQueue: RenderQueue
  ) {
    const camera = ctx.camera;
    const isWebGL1 = ctx.device.type === 'webgl';
    ctx.renderPass = this._objectColorPass;
    ctx.device.pushDeviceStates();
    const fb = ctx.device.pool.fetchTemporalFramebuffer(
      false,
      1,
      1,
      isWebGL1 ? ['rgba8unorm', 'rgba8unorm'] : ['rgba8unorm', 'rgba32f'],
      ctx.depthFormat,
      false
    );
    ctx.device.setViewport(camera.viewport);
    const vp = ctx.device.getViewport();
    const windowX = camera.getPickPosX() / vp.width;
    const windowY = (vp.height - camera.getPickPosY() - 1) / vp.height;
    const windowW = 1 / vp.width;
    const windowH = 1 / vp.height;
    const pickCamera = this._pickCamera;
    camera.worldMatrix.decompose(pickCamera.scale, pickCamera.rotation, pickCamera.position);
    let left = camera.getProjectionMatrix().getLeftPlane();
    let right = camera.getProjectionMatrix().getRightPlane();
    let bottom = camera.getProjectionMatrix().getBottomPlane();
    let top = camera.getProjectionMatrix().getTopPlane();
    const near = camera.getProjectionMatrix().getNearPlane();
    const far = camera.getProjectionMatrix().getFarPlane();
    const width = right - left;
    const height = top - bottom;
    left += width * windowX;
    bottom += height * windowY;
    right = left + width * windowW;
    top = bottom + height * windowH;
    pickCamera.setProjectionMatrix(
      camera.isPerspective()
        ? Matrix4x4.frustum(left, right, bottom, top, near, far)
        : Matrix4x4.ortho(left, right, bottom, top, near, far)
    );
    const cameraPos = isWebGL1 ? new Vector3(pickCamera.position) : null;
    const ray = isWebGL1 ? camera.constructRay(camera.getPickPosX(), camera.getPickPosY()) : null;
    ctx.device.setFramebuffer(fb);
    this._objectColorPass.clearColor = Vector4.zero();
    this._objectColorPass.clearDepth = 1;
    const rq = this._objectColorPass.cullScene(ctx, pickCamera);
    this._objectColorPass.render(ctx, pickCamera, null, rq);
    rq.dispose();
    ctx.device.popDeviceStates();
    const colorTex = fb.getColorAttachments()[0];
    const distanceTex = fb.getColorAttachments()[1];
    const colorPixels = new Uint8Array(4);
    const distancePixels = isWebGL1 ? new Uint8Array(4) : new Float32Array(4);
    const device = ctx.device;
    let fence: Promise<void[]>;
    if (ctx.device.type === 'webgl') {
      fence = Promise.all([
        ctx.device.runNextFrameAsync(() => colorTex.readPixels(0, 0, 1, 1, 0, 0, colorPixels)),
        ctx.device.runNextFrameAsync(() => distanceTex.readPixels(0, 0, 1, 1, 0, 0, distancePixels))
      ]);
    } else {
      fence = Promise.all([
        colorTex.readPixels(0, 0, 1, 1, 0, 0, colorPixels),
        distanceTex.readPixels(0, 0, 1, 1, 0, 0, distancePixels)
      ]);
    }
    fence
      .then(() => {
        const drawable = renderQueue.getDrawableByColor(colorPixels);
        let d = isWebGL1
          ? this.decodeNormalizedFloat(distancePixels as Uint8Array<ArrayBuffer>) * far
          : distancePixels[0];
        const intersectedPoint = new Vector3(distancePixels[0], distancePixels[1], distancePixels[2]);
        if (isWebGL1) {
          intersectedPoint.x = cameraPos!.x + ray!.direction.x * d;
          intersectedPoint.y = cameraPos!.y + ray!.direction.y * d;
          intersectedPoint.z = cameraPos!.z + ray!.direction.z * d;
          d = Vector3.distance(intersectedPoint, cameraPos!);
        }
        pickResolveFunc(
          drawable
            ? {
                distance: d,
                intersectedPoint,
                drawable,
                target: drawable.getPickTarget()
              }
            : null
        );
        device.pool.releaseFrameBuffer(fb);
      })
      .catch((_err) => {
        camera.getPickResultResolveFunc()?.(null);
        device.pool.releaseFrameBuffer(fb);
      });
  }
}
