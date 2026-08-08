import { Interpolator, MemoryFS, uint8ArrayToBase64, Vector3 } from '@zephyr3d/base';
import {
  AssetHierarchyNode,
  BoundingBox,
  DEFAULT_ACTIVE_MORPH_TARGET_LIMIT,
  MAX_ACTIVE_MORPH_TARGETS,
  MAX_MORPH_ATTRIBUTES,
  MAX_MORPH_TARGETS,
  Mesh,
  MorphTargetTrack,
  ResourceManager,
  Scene,
  SceneNode,
  SharedModel,
  setActiveMorphTargetLimit,
  setSceneMeshAssetBinding,
  type AssetMeshData,
  type AssetPrimitiveInfo,
  type AssetSubMeshData
} from '../../../libs/scene/src';

let mockResourceManager: ResourceManager | null = null;

jest.mock('../../../libs/scene/src/app/api', () => ({
  getDevice: jest.fn(() => ({
    type: 'webgpu',
    frameInfo: {
      frameCounter: 0,
      elapsedFrame: 16.6667,
      elapsedOverall: 16.6667
    },
    createStructuredBuffer: jest.fn(() => ({
      bufferSubData: jest.fn(),
      dispose: jest.fn()
    })),
    createTexture2D: jest.fn((_format, width, height) => ({
      width,
      height,
      update: jest.fn(),
      dispose: jest.fn()
    })),
    getDeviceCaps: jest.fn(() => ({ textureCaps: { maxTextureSize: 4096 } }))
  })),
  getEngine: jest.fn(() => ({
    resourceManager: mockResourceManager
  })),
  tryGetApp: jest.fn(() => null)
}));

function createSubMesh(name: string, numTargets: number): AssetSubMeshData {
  return {
    name,
    primitive: null,
    material: null,
    rawPositions: null,
    rawBlendIndices: null,
    rawJointWeights: null,
    numTargets
  };
}

function createAssetMesh(name: string, morphNames: string[]): AssetMeshData {
  return {
    morphNames,
    subMeshes: [createSubMesh(name, morphNames.length)]
  };
}

function setMorphInfo(mesh: Mesh, names: string[], weights: number[] = []) {
  const data = new Float32Array(4 + names.length);
  data[3] = names.length;
  weights.forEach((weight, index) => {
    data[4 + index] = weight;
  });
  const nameMap: Record<string, number> = {};
  names.forEach((name, index) => {
    nameMap[name] = index;
  });
  mesh.setMorphInfo({ data, names: nameMap });
}

function expectBoundingBox(box: BoundingBox | null, min: number[], max: number[]) {
  expect(box).not.toBeNull();
  expect(box!.minPoint.x).toBeCloseTo(min[0]);
  expect(box!.minPoint.y).toBeCloseTo(min[1]);
  expect(box!.minPoint.z).toBeCloseTo(min[2]);
  expect(box!.maxPoint.x).toBeCloseTo(max[0]);
  expect(box!.maxPoint.y).toBeCloseTo(max[1]);
  expect(box!.maxPoint.z).toBeCloseTo(max[2]);
}

describe('morph target groups', () => {
  afterEach(() => {
    setActiveMorphTargetLimit(DEFAULT_ACTIVE_MORPH_TARGET_LIMIT);
  });

  test('normalizes legacy 256-slot MorphInfo and relocates attribute offsets', () => {
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const legacyCapacity = 256;
    const legacy = new Float32Array(4 + legacyCapacity + MAX_MORPH_ATTRIBUTES);
    legacy.set([32, 16, 128, 2], 0);
    legacy[4] = 0.25;
    legacy[5] = 0.75;
    legacy.fill(-1, 4 + legacyCapacity);
    legacy[4 + legacyCapacity] = 123;

    mesh.setMorphInfo({ data: legacy, names: { smile: 0, blink: 1, invalid: 256 } });

    const normalized = mesh.getMorphInfo()!;
    expect(normalized.data).toHaveLength(4 + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES);
    expect(Array.from(normalized.data.slice(0, 6))).toEqual([32, 16, 128, 2, 0.25, 0.75]);
    expect(normalized.data[4 + MAX_MORPH_TARGETS]).toBe(123);
    expect(Array.from(normalized.data.slice(4 + MAX_MORPH_TARGETS + 1))).toEqual(
      Array(MAX_MORPH_ATTRIBUTES - 1).fill(-1)
    );
    expect(normalized.names).toEqual({ smile: 0, blink: 1 });
  });

  test('preserves lab 1024-slot MorphInfo above the legacy target limit', () => {
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const data = new Float32Array(4 + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES);
    data.set([256, 256, 1024, 737], 0);
    data[4 + 736] = 0.625;
    data.fill(-1, 4 + MAX_MORPH_TARGETS);
    data[4 + MAX_MORPH_TARGETS] = 9876;

    mesh.setMorphInfo({ data, names: { last: 736, invalid: MAX_MORPH_TARGETS } });

    const normalized = mesh.getMorphInfo()!;
    expect(mesh.getNumMorphTargets()).toBe(737);
    expect(normalized.data[4 + 736]).toBe(0.625);
    expect(normalized.data[4 + MAX_MORPH_TARGETS]).toBe(9876);
    expect(normalized.names).toEqual({ last: 736 });
  });

  test('builds compact render morph info without truncating lab resource weights', () => {
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const data = new Float32Array(4 + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES);
    data.set([32, 32, 100, 737], 0);
    data[4 + 2] = 0.125;
    data[4 + 300] = 0.75;
    data[4 + 736] = -0.5;
    data.fill(-1, 4 + MAX_MORPH_TARGETS);
    data[4 + MAX_MORPH_TARGETS] = 123;

    mesh.setMorphData({ width: 32, height: 32, data: new Float32Array(32 * 32 * 4) });
    mesh.setMorphInfo({ data, names: { low: 2, middle: 300, high: 736 } });

    const renderData = mesh.getRenderMorphInfo()!.data;
    const renderIndexOffset = 4 + MAX_ACTIVE_MORPH_TARGETS;
    const renderAttributeOffset = renderIndexOffset + MAX_ACTIVE_MORPH_TARGETS;
    expect(renderData).toHaveLength(4 + MAX_ACTIVE_MORPH_TARGETS * 2 + MAX_MORPH_ATTRIBUTES);
    expect(Array.from(renderData.slice(0, 7))).toEqual([32, 32, 100, 3, 0.125, 0.75, -0.5]);
    expect(Array.from(renderData.slice(renderIndexOffset, renderIndexOffset + 3))).toEqual([2, 300, 736]);
    expect(renderData[renderAttributeOffset]).toBe(123);
    expect(mesh.getMorphInfo()!.data[4 + 736]).toBe(-0.5);

    mesh.setMorphWeightByIndex(736, 0);
    expect(mesh.getRenderMorphInfo()!.data[3]).toBe(2);
    expect(
      Array.from(mesh.getRenderMorphInfo()!.data.slice(renderIndexOffset, renderIndexOffset + 2))
    ).toEqual([2, 300]);
  });

  test('selects strongest active targets while preserving every resource-side weight', () => {
    setActiveMorphTargetLimit(3);
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const data = new Float32Array(4 + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES);
    data.set([8, 8, 1, 6, 1, 5, 3, 4, 2, 6], 0);
    data.fill(-1, 4 + MAX_MORPH_TARGETS);

    mesh.setMorphData({ width: 8, height: 8, data: new Float32Array(8 * 8 * 4) });
    mesh.setMorphInfo({
      data,
      names: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`Target${index}`, index]))
    });

    const renderData = mesh.getRenderMorphInfo()!.data;
    const renderIndexOffset = 4 + MAX_ACTIVE_MORPH_TARGETS;
    expect(renderData[3]).toBe(3);
    expect(Array.from(renderData.slice(4, 7))).toEqual([5, 4, 6]);
    expect(Array.from(renderData.slice(renderIndexOffset, renderIndexOffset + 3))).toEqual([1, 3, 5]);
    expect(Array.from(mesh.getMorphInfo()!.data.slice(4, 10))).toEqual([1, 5, 3, 4, 2, 6]);

    setActiveMorphTargetLimit(2);
    const reducedRenderData = mesh.getRenderMorphInfo()!.data;
    expect(reducedRenderData[3]).toBe(2);
    expect(Array.from(reducedRenderData.slice(4, 6))).toEqual([5, 6]);
    expect(Array.from(reducedRenderData.slice(renderIndexOffset, renderIndexOffset + 2))).toEqual([1, 5]);
  });

  test('routes large MorphTargetTrack updates through the full resource-side weight array', () => {
    const numTargets = 737;
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const data = new Float32Array(4 + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES);
    data[3] = numTargets;
    data.fill(-1, 4 + MAX_MORPH_TARGETS);
    mesh.setMorphInfo({ data, names: { last: numTargets - 1 } });

    const outputs = new Float32Array(numTargets);
    outputs[numTargets - 1] = 0.625;
    const interpolator = new Interpolator('step', null, new Float32Array([0]), outputs);
    const targetBoxes = Array.from(
      { length: numTargets },
      () => new BoundingBox(Vector3.zero(), Vector3.zero())
    );
    const originBox = new BoundingBox(Vector3.zero(), Vector3.one());
    const track = new MorphTargetTrack(interpolator, undefined, targetBoxes, originBox);
    const state = track.calculateState(mesh, 0);

    expect(state.weights).toHaveLength(numTargets);
    track.applyState(mesh, state);
    expect(mesh.getMorphWeight('last')).toBe(0.625);
    expect(mesh.getMorphInfo()!.data[4 + numTargets - 1]).toBe(0.625);
  });

  test('keeps legacy embedded MorphData when MorphSourceData is absent', async () => {
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const scene = new Scene();
    const mesh = new Mesh(scene);
    mesh.setMorphData({ width: 2, height: 2, data: new Float32Array(16).fill(0.25) });
    setMorphInfo(mesh, ['smile'], [0.5]);

    const serialized = await manager.serializeObject(mesh);
    const restored = new Mesh(scene);
    await manager.deserializeObjectProps(restored, serialized.Object);

    expect(restored.getMorphSource()).toBeNull();
    expect(restored.getMorphSourceData()).toBeNull();
    expect(restored.getMorphData()).not.toBeNull();
    expect(Array.from(restored.getMorphData()!.data)).toEqual(Array(16).fill(0.25));
  });

  test('round-trips inline MorphSourceData and rebuilds its GPU texture', async () => {
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const scene = new Scene();
    const mesh = new Mesh(scene);
    setMorphInfo(mesh, ['left', 'right'], [0.25, 0.75]);
    mesh.setMorphSourceData({
      numTargets: 2,
      numVertices: 2,
      targets: {
        0: {
          numComponents: 3,
          data: [new Float32Array([1, 2, 3, 4, 5, 6]), new Float32Array([7, 8, 9, 10, 11, 12])]
        }
      }
    });

    const serialized = await manager.serializeObject(mesh);
    const props = serialized.Object as Record<string, string>;
    expect(props.MorphSourceData).toBeTruthy();
    const restored = new Mesh(scene);
    await manager.deserializeObjectProps(restored, props);

    expect(restored.getMorphSourceData()?.numTargets).toBe(2);
    expect(restored.getMorphData()?.width).toBe(2);
    expect(restored.getMorphWeight('right')).toBe(0.75);
    expect(Array.from(restored.getMorphSourceData()!.targets[0]!.data[1])).toEqual([7, 8, 9, 10, 11, 12]);

    const textureData = restored.getMorphData()!.data;
    const attributeOffset = 4 + MAX_ACTIVE_MORPH_TARGETS * 2;
    expect(restored.getRenderMorphInfo()!.data[attributeOffset]).toBe(0);
    restored.setMorphWeightByIndex(1, 0.5);
    expect(restored.getRenderMorphInfo()!.data[attributeOffset]).toBe(0);
    expect(restored.getMorphData()!.data).toBe(textureData);
  });

  test('resolves a serialized MorphSource against imported model data', async () => {
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const sourceModel = new SharedModel();
    const rig = new AssetHierarchyNode('rig', sourceModel);
    const sourceNode = new AssetHierarchyNode('face', sourceModel, rig);
    const primitive: AssetPrimitiveInfo = {
      name: 'faceMesh',
      vertices: {
        position: { format: 'position_f32x3', data: new Float32Array([0, 0, 0, 1, 0, 0]) }
      } as AssetPrimitiveInfo['vertices'],
      indices: null,
      indexCount: 0,
      type: 'triangle-list',
      boxMin: Vector3.zero(),
      boxMax: Vector3.one()
    };
    const sourceSubMesh: AssetSubMeshData = {
      name: 'faceMesh',
      primitive,
      material: null,
      rawPositions: null,
      rawBlendIndices: null,
      rawJointWeights: null,
      numTargets: 2,
      targets: {
        0: {
          numComponents: 3,
          data: [new Float32Array(6).fill(1), new Float32Array(6).fill(2)]
        }
      },
      targetBox: [
        new BoundingBox(Vector3.zero(), Vector3.one()),
        new BoundingBox(Vector3.zero(), Vector3.one())
      ]
    };
    sourceNode.mesh = { morphNames: ['left', 'right'], subMeshes: [sourceSubMesh] };
    jest.spyOn(manager.assetManager, 'fetchModelData').mockResolvedValue(sourceModel);

    const scene = new Scene();
    const mesh = new Mesh(scene);
    setMorphInfo(mesh, ['left', 'right'], [0.25, 0.75]);
    mesh.setMorphSource({
      sourcePath: '/assets/face.glb',
      nodePath: 'rig/face',
      subMeshName: 'faceMesh'
    });
    const serialized = await manager.serializeObject(mesh);
    const restored = new Mesh(scene);
    await manager.deserializeObjectProps(restored, serialized.Object);

    expect(manager.assetManager.fetchModelData).toHaveBeenCalledWith('/assets/face.glb');
    expect(restored.getMorphSourceData()?.numTargets).toBe(2);
    expect(restored.getMorphData()).not.toBeNull();
    expect(restored.getRenderMorphInfo()!.data[3]).toBe(2);
    expect(restored.getMorphWeight('left')).toBe(0.25);
    expect(restored.getMorphWeight('right')).toBe(0.75);
  });

  test('reads legacy raw-base64 MorphInfo and writes a versioned 1024-slot payload', async () => {
    const legacyCapacity = 256;
    const legacy = new Float32Array(4 + legacyCapacity + MAX_MORPH_ATTRIBUTES);
    legacy.set([16, 16, 64, 1], 0);
    legacy[4] = 0.5;
    legacy.fill(-1, 4 + legacyCapacity);
    legacy[4 + legacyCapacity] = 42;
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const scene = new Scene();
    const mesh = new Mesh(scene);

    await manager.deserializeObjectProps(mesh, {
      MorphInfo: uint8ArrayToBase64(new Uint8Array(legacy.buffer))
    });
    const serialized = await manager.serializeObject(mesh);
    const payload = JSON.parse((serialized.Object as Record<string, string>).MorphInfo);

    expect(mesh.getMorphTargetName(0)).toBe('Target0');
    expect(mesh.getMorphInfo()!.data[4 + MAX_MORPH_TARGETS]).toBe(42);
    expect(payload.version).toBe(2);
    expect(payload.weightCapacity).toBe(MAX_MORPH_TARGETS);
    expect(Buffer.from(payload.data, 'base64').byteLength).toBe(
      (4 + MAX_MORPH_TARGETS + MAX_MORPH_ATTRIBUTES) * Float32Array.BYTES_PER_ELEMENT
    );
  });

  test('builds SharedModel morph target groups by target name', () => {
    const model = new SharedModel();
    const face = new AssetHierarchyNode('face', model);
    face.mesh = createAssetMesh('face-0', ['smile', 'blink']);
    const mouth = new AssetHierarchyNode('mouth', model);
    mouth.mesh = createAssetMesh('mouth-0', ['smile', 'aa']);

    model.buildMorphTargetGroupsByName();

    expect(model.morphTargetGroups.map((group) => group.name)).toEqual(['smile', 'blink', 'aa']);
    expect(model.getMorphTargetGroup('smile')?.bindings).toHaveLength(2);
  });

  test('initializes runtime group weight from mesh morph weights', () => {
    const model = new SharedModel();
    const assetNode = new AssetHierarchyNode('face', model);
    const assetMesh = createAssetMesh('face-0', ['smile']);
    assetNode.mesh = assetMesh;
    model.buildMorphTargetGroupsByName();

    const scene = new Scene();
    const root = new SceneNode(scene);
    const faceMesh = new Mesh(scene);
    faceMesh.parent = root;
    setMorphInfo(faceMesh, ['smile'], [0.5]);

    (model as any).createMorphTargetGroups(root, new Map([[assetMesh.subMeshes[0], faceMesh]]));

    expect(root.getMorphTargetGroupWeight('smile')).toBe(0.5);
    expect(root.getSerializedMorphTargetGroups()).toEqual([
      {
        name: 'smile',
        isBinary: undefined,
        weight: 0.5,
        bindings: [
          {
            meshId: faceMesh.persistentId,
            targetIndex: 0,
            targetName: 'smile',
            weight: 1
          }
        ]
      }
    ]);
  });

  test('applies morph target group only to matching asset mesh bindings', () => {
    const model = new SharedModel();
    const assetNode = new AssetHierarchyNode('face', model);
    const assetMesh = createAssetMesh('face-0', ['smile']);
    assetNode.mesh = assetMesh;
    model.buildMorphTargetGroupsByName();

    const scene = new Scene();
    const root = new SceneNode(scene);
    root.sharedModel = model;

    const faceMesh = new Mesh(scene);
    faceMesh.parent = root;
    setMorphInfo(faceMesh, ['smile']);
    setSceneMeshAssetBinding(faceMesh, {
      node: assetNode,
      mesh: assetMesh,
      subMesh: assetMesh.subMeshes[0]
    });

    const unrelatedMesh = new Mesh(scene);
    unrelatedMesh.parent = root;
    setMorphInfo(unrelatedMesh, ['smile']);

    root.setMorphTargetGroupWeight('smile', 0.75);

    expect(faceMesh.getMorphWeight('smile')).toBe(0.75);
    expect(unrelatedMesh.getMorphWeight('smile')).toBe(0);
  });

  test('serializes and restores runtime morph target groups', () => {
    const scene = new Scene();
    const root = new SceneNode(scene);
    const faceMesh = new Mesh(scene);
    faceMesh.parent = root;
    setMorphInfo(faceMesh, ['smile']);
    root.morphTargetGroups = [
      {
        name: 'happy',
        weight: 0.5,
        bindings: [
          {
            mesh: faceMesh,
            targetIndex: 0,
            targetName: 'smile',
            weight: 1
          }
        ]
      }
    ];

    const serialized = root.getSerializedMorphTargetGroups();
    expect(serialized).toEqual([
      {
        name: 'happy',
        isBinary: undefined,
        weight: 0.5,
        bindings: [
          {
            meshId: faceMesh.persistentId,
            targetIndex: 0,
            targetName: 'smile',
            weight: 1
          }
        ]
      }
    ]);

    const restoredRoot = new SceneNode(scene);
    const restoredFaceMesh = new Mesh(scene);
    restoredFaceMesh.persistentId = faceMesh.persistentId;
    restoredFaceMesh.parent = restoredRoot;
    setMorphInfo(restoredFaceMesh, ['smile']);

    restoredRoot.setSerializedMorphTargetGroups(serialized);
    expect(restoredRoot.collectMorphTargetGroupNames()).toEqual(['happy']);
    expect(restoredFaceMesh.getMorphWeight('smile')).toBe(0.5);

    restoredRoot.setMorphTargetGroupWeight('happy', 0.25);
    expect(restoredRoot.getMorphTargetGroupWeight('happy')).toBe(0.25);
    expect(restoredFaceMesh.getMorphWeight('smile')).toBe(0.25);
  });

  test('round-trips morph target groups through SceneNode serialization', async () => {
    const scene = new Scene();
    const root = new SceneNode(scene);
    root.remove();
    const faceMesh = new Mesh(scene);
    faceMesh.parent = root;
    setMorphInfo(faceMesh, ['smile']);
    root.morphTargetGroups = [
      {
        name: 'happy',
        weight: 0.5,
        bindings: [
          {
            mesh: faceMesh,
            targetIndex: 0,
            targetName: 'smile',
            weight: 1
          }
        ]
      }
    ];

    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const serialized = await manager.serializeObject(root);
    const restored = (await manager.deserializeObject<SceneNode>(new SceneNode(scene), serialized))!;
    const restoredMesh = restored.children[0] as Mesh;

    expect(restored.collectMorphTargetGroupNames()).toEqual(['happy']);
    expect(restored.getMorphTargetGroupWeight('happy')).toBe(0.5);
    expect(restoredMesh.getMorphWeight('smile')).toBe(0.5);

    restored.setMorphTargetGroupWeight('happy', 0.25);
    expect(restoredMesh.getMorphWeight('smile')).toBe(0.25);
  });

  test('updates serialized morph bounding info after weight changes', async () => {
    const scene = new Scene();
    const root = new SceneNode(scene);
    root.remove();
    const faceMesh = new Mesh(scene);
    faceMesh.parent = root;
    setMorphInfo(faceMesh, ['smile'], [0.5]);
    faceMesh.setMorphBoundingInfo({
      originBox: new BoundingBox(new Vector3(0, 0, 0), new Vector3(1, 1, 1)),
      targetBoxes: [new BoundingBox(new Vector3(-1, -2, -3), new Vector3(2, 3, 4))]
    });
    expectBoundingBox(faceMesh.getAnimatedBoundingBox(), [-0.5, -1, -1.5], [2, 2.5, 3]);

    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const serialized = await manager.serializeObject(root);
    const restored = (await manager.deserializeObject<SceneNode>(new SceneNode(scene), serialized))!;
    const restoredMesh = restored.children[0] as Mesh;

    expectBoundingBox(restoredMesh.getAnimatedBoundingBox(), [-0.5, -1, -1.5], [2, 2.5, 3]);

    restoredMesh.setMorphWeight('smile', 1);
    expectBoundingBox(restoredMesh.getAnimatedBoundingBox(), [-1, -2, -3], [3, 4, 5]);
  });

  test('keeps combined animated bounds stable when skinning and morphing are both active', () => {
    const scene = new Scene();
    const root = new SceneNode(scene);
    const mesh = new Mesh(scene);
    mesh.parent = root;
    setMorphInfo(mesh, ['smile'], [0.5]);
    mesh.setMorphBoundingInfo({
      originBox: new BoundingBox(new Vector3(0, 0, 0), new Vector3(1, 1, 1)),
      targetBoxes: [new BoundingBox(new Vector3(-1, -2, -3), new Vector3(2, 3, 4))]
    });
    mesh.setBoneMatrices({ dispose() {} } as any);
    mesh.setSkinnedBoundingInfo({
      boundingVertices: [],
      boundingVertexBlendIndices: new Float32Array(24),
      boundingVertexJointWeights: new Float32Array(24),
      boundingBox: new BoundingBox(new Vector3(10, 10, 10), new Vector3(11, 11, 11))
    });
    (mesh as any).refreshAnimatedBoundingBox();

    expectBoundingBox(mesh.getAnimatedBoundingBox(), [-0.5, -1, -1.5], [11, 11, 11]);
  });
});
