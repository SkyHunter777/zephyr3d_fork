import type { Nullable } from '@zephyr3d/base';
import { applyMixins, castObservable, DRef } from '@zephyr3d/base';
import { GraphNode } from './graph_node';
import type { MeshMaterial } from '../material';
import { LambertMaterial, ShaderHelper } from '../material';
import type {
  RenderPass,
  Primitive,
  BatchDrawable,
  DrawContext,
  PickTarget,
  MorphData,
  MorphInfo,
  RenderQueue
} from '../render';
import {
  PBArrayTypeInfo,
  PBPrimitiveType,
  PBPrimitiveTypeInfo,
  PBStructTypeInfo,
  type RenderBundle,
  type Texture2D
} from '@zephyr3d/device';
import type { Scene } from './scene';
import { BoundingBox, type BoundingVolume } from '../utility/bounding_volume';
import {
  getActiveMorphTargetLimit,
  MAX_MORPH_ATTRIBUTES,
  MAX_MORPH_TARGETS,
  MORPH_ACTIVE_WEIGHTS_VECTOR_COUNT,
  MORPH_ATTRIBUTE_VECTOR_COUNT,
  QUEUE_OPAQUE
} from '../values';
import { mixinDrawable } from '../render/drawable_mixin';
import { RenderBundleWrapper } from '../render/renderbundle_wrapper';
import type { SceneNode } from './scene_node';
import { getDevice } from '../app/api';
import type { SkinnedBoundingBox } from '../animation';
import { calculateMorphBoundingBox } from '../animation/morphtarget';

/**
 * Callback invoked after a mesh finishes its per-frame update.
 *
 * @public
 */
export type MeshUpdateCallback = (frameId: number, elapsedInSeconds: number, deltaInSeconds: number) => void;

/**
 * Bounding data used to update a mesh's local bounding box after morph target weights change.
 *
 * @public
 */
export interface MorphBoundingInfo {
  targetBoxes: BoundingBox[];
  originBox: BoundingBox;
}

/**
 * External model location used to restore morph target source data without embedding it in a prefab.
 * @public
 */
export interface MorphSourceDescriptor {
  sourcePath: string;
  nodePath: string;
  subMeshName: string;
}

/**
 * CPU-side morph target data used to build a full or active-only GPU texture on demand.
 * @public
 */
export interface MorphTargetSourceData {
  numTargets: number;
  numVertices: number;
  targets: Partial<Record<number, { numComponents: number; data: Float32Array[]; indices?: Uint32Array[] }>>;
}

const MORPH_INFO_HEADER_LENGTH = 4;
const LEGACY_MORPH_TARGET_CAPACITY = 256;
const LEGACY_MORPH_INFO_DATA_LENGTH =
  MORPH_INFO_HEADER_LENGTH + LEGACY_MORPH_TARGET_CAPACITY + MAX_MORPH_ATTRIBUTES;
const MORPH_INFO_DATA_LENGTH = MORPH_INFO_HEADER_LENGTH + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES;
const MORPH_RENDER_WEIGHT_CAPACITY = MORPH_ACTIVE_WEIGHTS_VECTOR_COUNT * 4;
const MORPH_RENDER_INDEX_OFFSET = MORPH_INFO_HEADER_LENGTH + MORPH_RENDER_WEIGHT_CAPACITY;
const MORPH_RENDER_ATTRIBUTE_OFFSET = MORPH_RENDER_INDEX_OFFSET + MORPH_RENDER_WEIGHT_CAPACITY;
const MORPH_RENDER_INFO_DATA_LENGTH = MORPH_RENDER_ATTRIBUTE_OFFSET + MAX_MORPH_ATTRIBUTES;

/**
 * Converts legacy and current morph-info payloads to the runtime layout.
 *
 * Attribute offsets live after the source payload's weight capacity, so they must be
 * relocated instead of copying an older payload as one contiguous array.
 */
function normalizeMorphInfoData(data: MorphInfo['data']) {
  const normalized = new Float32Array(MORPH_INFO_DATA_LENGTH);
  normalized.fill(-1, MORPH_INFO_HEADER_LENGTH + MAX_MORPH_TARGETS);

  const declaredCount = Math.max(0, Math.floor(Number(data[3]) || 0));
  const canonicalWeightCapacity =
    data.length === LEGACY_MORPH_INFO_DATA_LENGTH
      ? LEGACY_MORPH_TARGET_CAPACITY
      : data.length === MORPH_INFO_DATA_LENGTH
        ? MAX_MORPH_TARGETS
        : null;
  const hasAttributeOffsets =
    canonicalWeightCapacity !== null ||
    data.length >= MORPH_INFO_HEADER_LENGTH + declaredCount + MAX_MORPH_ATTRIBUTES;
  const sourceWeightCapacity = Math.max(
    0,
    canonicalWeightCapacity ??
      (hasAttributeOffsets
        ? data.length - MORPH_INFO_HEADER_LENGTH - MAX_MORPH_ATTRIBUTES
        : data.length - MORPH_INFO_HEADER_LENGTH)
  );
  const supportedCount = Math.min(declaredCount, sourceWeightCapacity, MAX_MORPH_TARGETS);

  for (let i = 0; i < Math.min(MORPH_INFO_HEADER_LENGTH - 1, data.length); i++) {
    normalized[i] = Number(data[i]);
  }
  normalized[3] = supportedCount;
  for (let i = 0; i < supportedCount; i++) {
    normalized[MORPH_INFO_HEADER_LENGTH + i] = Number(data[MORPH_INFO_HEADER_LENGTH + i]);
  }
  if (hasAttributeOffsets) {
    const sourceAttributeOffset = MORPH_INFO_HEADER_LENGTH + sourceWeightCapacity;
    for (let i = 0; i < MAX_MORPH_ATTRIBUTES; i++) {
      normalized[MORPH_INFO_HEADER_LENGTH + MAX_MORPH_TARGETS + i] = Number(
        data[sourceAttributeOffset + i] ?? -1
      );
    }
  }

  return { data: normalized, declaredCount, supportedCount };
}

function createRenderMorphInfoBuffer(data: Float32Array<ArrayBuffer>) {
  const bufferType = new PBStructTypeInfo('dummy', 'std140', [
    {
      name: ShaderHelper.getMorphInfoUniformName(),
      type: new PBArrayTypeInfo(
        new PBPrimitiveTypeInfo(PBPrimitiveType.F32VEC4),
        1 + MORPH_ACTIVE_WEIGHTS_VECTOR_COUNT * 2 + MORPH_ATTRIBUTE_VECTOR_COUNT
      )
    }
  ]);
  return getDevice().createStructuredBuffer(
    bufferType,
    {
      usage: 'uniform'
    },
    data
  );
}

const MeshBase = castObservable(applyMixins(GraphNode, mixinDrawable))<{
  primitive_changed: [primitive: Nullable<Primitive>];
  material_changed: [material: Nullable<MeshMaterial>];
}>();

/**
 * Mesh node
 * @public
 */
export class Mesh extends MeshBase implements BatchDrawable {
  /** @internal */
  private readonly _primitive: DRef<Primitive>;
  /** @internal */
  private readonly _material: DRef<MeshMaterial>;
  /** @internal */
  protected _castShadow: boolean;
  /** @internal */
  protected _skinnedBoundingInfo: Nullable<SkinnedBoundingBox>;
  /** @internal */
  protected _animatedBoundingBox: Nullable<BoundingBox>;
  /** @internal */
  protected _skinBindingName: string;
  /** @internal */
  protected _boneMatrices: DRef<Texture2D>;
  /** @internal */
  protected _morphData: Nullable<MorphData>;
  /** @internal */
  protected _morphInfo: Nullable<MorphInfo>;
  /** @internal */
  protected _renderMorphInfo: Nullable<MorphInfo>;
  /** @internal */
  protected _morphBoundingInfo: Nullable<MorphBoundingInfo>;
  /** @internal */
  protected _morphSource: Nullable<MorphSourceDescriptor>;
  /** @internal */
  protected _morphSourceData: Nullable<MorphTargetSourceData>;
  /** @internal */
  protected _activeMorphTargetIndices: Uint32Array<ArrayBuffer>;
  /** @internal */
  protected _activeMorphCandidates: { index: number; weight: number }[];
  /** @internal */
  protected _compactMorphData: boolean;
  /** @internal */
  protected _renderMorphTargetLimit: number;
  /** @internal */
  protected _morphDirty: boolean;
  /** @internal */
  protected _instanceHash: Nullable<string>;
  /** @internal */
  protected _batchable: boolean;
  /** @internal */
  protected _pickTarget: PickTarget;
  /** @internal */
  protected _suspendSkinning: boolean;
  /** @internal */
  protected _renderBundle: Nullable<Record<string, RenderBundle>>;
  /** @internal */
  protected _useRenderBundle: boolean;
  /** @internal */
  protected _materialChangeTag: Nullable<number>;
  /** @internal */
  protected _primitiveChangeTag: Nullable<number>;
  /** @internal */
  protected _postUpdateCallbacks: Set<MeshUpdateCallback>;
  /**
   * Creates an instance of mesh node
   * @param scene - The scene to which the mesh node belongs
   */
  constructor(scene: Scene, primitive?: Primitive, material?: MeshMaterial) {
    super(scene);
    this._primitive = new DRef();
    this._material = new DRef();
    this._castShadow = true;
    this._skinnedBoundingInfo = null;
    this._animatedBoundingBox = null;
    this._boneMatrices = new DRef();
    this._morphData = null;
    this._morphInfo = null;
    this._renderMorphInfo = null;
    this._morphBoundingInfo = null;
    this._morphSource = null;
    this._morphSourceData = null;
    this._activeMorphTargetIndices = new Uint32Array(0);
    this._activeMorphCandidates = [];
    this._compactMorphData = false;
    this._renderMorphTargetLimit = -1;
    this._morphDirty = false;
    this._instanceHash = null;
    this._pickTarget = { node: this };
    this._batchable = getDevice().type !== 'webgl';
    this.primitive = primitive ?? null;
    this.material = material ?? Mesh._getDefaultMaterial();
    this._suspendSkinning = false;
    this._skinBindingName = '';
    this._renderBundle = {};
    this._useRenderBundle = true;
    this._materialChangeTag = null;
    this._primitiveChangeTag = null;
    this._postUpdateCallbacks = new Set();
  }
  /**
   * Returns the batch instance ID for the current render pass.
   */
  getInstanceId(_renderPass: RenderPass) {
    return `${this._instanceHash}:${this.worldMatrixDet >= 0}`;
  }
  /**
   * Returns the packed instance-uniform buffer used for batching.
   */
  getInstanceUniforms() {
    return this._material.get()!.$instanceUniforms;
  }
  /**
   * {@inheritDoc Drawable.getPickTarget }
   */
  getPickTarget() {
    return this._pickTarget;
  }
  setPickTarget(node: SceneNode, label?: string) {
    this._pickTarget = { node, label };
  }
  get useRenderBundle() {
    return this._useRenderBundle;
  }
  set useRenderBundle(val) {
    this._useRenderBundle = val;
  }
  get skeletonName() {
    return this._skinBindingName;
  }
  set skeletonName(name) {
    this.skinBindingName = name;
  }
  get skinBindingName() {
    return this._skinBindingName;
  }
  set skinBindingName(name) {
    if (name !== this._skinBindingName) {
      this._skinBindingName = name;
      this.updateSkeletonState();
    }
  }
  /** @internal */
  get skinnedBoundingInfo() {
    return this._skinnedBoundingInfo;
  }
  /** @internal */
  get suspendSkinning() {
    return this._suspendSkinning;
  }
  /** @internal */
  set suspendSkinning(val) {
    this._suspendSkinning = !!val;
  }
  /** Wether the mesh node casts shadows */
  get castShadow() {
    return this._castShadow;
  }
  set castShadow(b) {
    this._castShadow = b;
  }
  /** Primitive of the mesh */
  get primitive() {
    return this._primitive?.get() ?? null;
  }
  set primitive(prim) {
    const currentPrimitive = this._primitive.get();
    if (prim !== currentPrimitive) {
      if (currentPrimitive) {
        currentPrimitive.off('bv_changed', this._onBoundingboxChange, this);
      }
      this._primitive.set(prim);
      if (prim) {
        prim.on('bv_changed', this._onBoundingboxChange, this);
      }
      this._instanceHash =
        prim && this._material.get()
          ? `${this.constructor.name}:${this._scene!.id}:${prim.id}:${this._material.get()!.instanceId}`
          : null;
      this.invalidateBoundingVolume();
      RenderBundleWrapper.drawableChanged(this);
      this._primitiveChangeTag = null;
      if (this._morphData) {
        this.ensureWebGLMorphVertexIndexAttribute();
      }
      this.dispatchEvent('primitive_changed', prim);
    }
  }
  /** Material of the mesh */
  get material() {
    return this._material?.get() ?? null;
  }
  set material(m) {
    if (this._material.get() !== m) {
      this._material.set(m);
      if (m) {
        RenderBundleWrapper.materialAttached(m.coreMaterial, this);
      }
      this._instanceHash =
        this._primitive.get() && m
          ? `${this.constructor.name}:${this._scene?.id ?? 0}:${this._primitive.get()!.id}:${m.instanceId}`
          : null;
      RenderBundleWrapper.drawableChanged(this);
      this._materialChangeTag = null;
      this.dispatchEvent('material_changed', m);
    }
  }
  /**
   * {@inheritDoc SceneNode.isMesh}
   */
  isMesh(): this is Mesh {
    return true;
  }
  /**
   * Sets the bounding box for animation
   * @param bbox - The bounding box for animation
   */
  setAnimatedBoundingBox(bbox: Nullable<BoundingBox>) {
    this._animatedBoundingBox = bbox;
    this.invalidateBoundingVolume();
  }
  /**
   * Gets the bounding box for animation
   */
  getAnimatedBoundingBox() {
    return this._animatedBoundingBox ?? null;
  }
  /**
   * Sets morph target bounding data used to update the animated bounding box when weights change.
   * @param info - Morph target bounding data
   */
  setMorphBoundingInfo(info: Nullable<MorphBoundingInfo>) {
    this._morphBoundingInfo = info
      ? {
          targetBoxes: info.targetBoxes.map((box) => box.clone()),
          originBox: info.originBox.clone()
        }
      : null;
    this.refreshAnimatedBoundingBox();
  }
  /**
   * Gets morph target bounding data.
   */
  getMorphBoundingInfo() {
    return this._morphBoundingInfo;
  }
  /**
   * Sets the texture that contains the bone matrices for skeletal animation
   * @param matrices - The texture that contains the bone matrices
   */
  setBoneMatrices(matrices: Nullable<Texture2D>) {
    if (this._boneMatrices.get() !== matrices) {
      this._boneMatrices.set(matrices);
      this._renderBundle = {};
      RenderBundleWrapper.drawableChanged(this);
    }
  }
  /**
   * Sets the texture that contains the morph target data
   * @param data - The texture that contains the morph target data
   */
  setMorphData(data: Nullable<MorphData>) {
    if (!data) {
      if (this._morphData) {
        this._morphData.texture?.dispose();
        this._morphData = null;
        this.setRenderMorphInfo(null);
        this._renderBundle = {};
        RenderBundleWrapper.drawableChanged(this);
      }
    } else {
      if (!this._morphData) {
        this._morphData = {
          texture: new DRef()
        } as MorphData;
      }
      this._morphData.width = data.width;
      this._morphData.height = data.height;
      this._morphData.data = data.data.slice();
      if (data.texture?.get()) {
        this._morphData.texture!.set(data.texture.get());
      } else {
        let tex = this._morphData.texture!.get();
        if (!tex || tex.width !== data.width || tex.height !== data.height) {
          tex = getDevice().createTexture2D('rgba32f', data.width, data.height, {
            mipmapping: false,
            samplerOptions: {
              minFilter: 'nearest',
              magFilter: 'nearest',
              mipFilter: 'none'
            }
          })!;
          this._morphData.texture!.set(tex);
        }
        tex.update(data.data, 0, 0, data.width, data.height);
      }
      this.ensureWebGLMorphVertexIndexAttribute();
      this.updateRenderMorphInfo(this.collectActiveMorphTargetIndices(), this._compactMorphData);
      this._renderBundle = {};
      RenderBundleWrapper.drawableChanged(this);
    }
  }
  /**
   * Sets the skinned bounding info
   * @param info - The skinned bounding info
   */
  setSkinnedBoundingInfo(info: Nullable<SkinnedBoundingBox>) {
    this._skinnedBoundingInfo = info;
  }
  /**
   * {@inheritDoc Drawable.getMorphData}
   */
  getMorphData() {
    return this._morphData;
  }
  /** Returns the external morph source descriptor, if one was serialized. @internal */
  getMorphSource() {
    return this._morphSource;
  }
  /** Sets the external morph source descriptor. @internal */
  setMorphSource(source: Nullable<MorphSourceDescriptor>) {
    this._morphSource = source ? { ...source } : null;
  }
  /** Returns CPU-side morph source data, if retained. @internal */
  getMorphSourceData() {
    return this._morphSourceData;
  }
  /**
   * Sets CPU-side morph source data. A null value only clears a previously active source-data
   * texture; it does not erase an embedded MorphData payload that was loaded from a legacy prefab.
   */
  setMorphSourceData(data: Nullable<MorphTargetSourceData>) {
    const hadSourceData = !!this._morphSourceData;
    this._morphSourceData = data ?? null;
    this._activeMorphTargetIndices = new Uint32Array(0);
    this._compactMorphData = false;
    this._morphDirty = true;
    if (!data) {
      if (hadSourceData) {
        this.setMorphData(null);
        this.setRenderMorphInfo(null);
      }
      return;
    }
    if (this._morphInfo) {
      this.setMorphData(null);
      this.setRenderMorphInfo(null);
      this.rebuildActiveMorphData();
      this._morphDirty = false;
    }
  }
  /**
   * Sets the buffer that contains the morph target information
   * @param info - The buffer that contains the morph target information
   */
  setMorphInfo(info: Nullable<MorphInfo>) {
    if (!info) {
      if (this._morphInfo) {
        this._morphInfo.buffer?.dispose();
        this._morphInfo = null;
      }
      this.setMorphData(null);
      this.setRenderMorphInfo(null);
      this._activeMorphTargetIndices = new Uint32Array(0);
      this._compactMorphData = false;
      this._renderBundle = {};
      RenderBundleWrapper.drawableChanged(this);
    } else {
      const normalized = normalizeMorphInfoData(info.data);
      if (normalized.declaredCount !== normalized.supportedCount) {
        console.warn(
          `Morph target count truncated from ${normalized.declaredCount} to ${normalized.supportedCount} to fit the runtime buffer layout`
        );
      }
      const names: Record<string, number> = {};
      for (const [name, index] of Object.entries(info.names ?? {})) {
        if (Number.isInteger(index) && index >= 0 && index < normalized.supportedCount) {
          names[name] = index;
        }
      }
      this._morphInfo?.buffer?.dispose();
      this._morphInfo = { data: normalized.data, names };
      this._morphDirty = true;
      if (this._morphSourceData) {
        this.setMorphData(null);
        this.setRenderMorphInfo(null);
        this.rebuildActiveMorphData();
        this._morphDirty = false;
      } else {
        this.updateRenderMorphInfo();
        this._morphDirty = false;
      }
      this.refreshAnimatedBoundingBox();
      this._renderBundle = {};
      RenderBundleWrapper.drawableChanged(this);
    }
  }
  /**
   * {@inheritDoc Drawable.getMorphInfo}
   */
  getMorphInfo() {
    return this._morphInfo;
  }
  /** @internal */
  getRenderMorphInfo() {
    if (this._morphDirty) {
      this.updateMorphState();
    } else if (
      this._morphInfo &&
      this._morphData &&
      this._renderMorphTargetLimit !== getActiveMorphTargetLimit()
    ) {
      if (this._morphSourceData) {
        this.rebuildActiveMorphData();
      } else {
        this.updateRenderMorphInfo();
      }
    }
    return this._renderMorphInfo;
  }
  /** @internal */
  private setRenderMorphInfo(info: Nullable<MorphInfo>) {
    if (!info) {
      if (this._renderMorphInfo) {
        this._renderMorphInfo.buffer?.dispose();
        this._renderMorphInfo = null;
      }
      return;
    }
    if (!this._renderMorphInfo) {
      this._renderMorphInfo = {
        data: info.data,
        names: info.names,
        buffer: new DRef()
      };
    } else {
      this._renderMorphInfo.data = info.data;
      this._renderMorphInfo.names = info.names;
    }
    const buffer = this._renderMorphInfo.buffer!.get();
    if (buffer) {
      buffer.bufferSubData(0, info.data);
    } else {
      this._renderMorphInfo.buffer!.set(createRenderMorphInfoBuffer(info.data as Float32Array<ArrayBuffer>));
    }
  }
  /** @internal */
  private collectActiveMorphTargetIndices(): Uint32Array<ArrayBuffer> {
    if (!this._morphInfo) {
      return new Uint32Array(0);
    }
    const numTargets = this.getNumMorphTargets();
    const activeLimit = Math.min(getActiveMorphTargetLimit(), MORPH_RENDER_WEIGHT_CAPACITY, numTargets);
    const candidates = this._activeMorphCandidates;
    let candidateCount = 0;
    for (let index = 0; index < numTargets; index++) {
      const weight = Number(this._morphInfo.data[MORPH_INFO_HEADER_LENGTH + index]);
      if (weight !== 0 && Number.isFinite(weight)) {
        const candidate = candidates[candidateCount] ?? { index, weight: 0 };
        candidate.index = index;
        candidate.weight = Math.abs(weight);
        candidates[candidateCount++] = candidate;
      }
    }
    candidates.length = candidateCount;
    if (candidateCount > activeLimit) {
      candidates.sort((a, b) => b.weight - a.weight || a.index - b.index);
      candidateCount = activeLimit;
    }
    const activeIndices = new Uint32Array(candidateCount);
    for (let i = 0; i < candidateCount; i++) {
      activeIndices[i] = candidates[i].index;
    }
    activeIndices.sort();
    return activeIndices;
  }
  /** @internal */
  private rebuildActiveMorphData() {
    if (!this._morphInfo || !this._morphSourceData) {
      this.setMorphData(null);
      this.setRenderMorphInfo(null);
      this._activeMorphTargetIndices = new Uint32Array(0);
      this._compactMorphData = false;
      return;
    }
    const sourceData = this._morphSourceData;
    const numVertices = Math.max(0, Math.floor(sourceData.numVertices));
    const textureTargetCount = Math.min(this.getNumMorphTargets(), Math.max(0, sourceData.numTargets));
    const attributes = Object.keys(sourceData.targets)
      .map((value) => Number(value))
      .filter(
        (value) =>
          Number.isInteger(value) && value >= 0 && value < MAX_MORPH_ATTRIBUTES && !!sourceData.targets[value]
      )
      .sort((a, b) => a - b);
    if (numVertices <= 0 || textureTargetCount <= 0 || attributes.length === 0) {
      this.setMorphData(null);
      this.setRenderMorphInfo(null);
      this._activeMorphTargetIndices = new Uint32Array(0);
      this._compactMorphData = false;
      return;
    }
    const allActiveIndices = this.collectActiveMorphTargetIndices();
    const activeIndices = new Uint32Array(
      Array.from(allActiveIndices).filter((index) => index < textureTargetCount)
    );
    const sameActiveSet =
      this._activeMorphTargetIndices.length === activeIndices.length &&
      this._activeMorphTargetIndices.every((value, index) => value === activeIndices[index]);
    if (this._morphData && (!this._compactMorphData || sameActiveSet)) {
      this.updateRenderMorphInfo(activeIndices, this._compactMorphData);
      this._activeMorphTargetIndices = activeIndices;
      return;
    }
    const maxTextureSize = getDevice().getDeviceCaps().textureCaps.maxTextureSize;
    const fullTextureSize = Math.ceil(Math.sqrt(numVertices * attributes.length * textureTargetCount));
    let textureTargetIndices: Uint32Array<ArrayBuffer>;
    if (fullTextureSize <= maxTextureSize) {
      textureTargetIndices = new Uint32Array(textureTargetCount);
      for (let index = 0; index < textureTargetCount; index++) {
        textureTargetIndices[index] = index;
      }
      this._compactMorphData = false;
    } else if (activeIndices.length > 0) {
      textureTargetIndices = activeIndices;
      this._compactMorphData = true;
    } else {
      this.setMorphData(null);
      this.setRenderMorphInfo(null);
      this._activeMorphTargetIndices = activeIndices;
      this._compactMorphData = true;
      return;
    }
    const textureSize = Math.ceil(Math.sqrt(numVertices * attributes.length * textureTargetIndices.length));
    if (textureSize > maxTextureSize) {
      console.warn(
        `Active morph target texture too large for mesh "${this.name ?? ''}": ${textureSize} exceeds device limit`
      );
      this.setMorphData(null);
      this.setRenderMorphInfo(null);
      this._activeMorphTargetIndices = new Uint32Array(0);
      return;
    }
    const textureData = new Float32Array(textureSize * textureSize * 4);
    const attributeOffsets = new Float32Array(MAX_MORPH_ATTRIBUTES);
    attributeOffsets.fill(-1);
    let offset = 0;
    for (const attrib of attributes) {
      const source = sourceData.targets[attrib]!;
      const numComponents = Math.min(4, Math.max(0, Math.floor(source.numComponents)));
      attributeOffsets[attrib] = offset >> 2;
      for (let slot = 0; slot < textureTargetIndices.length; slot++) {
        const targetIndex = textureTargetIndices[slot];
        const targetData = source.data[targetIndex];
        const sparseIndices = source.indices?.[targetIndex];
        const baseOffset = offset + slot * numVertices * 4;
        if (sparseIndices && targetData) {
          const sparseCount = Math.min(sparseIndices.length, Math.floor(targetData.length / numComponents));
          for (let index = 0; index < sparseCount; index++) {
            const vertexIndex = sparseIndices[index];
            if (vertexIndex >= numVertices) {
              continue;
            }
            const vertexOffset = baseOffset + vertexIndex * 4;
            for (let component = 0; component < numComponents; component++) {
              textureData[vertexOffset + component] = targetData[index * numComponents + component];
            }
          }
        } else if (targetData) {
          const vertexCount = Math.min(
            numVertices,
            Math.floor(targetData.length / Math.max(1, numComponents))
          );
          for (let vertex = 0; vertex < vertexCount; vertex++) {
            const vertexOffset = baseOffset + vertex * 4;
            for (let component = 0; component < numComponents; component++) {
              textureData[vertexOffset + component] = targetData[vertex * numComponents + component];
            }
          }
        }
      }
      offset += numVertices * 4 * textureTargetIndices.length;
    }
    this.setMorphData({ width: textureSize, height: textureSize, data: textureData });
    this.updateRenderMorphInfo(activeIndices, this._compactMorphData, attributeOffsets);
    this._activeMorphTargetIndices = activeIndices;
  }
  /** @internal */
  private updateRenderMorphInfo(
    activeIndices?: Uint32Array<ArrayBuffer>,
    useCompactSlots = false,
    attributeOffsets?: Float32Array<ArrayBuffer>
  ) {
    if (!this._morphInfo || !this._morphData) {
      this.setRenderMorphInfo(null);
      this._activeMorphTargetIndices = new Uint32Array(0);
      this._renderMorphTargetLimit = -1;
      return;
    }
    activeIndices = activeIndices ?? this.collectActiveMorphTargetIndices();
    const data =
      this._renderMorphInfo?.data instanceof Float32Array &&
      this._renderMorphInfo.data.length === MORPH_RENDER_INFO_DATA_LENGTH
        ? this._renderMorphInfo.data
        : new Float32Array(MORPH_RENDER_INFO_DATA_LENGTH);
    const reuseSourceAttributeOffsets =
      !attributeOffsets && !!this._morphSourceData && data === this._renderMorphInfo?.data;
    data[0] = this._morphData.width;
    data[1] = this._morphData.height;
    data[2] = this._morphSourceData?.numVertices ?? (Number(this._morphInfo.data[2]) || 0);
    data[3] = activeIndices.length;
    data.fill(0, MORPH_INFO_HEADER_LENGTH, MORPH_RENDER_ATTRIBUTE_OFFSET);
    for (let slot = 0; slot < activeIndices.length; slot++) {
      const targetIndex = activeIndices[slot];
      data[MORPH_INFO_HEADER_LENGTH + slot] = Number(
        this._morphInfo.data[MORPH_INFO_HEADER_LENGTH + targetIndex]
      );
      data[MORPH_RENDER_INDEX_OFFSET + slot] = useCompactSlots ? slot : targetIndex;
    }
    if (attributeOffsets) {
      data.fill(-1, MORPH_RENDER_ATTRIBUTE_OFFSET);
      data.set(attributeOffsets, MORPH_RENDER_ATTRIBUTE_OFFSET);
    } else if (!reuseSourceAttributeOffsets) {
      data.fill(-1, MORPH_RENDER_ATTRIBUTE_OFFSET);
      for (let attrib = 0; attrib < MAX_MORPH_ATTRIBUTES; attrib++) {
        data[MORPH_RENDER_ATTRIBUTE_OFFSET + attrib] = Number(
          this._morphInfo.data[MORPH_INFO_HEADER_LENGTH + MAX_MORPH_TARGETS + attrib] ?? -1
        );
      }
    }
    this._activeMorphTargetIndices = activeIndices;
    this._renderMorphTargetLimit = getActiveMorphTargetLimit();
    this.setRenderMorphInfo({ data, names: this._morphInfo.names });
  }
  /** @internal */
  resolveAnimatedBoundingBox(morphBoundingBox?: Nullable<BoundingBox>) {
    const skinnedBoundingBox =
      this._boneMatrices.get() && this._skinnedBoundingInfo?.boundingBox?.isValid()
        ? this._skinnedBoundingInfo.boundingBox
        : null;
    if (skinnedBoundingBox && morphBoundingBox) {
      return skinnedBoundingBox.clone().union(morphBoundingBox) as BoundingBox;
    }
    return skinnedBoundingBox?.clone() ?? morphBoundingBox ?? null;
  }
  /**
   * Get the number of morph targets
   *
   * @returns The number of morph targets
   */
  getNumMorphTargets(): number {
    return this._morphInfo ? Math.min(Number(this._morphInfo.data[3]) || 0, MAX_MORPH_TARGETS) : 0;
  }
  /**
   * Get the name of the morph target by index
   *
   * @param index - The index of the morph target
   * @returns The name of the morph target, or null if not found
   */
  getMorphTargetName(index: number): Nullable<string> {
    if (this._morphInfo && index >= 0 && index < this.getNumMorphTargets()) {
      const name = Object.keys(this._morphInfo.names).find((key) => this._morphInfo!.names![key] === index);
      return name ?? null;
    }
    return null;
  }
  /**
   * Get the index of the morph target by name
   * @param name - The name of the morph target
   * @returns The index of the morph target, or -1 if not found
   */
  getMorphTargetIndexByName(name: string): number {
    return this._morphInfo?.names?.[name] ?? -1;
  }
  /**
   * Update morph target weight
   *
   * @param name - The name of the morph target
   * @param weight - The weight of the morph target
   */
  setMorphWeight(name: string, weight: number) {
    const index = this.getMorphTargetIndexByName(name);
    if (index >= 0) {
      this.setMorphWeightByIndex(index, weight);
    }
  }
  /**
   * Update morph target weight by index
   *
   * @param index - The index of the morph target
   * @param weight - The weight of the morph target
   */
  setMorphWeightByIndex(index: number, weight: number) {
    if (index >= 0 && index < this.getNumMorphTargets()) {
      const normalizedWeight = Math.fround(weight);
      if (this._morphInfo!.data[4 + index] !== normalizedWeight) {
        this._morphInfo!.data[4 + index] = normalizedWeight;
        this._morphDirty = true;
        this.refreshAnimatedBoundingBox();
        this.scene!.queueUpdateNode(this);
      }
    } else {
      console.warn(`Morph target index out of range: ${index}`);
    }
  }
  /**
   * Get morph target weight
   *
   * @param name - The name of the morph target
   * @returns The weight of the morph target, or 0 if not found
   */
  getMorphWeight(name: string): number {
    const index = this._morphInfo?.names?.[name];
    if (index !== undefined && index >= 0 && index < this.getNumMorphTargets()) {
      return this._morphInfo!.data[4 + index];
    }
    return 0;
  }
  /**
   * Update morph target weights
   *
   * @param weight - The morph target weights. The length must not exceed the mesh's morph target count.
   */
  updateMorphWeights(weight: ArrayLike<number>) {
    if (this._morphInfo && weight && weight.length <= this.getNumMorphTargets()) {
      let changed = false;
      for (let i = 0; i < weight.length; i++) {
        const normalizedWeight = Math.fround(weight[i] ?? 0);
        if (this._morphInfo.data[4 + i] !== normalizedWeight) {
          this._morphInfo.data[4 + i] = normalizedWeight;
          changed = true;
        }
      }
      if (!changed) {
        return;
      }
      this._morphDirty = true;
      this.refreshAnimatedBoundingBox();
      this.scene!.queueUpdateNode(this);
    }
  }
  /** {@inheritDoc SceneNode.update} */
  update(frameId: number, elapsedInSeconds: number, deltaInSeconds: number) {
    super.update(frameId, elapsedInSeconds, deltaInSeconds);
    this.updateSkeletonState();
    this.updateMorphState();
    if (this._postUpdateCallbacks.size > 0) {
      for (const callback of this._postUpdateCallbacks) {
        callback(frameId, elapsedInSeconds, deltaInSeconds);
      }
    }
  }
  /** @internal */
  addPostUpdateCallback(callback: MeshUpdateCallback) {
    if (callback) {
      this._postUpdateCallbacks.add(callback);
    }
  }
  /** @internal */
  removePostUpdateCallback(callback: MeshUpdateCallback) {
    if (callback) {
      this._postUpdateCallbacks.delete(callback);
    }
  }
  /**
   * {@inheritDoc Drawable.isBatchable}
   */
  isBatchable(): this is BatchDrawable {
    return (
      this._batchable &&
      !this._boneMatrices.get() &&
      !this._morphData &&
      (this._material.get()?.isBatchable() ?? false)
    );
  }
  /**
   * {@inheritDoc Drawable.getQueueType}
   */
  getQueueType() {
    return this.material?.getQueueType() ?? QUEUE_OPAQUE;
  }
  /**
   * {@inheritDoc Drawable.isUnlit}
   */
  isUnlit() {
    return !this.material?.supportLighting();
  }
  /**
   * {@inheritDoc Drawable.needSceneColor}
   */
  needSceneColor() {
    return this.material?.needSceneColor() ?? false;
  }
  /**
   * {@inheritDoc Drawable.needSceneDepth}
   */
  needSceneDepth() {
    return this.material?.needSceneDepth() ?? false;
  }
  /** @internal */
  private calculateMorphBoundingBox(): Nullable<BoundingBox> {
    if (!this._morphInfo || !this._morphBoundingInfo) {
      return null;
    }
    const numTargets = Math.min(this.getNumMorphTargets(), this._morphBoundingInfo.targetBoxes.length);
    if (numTargets <= 0) {
      return null;
    }
    const weights =
      this._morphInfo.data instanceof Float32Array
        ? this._morphInfo.data.subarray(4, 4 + numTargets)
        : new Float32Array(Array.from(this._morphInfo.data.subarray(4, 4 + numTargets)));
    const bbox = new BoundingBox();
    calculateMorphBoundingBox(bbox, this._morphBoundingInfo.targetBoxes, weights, numTargets);
    bbox.minPoint.addBy(this._morphBoundingInfo.originBox.minPoint);
    bbox.maxPoint.addBy(this._morphBoundingInfo.originBox.maxPoint);
    return bbox;
  }
  /** @internal */
  private refreshAnimatedBoundingBox() {
    this.setAnimatedBoundingBox(this.resolveAnimatedBoundingBox(this.calculateMorphBoundingBox()));
  }
  /** @internal */
  private updateMorphState() {
    if (this._morphInfo && this._morphDirty) {
      if (this._morphSourceData) {
        this.rebuildActiveMorphData();
      } else {
        this.updateRenderMorphInfo();
      }
      this.refreshAnimatedBoundingBox();
      this._morphDirty = false;
    }
  }
  /** @internal */
  private updateSkeletonState() {
    if (this._suspendSkinning) {
      this.setBoneMatrices(null);
      this.setAnimatedBoundingBox(null);
      return;
    }
    const binding = this._skinBindingName && this.findSkinBindingById(this._skinBindingName);
    if (binding) {
      this.setBoneMatrices(binding.jointTexture);
      binding.computeBoundingBox(this._skinnedBoundingInfo!, this.invWorldMatrix);
      this.refreshAnimatedBoundingBox();
    } else {
      this.setBoneMatrices(null);
      this.refreshAnimatedBoundingBox();
    }
    if (this._skinBindingName) {
      this.scene!.queueUpdateNode(this);
    }
  }
  /**
   * {@inheritDoc Drawable.draw}
   */
  draw(ctx: DrawContext, renderQueue: Nullable<RenderQueue>, hash?: string) {
    const material = this.material;
    const primitive = this.primitive;
    if (material && primitive) {
      if (this._useRenderBundle && !ctx.instanceData && hash) {
        if (
          this._primitiveChangeTag !== primitive.changeTag ||
          this._materialChangeTag !== material.changeTag
        ) {
          this._renderBundle = {};
          this._primitiveChangeTag = primitive.changeTag;
          this._materialChangeTag = material.changeTag;
        }
        const renderBundle = this._renderBundle![hash];
        if (!renderBundle) {
          ctx.device.beginCapture();
          this.bind(ctx, renderQueue);
          material.draw(primitive, ctx);
          this._renderBundle![hash] = ctx.device.endCapture();
        } else {
          ctx.device.executeRenderBundle(renderBundle);
        }
      } else {
        this.bind(ctx, renderQueue);
        material.draw(primitive, ctx);
      }
    }
  }
  /**
   * {@inheritDoc Drawable.getMaterial}
   */
  getMaterial() {
    return this.material;
  }
  /**
   * {@inheritDoc Drawable.getPrimitive}
   */
  getPrimitive() {
    return this.primitive;
  }
  /**
   * {@inheritDoc Drawable.getBoneMatrices}
   */
  getBoneMatrices() {
    return this._boneMatrices.get();
  }
  /**
   * {@inheritDoc Drawable.getNode}
   */
  getNode() {
    // mesh transform should be ignored when skinned
    return this;
  }
  /** @internal */
  computeBoundingVolume() {
    let bbox: Nullable<BoundingVolume>;
    if (this._animatedBoundingBox) {
      bbox = this._animatedBoundingBox;
    } else {
      bbox = this._primitive.get()?.getBoundingVolume() ?? null;
    }
    return bbox;
  }
  /** Disposes the mesh node */
  protected onDispose() {
    super.onDispose();
    this._primitive.get()?.off('bv_changed', this._onBoundingboxChange, this);
    this._primitive.dispose();
    this._material.dispose();
    this._boneMatrices.dispose();
    this.setMorphData(null);
    this.setRenderMorphInfo(null);
    this.setMorphInfo(null);
    this.setMorphSourceData(null);
    this.setMorphSource(null);
    this.setMorphBoundingInfo(null);
    this._renderBundle = null;
    RenderBundleWrapper.drawableChanged(this);
  }
  /** @internal */
  private _onBoundingboxChange() {
    this.invalidateBoundingVolume();
  }
  /** @internal */
  private ensureWebGLMorphVertexIndexAttribute() {
    const primitive = this._primitive.get();
    if (!primitive || getDevice().type !== 'webgl' || primitive.getVertexBuffer('texCoord7')) {
      return;
    }
    const numVertices = primitive.getNumVertices();
    if (numVertices <= 0) {
      return;
    }
    const vertexIndices = new Float32Array(numVertices);
    for (let i = 0; i < numVertices; i++) {
      vertexIndices[i] = i;
    }
    primitive.createAndSetVertexBuffer('tex7_f32', vertexIndices);
  }
  /** @internal */
  private static _defaultMaterial: Nullable<MeshMaterial> = null;
  /** @internal */
  private static _getDefaultMaterial() {
    if (!this._defaultMaterial) {
      this._defaultMaterial = new LambertMaterial();
    }
    return this._defaultMaterial;
  }
}
