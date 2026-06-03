import { MemoryFS, Vector3 } from '@zephyr3d/base';
import {
  AssetHierarchyNode,
  BoundingBox,
  Mesh,
  ResourceManager,
  Scene,
  SceneNode,
  SharedModel,
  setSceneMeshAssetBinding,
  type AssetMeshData,
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
    }))
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
});
