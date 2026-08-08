import { MemoryFS, uint8ArrayToBase64, Vector3 } from '@zephyr3d/base';
import {
  applyMeshSkinInfluenceData,
  BoundingBox,
  DEFAULT_SKIN_INFLUENCE_LIMIT,
  Mesh,
  ResourceManager,
  Scene,
  setSkinInfluenceLimit,
  type AssetPrimitiveInfo,
  type AssetSubMeshData
} from '../../../libs/scene/src';
import { GLTFImporter } from '../../../libs/loaders/src/gltf/gltf_importer';

let mockResourceManager: ResourceManager | null = null;

jest.mock('../../../libs/scene/src/app/api', () => ({
  getDevice: jest.fn(() => ({
    type: 'webgpu',
    frameInfo: {
      frameCounter: 0,
      elapsedFrame: 16.6667,
      elapsedOverall: 16.6667
    },
    createTexture2D: jest.fn((_format, width, height) => ({
      width,
      height,
      update: jest.fn(),
      dispose: jest.fn()
    })),
    getDeviceCaps: jest.fn(() => ({ textureCaps: { maxTextureSize: 4096 } }))
  })),
  getEngine: jest.fn(() => ({ resourceManager: mockResourceManager })),
  tryGetApp: jest.fn(() => null)
}));

function createBoundingVertices() {
  return Array.from({ length: 6 }, (_, index) => new Vector3(index, index + 0.25, index + 0.5));
}

function serializeLegacyBoundingInfo() {
  const blendIndices = new Float32Array(Array.from({ length: 24 }, (_, index) => index));
  const jointWeights = new Float32Array(Array.from({ length: 24 }, (_, index) => (index + 1) / 100));
  const vertices = createBoundingVertices();
  const payload = new Float32Array(24 + 24 + 6 * 3);
  payload.set(blendIndices, 0);
  payload.set(jointWeights, 24);
  vertices.forEach((vertex, index) => payload.set(vertex, 48 + index * 3));
  return {
    blendIndices,
    jointWeights,
    vertices,
    encoded: uint8ArrayToBase64(new Uint8Array(payload.buffer))
  };
}

describe('skin influence data', () => {
  afterEach(() => {
    setSkinInfluenceLimit(DEFAULT_SKIN_INFLUENCE_LIMIT);
  });

  test('reads legacy 4-influence bounding data and writes the versioned layout', async () => {
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const legacy = serializeLegacyBoundingInfo();

    await manager.deserializeObjectProps(mesh, { SkinnedBoundingInfo: legacy.encoded });

    expect(mesh.skinnedBoundingInfo?.influenceCount).toBe(4);
    expect(Array.from(mesh.skinnedBoundingInfo!.boundingVertexBlendIndices)).toEqual(
      Array.from(legacy.blendIndices)
    );
    expect(Array.from(mesh.skinnedBoundingInfo!.boundingVertexJointWeights)).toEqual(
      Array.from(legacy.jointWeights)
    );
    expect(mesh.skinnedBoundingInfo!.boundingVertices.map((vertex) => Array.from(vertex))).toEqual(
      legacy.vertices.map((vertex) => Array.from(vertex))
    );

    const serialized = await manager.serializeObject(mesh);
    const encoded = (serialized.Object as Record<string, string>).SkinnedBoundingInfo;
    const bytes = Buffer.from(encoded, 'base64');
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(floats).toHaveLength(1 + 24 + 24 + 18);
    expect(floats[0]).toBe(4);

    const restored = new Mesh(scene);
    await manager.deserializeObjectProps(restored, { SkinnedBoundingInfo: encoded });
    expect(restored.skinnedBoundingInfo?.influenceCount).toBe(4);
    expect(Array.from(restored.skinnedBoundingInfo!.boundingVertexBlendIndices)).toEqual(
      Array.from(legacy.blendIndices)
    );
  });

  test('round-trips 12-influence bounding data', async () => {
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const blendIndices = new Float32Array(Array.from({ length: 72 }, (_, index) => index % 17));
    const jointWeights = new Float32Array(Array.from({ length: 72 }, (_, index) => ((index % 12) + 1) / 100));
    const vertices = createBoundingVertices();
    mesh.setSkinnedBoundingInfo({
      influenceCount: 12,
      boundingVertexBlendIndices: blendIndices,
      boundingVertexJointWeights: jointWeights,
      boundingVertices: vertices,
      boundingBox: new BoundingBox()
    });

    const serialized = await manager.serializeObject(mesh);
    const encoded = (serialized.Object as Record<string, string>).SkinnedBoundingInfo;
    const restored = new Mesh(scene);
    await manager.deserializeObjectProps(restored, { SkinnedBoundingInfo: encoded });

    expect(restored.skinnedBoundingInfo?.influenceCount).toBe(12);
    expect(Array.from(restored.skinnedBoundingInfo!.boundingVertexBlendIndices)).toEqual(
      Array.from(blendIndices)
    );
    expect(Array.from(restored.skinnedBoundingInfo!.boundingVertexJointWeights)).toEqual(
      Array.from(jointWeights)
    );
    expect(restored.skinnedBoundingInfo!.boundingVertices.map((vertex) => Array.from(vertex))).toEqual(
      vertices.map((vertex) => Array.from(vertex))
    );
  });

  test('round-trips the lab SkinInfluenceData payload and rebuilds its texture', async () => {
    const manager = new ResourceManager(new MemoryFS());
    mockResourceManager = manager;
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const data = new Float32Array(Array.from({ length: 16 }, (_, index) => index + 0.5));
    mesh.setSkinInfluenceData({ width: 2, height: 2, influenceCount: 12, data });

    const serialized = await manager.serializeObject(mesh);
    const encoded = (serialized.Object as Record<string, string>).SkinInfluenceData;
    const bytes = Buffer.from(encoded, 'base64');
    expect(bytes.readUInt32LE(0)).toBe(2);
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(12);

    const restored = new Mesh(scene);
    await manager.deserializeObjectProps(restored, { SkinInfluenceData: encoded });

    const restoredData = restored.getSkinInfluenceData()!;
    expect(restoredData.width).toBe(2);
    expect(restoredData.height).toBe(2);
    expect(restoredData.influenceCount).toBe(12);
    expect(Array.from(restoredData.data)).toEqual(Array.from(data));
    expect(restoredData.texture?.get()).not.toBeNull();
    expect((restoredData.texture?.get() as any).update).toHaveBeenCalledWith(data, 0, 0, 2, 2);
  });

  test('packs influences beyond the base four into per-vertex texture texels', () => {
    const scene = new Scene();
    const mesh = new Mesh(scene);
    const rawBlendIndices = new Uint16Array(Array.from({ length: 24 }, (_, index) => index + 10));
    const rawJointWeights = new Float32Array(Array.from({ length: 24 }, (_, index) => (index + 1) / 100));
    const subMesh: AssetSubMeshData = {
      name: 'face',
      primitive: null,
      material: null,
      rawPositions: new Float32Array(6),
      rawBlendIndices,
      rawJointWeights,
      rawSkinInfluenceCount: 12,
      numTargets: 0
    };

    applyMeshSkinInfluenceData(subMesh, mesh);

    const skinData = mesh.getSkinInfluenceData()!;
    expect(skinData.width).toBe(3);
    expect(skinData.height).toBe(3);
    expect(skinData.influenceCount).toBe(12);
    const expected: number[] = [];
    for (let vertexIndex = 0; vertexIndex < 2; vertexIndex++) {
      for (let pairIndex = 0; pairIndex < 4; pairIndex++) {
        const sourceIndex = vertexIndex * 12 + 4 + pairIndex * 2;
        expected.push(
          rawBlendIndices[sourceIndex],
          rawJointWeights[sourceIndex],
          rawBlendIndices[sourceIndex + 1],
          rawJointWeights[sourceIndex + 1]
        );
      }
    }
    expect(Array.from(skinData.data.slice(0, expected.length))).toEqual(expected);
    expect(Array.from(skinData.data.slice(expected.length))).toEqual([0, 0, 0, 0]);
  });

  test('merges and normalizes all GLTF joint-weight sets up to the configured limit', () => {
    setSkinInfluenceLimit(12);
    const weights = [0.12, 0.01, 0.11, 0.02, 0.1, 0.03, 0.09, 0.04, 0.08, 0.05, 0.07, 0.06];
    const accessors = [
      new Uint16Array([0, 1, 2, 3]),
      new Float32Array(weights.slice(0, 4)),
      new Uint16Array([4, 5, 6, 7]),
      new Float32Array(weights.slice(4, 8)),
      new Uint16Array([8, 9, 10, 11]),
      new Float32Array(weights.slice(8, 12))
    ].map((data) => ({
      count: 1,
      type: 'VEC4',
      getComponentCount: () => 4,
      getNormalizedDeinterlacedView: () => data
    }));
    const primitive: AssetPrimitiveInfo = {
      name: 'face',
      vertices: {} as AssetPrimitiveInfo['vertices'],
      indices: null,
      indexCount: 1,
      type: 'point-list',
      boxMin: Vector3.zero(),
      boxMax: Vector3.zero()
    };
    const subMesh: AssetSubMeshData = {
      name: 'face',
      primitive,
      material: null,
      rawPositions: new Float32Array(3),
      rawBlendIndices: null,
      rawJointWeights: null,
      numTargets: 0
    };
    const importer = new GLTFImporter() as unknown as {
      _finalizeSkinData(
        gltf: unknown,
        attributes: Record<string, number>,
        primitive: AssetPrimitiveInfo,
        subMesh: AssetSubMeshData
      ): void;
    };

    importer._finalizeSkinData(
      { _accessors: accessors },
      {
        JOINTS_0: 0,
        WEIGHTS_0: 1,
        JOINTS_1: 2,
        WEIGHTS_1: 3,
        JOINTS_2: 4,
        WEIGHTS_2: 5
      },
      primitive,
      subMesh
    );

    const expectedJoints = [0, 2, 4, 6, 8, 10, 11, 9, 7, 5, 3, 1];
    const sourceWeights = weights.map((weight) => Math.fround(weight));
    const weightTotal = sourceWeights.reduce((sum, weight) => sum + weight, 0);
    const expectedWeights = sourceWeights
      .sort((a, b) => b - a)
      .map((weight) => Math.fround(weight / weightTotal));
    expect(subMesh.rawSkinInfluenceCount).toBe(12);
    expect(Array.from(subMesh.rawBlendIndices!)).toEqual(expectedJoints);
    expect(Array.from(subMesh.rawJointWeights!)).toEqual(expectedWeights);
    expect(Array.from(primitive.vertices.blendIndices.data)).toEqual(expectedJoints.slice(0, 4));
    expect(Array.from(primitive.vertices.blendWeights.data)).toEqual(expectedWeights.slice(0, 4));
  });

  test('rejects extra influence data when joint indices are incomplete', () => {
    const scene = new Scene();
    const mesh = new Mesh(scene);
    applyMeshSkinInfluenceData(
      {
        name: 'invalid',
        primitive: null,
        material: null,
        rawPositions: new Float32Array(6),
        rawBlendIndices: new Uint16Array(8),
        rawJointWeights: new Float32Array(24),
        rawSkinInfluenceCount: 12,
        numTargets: 0
      },
      mesh
    );

    expect(mesh.getSkinInfluenceData()).toBeNull();
  });
});
