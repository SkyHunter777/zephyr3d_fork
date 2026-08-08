import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DRef, MemoryFS, Vector3 } from '@zephyr3d/base';
import {
  MultiChainSpringSystem,
  ResourceManager,
  Scene,
  SceneNode,
  Skeleton,
  SpringChain,
  SpringModifier,
  SpringSystem,
  createCapsuleCollider,
  createPlaneCollider,
  createSphereCollider,
  createSpringParticle,
  updateColliderFromNode
} from '@zephyr3d/scene';

jest.mock('@zephyr3d/scene/app/api', () => ({
  getDevice: jest.fn(() => ({
    createTexture2D: (_format: string, width: number, height: number) => ({
      width,
      height,
      update: () => undefined,
      dispose: () => undefined
    })
  }))
}));

function appendNode(parent: SceneNode, name: string, y = 0) {
  const node = new SceneNode(parent.scene);
  node.name = name;
  node.position.y = y;
  node.parent = parent;
  return node;
}

function createSkeleton(model: SceneNode, joints: SceneNode[]) {
  const skeleton = new Skeleton(
    joints,
    joints.map(() => model.worldMatrix.clone()),
    joints.map((node) => ({
      position: node.position.clone(),
      rotation: node.rotation.clone(),
      scale: node.scale.clone()
    }))
  );
  model.animationSet.skeletons.push(new DRef(skeleton));
  return skeleton;
}

function removeSerializedKey(value: unknown, key: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => removeSerializedKey(item, key));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    delete record[key];
    Object.values(record).forEach((item) => removeSerializedKey(item, key));
  }
}

function removeSerializedMeshes(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const item = value[index] as Record<string, unknown> | null;
      if (item?.ClassName === 'Mesh') {
        value.splice(index, 1);
      } else {
        removeSerializedMeshes(item);
      }
    }
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(removeSerializedMeshes);
  }
}

function findSpringModifier(node: SceneNode): SpringModifier {
  const modifier = node.animationSet.rigs
    .flatMap((rigRef) => rigRef.get()!.modifiers)
    .find((item) => item instanceof SpringModifier);
  if (!(modifier instanceof SpringModifier)) {
    throw new Error('Restored SpringModifier not found');
  }
  return modifier;
}

describe('SpringModifier serialization', () => {
  let updateJointMatricesSpy: jest.SpyInstance;

  beforeAll(() => {
    updateJointMatricesSpy = jest
      .spyOn(Skeleton.prototype as any, 'updateJointMatrices')
      .mockImplementation(() => undefined);
  });

  afterAll(() => {
    updateJointMatricesSpy.mockRestore();
  });

  test('round-trips lab multi-chain options, anchors, constraints and colliders', async () => {
    const scene = new Scene();
    const model = appendNode(scene.rootNode, 'model');
    const rootA = appendNode(model, 'rootA');
    const midA = appendNode(rootA, 'midA', 1);
    const tipA = appendNode(midA, 'tipA', 1);
    const rootB = appendNode(model, 'rootB');
    const tipB = appendNode(rootB, 'tipB', 1.5);
    const endAnchor = appendNode(model, 'endAnchor', 2);
    const colliderNode = appendNode(model, 'colliderNode', 0.5);
    const skeleton = createSkeleton(model, [rootA, midA, tipA, rootB, tipB]);

    const chainA = SpringChain.fromBoneChain(rootA, tipA, {
      mass: 1.25,
      damping: 0.87,
      stiffness: 0.73
    });
    chainA.particles[2].fixed = true;
    chainA.particles[2].anchorNode = endAnchor;
    chainA.particles[2].anchorOffset = new Vector3(0.1, 0.2, 0.3);
    chainA.constraints[0].compliance = 0.0002;
    const chainB = SpringChain.fromBoneChain(rootB, tipB, {
      mass: 0.8,
      damping: 0.91,
      stiffness: 0.66
    });

    const system = new MultiChainSpringSystem({
      iterations: 8,
      gravity: new Vector3(0, -4.5, 0),
      wind: new Vector3(0.2, 0, -0.1),
      enableInertialForces: false,
      centrifugalScale: 1.7,
      coriolisScale: 0.4,
      solver: 'xpbd',
      poseFollow: 0.3,
      poseFollowRoot: 0.22,
      poseFollowTip: 0.08,
      poseFollowExponent: 2.1,
      maxPoseOffset: 0.5,
      maxPoseOffsetRoot: 0.25,
      maxPoseOffsetTip: 0.7
    });
    system.addChain(chainA);
    system.addChain(chainB);
    system.addInterChainConstraint({
      chainAIndex: 0,
      chainBIndex: 1,
      particleAIndex: 1,
      particleBIndex: 1,
      restLength: 0.45,
      stiffness: 0.6,
      compliance: 0.0001,
      lambda: 3
    });
    const sphere = createSphereCollider(new Vector3(0.1, 0.2, 0.3), 0.4, colliderNode);
    sphere.enabled = false;
    system.addCollider(sphere);
    system.addCollider(createCapsuleCollider(new Vector3(0, 0, 0), new Vector3(0, 1, 0), 0.2, colliderNode));
    system.addCollider(createPlaneCollider(new Vector3(0, -1, 0), new Vector3(0, 1, 0)));

    const modifier = new SpringModifier(system as any, 0.65);
    modifier.sourceId = 'spring-config:test-outfit';
    modifier.enabled = false;
    skeleton.modifiers.push(modifier);

    const manager = new ResourceManager(new MemoryFS());
    const serialized = await manager.serializeObject(model);
    const container = new SceneNode(scene);
    container.remove();
    const restored = (await manager.deserializeObject<SceneNode>(container, serialized))!;
    const restoredModifier = findSpringModifier(restored);
    const restoredSystem = restoredModifier.springSystem as any as MultiChainSpringSystem;

    expect(restoredModifier.sourceId).toBe('spring-config:test-outfit');
    expect(restoredModifier.enabled).toBe(false);
    expect(restoredModifier.weight).toBeCloseTo(0.65);
    expect(restoredSystem).toBeInstanceOf(MultiChainSpringSystem);
    expect(restoredSystem.iterations).toBe(8);
    expect(restoredSystem.gravity.y).toBeCloseTo(-4.5);
    expect(restoredSystem.poseFollowRoot).toBeCloseTo(0.22);
    expect(restoredSystem.poseFollowTip).toBeCloseTo(0.08);
    expect(restoredSystem.maxPoseOffsetTip).toBeCloseTo(0.7);
    expect(restoredSystem.chains).toHaveLength(2);
    expect(restoredSystem.chains[0].particles.map((particle) => particle.node?.name)).toEqual([
      'rootA',
      'midA',
      'tipA'
    ]);
    expect(restoredSystem.chains[0].particles[2].anchorNode?.name).toBe('endAnchor');
    expect(restoredSystem.chains[0].particles[2].anchorOffset?.z).toBeCloseTo(0.3);
    expect(restoredSystem.chains[0].constraints[0].compliance).toBeCloseTo(0.0002);
    expect(restoredSystem.interChainConstraints[0].lambda).toBe(0);
    expect(restoredSystem.colliders).toHaveLength(3);
    expect(restoredSystem.colliders[0].node?.name).toBe('colliderNode');
    expect(restoredSystem.colliders[0].enabled).toBe(false);
  });

  test('preserves single-chain systems and legacy collider radius scaling', async () => {
    const scene = new Scene();
    const model = appendNode(scene.rootNode, 'model');
    const root = appendNode(model, 'root');
    const tip = appendNode(root, 'tip', 1);
    const colliderNode = appendNode(model, 'colliderNode');
    colliderNode.scale.setXYZ(0.01, 0.01, 0.01);
    const skeleton = createSkeleton(model, [root, tip]);
    const system = new SpringSystem(SpringChain.fromBoneChain(root, tip), { iterations: 3 });
    const collider = createCapsuleCollider(new Vector3(10, 0, 0), new Vector3(-10, 0, 0), 13, colliderNode);
    collider.localRadiusScaleRef = 1;
    updateColliderFromNode(collider);
    system.addCollider(collider);
    skeleton.modifiers.push(new SpringModifier(system, 0.4));

    const manager = new ResourceManager(new MemoryFS());
    const serialized = await manager.serializeObject(model);
    removeSerializedKey(serialized, 'localRadiusScaleRef');
    const container = new SceneNode(scene);
    container.remove();
    const restored = (await manager.deserializeObject<SceneNode>(container, serialized))!;
    const restoredModifier = findSpringModifier(restored);
    const restoredCollider = restoredModifier.springSystem.colliders[0] as typeof collider;
    updateColliderFromNode(restoredCollider);

    expect(restoredModifier.springSystem).toBeInstanceOf(SpringSystem);
    expect(restoredModifier.springSystem.iterations).toBe(3);
    expect(restoredModifier.weight).toBeCloseTo(0.4);
    expect(restoredCollider.localRadiusScaleRef).toBeCloseTo(1);
    expect(restoredCollider.radius).toBeCloseTo(0.13);
  });

  test('uses restored anchors, pose settings and colliders during multi-chain simulation', () => {
    const scene = new Scene();
    const model = appendNode(scene.rootNode, 'model');
    const drivenNode = appendNode(model, 'driven');
    const anchorNode = appendNode(model, 'anchor');
    anchorNode.position.x = 2;
    const anchoredChain = new SpringChain();
    anchoredChain.addParticle(
      createSpringParticle(Vector3.zero(), {
        fixed: true,
        node: drivenNode,
        anchorNode,
        anchorOffset: new Vector3(0.5, 0, 0)
      })
    );
    const anchoredSystem = new MultiChainSpringSystem({
      gravity: Vector3.zero(),
      enableInertialForces: false,
      poseFollow: 0
    });
    anchoredSystem.addChain(anchoredChain);
    anchoredSystem.update(1 / 60);
    expect(anchoredChain.particles[0].position.x).toBeCloseTo(2.5);

    const collisionChain = new SpringChain();
    collisionChain.addParticle(createSpringParticle(new Vector3(0.5, 0, 0), { damping: 0, fixed: false }));
    const collisionSystem = new MultiChainSpringSystem({
      gravity: Vector3.zero(),
      enableInertialForces: false,
      iterations: 1,
      poseFollow: 0
    });
    collisionSystem.addChain(collisionChain);
    collisionSystem.addCollider(createSphereCollider(Vector3.zero(), 1));
    collisionSystem.update(1 / 60);
    expect(collisionChain.particles[0].position.x).toBeCloseTo(1);
  });
});

const labHairPrefab = resolve(
  process.env.ZEPHYR3D_LAB_ASSETS_DIR ?? resolve(__dirname, '../../../../lab/digitalman/assets'),
  'prefabs/character/BigElectricPeople/female/hair/hair_woman_A.zprefab'
);
const labAssetsRoot = resolve(labHairPrefab, '../../../../../..');
const describeWithLabHair = existsSync(labHairPrefab) ? describe : describe.skip;

function collectPrefabFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPrefabFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.zprefab')) {
      files.push(path);
    }
  }
  return files;
}

function collectSpringModifierInit(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSpringModifierInit(item, output));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.ClassName === 'SpringModifier' && record.Init && typeof record.Init === 'object') {
      output.push(record.Init as Record<string, unknown>);
    }
    Object.values(record).forEach((item) => collectSpringModifierInit(item, output));
  }
}

describeWithLabHair('lab SpringModifier prefab compatibility', () => {
  test('locks all digitalman SpringModifier payloads to the supported schema', () => {
    const records: Record<string, unknown>[] = [];
    for (const path of collectPrefabFiles(labAssetsRoot)) {
      collectSpringModifierInit(JSON.parse(readFileSync(path, 'utf8')), records);
    }

    expect(records).toHaveLength(14);
    expect(new Set(records.map((record) => record.systemType))).toEqual(new Set(['multi']));
    for (const record of records) {
      expect(record.options).toEqual(
        expect.objectContaining({
          iterations: expect.any(Number),
          gravity: expect.any(Array),
          wind: expect.any(Array),
          solver: expect.stringMatching(/^(verlet|xpbd)$/),
          poseFollowRoot: expect.any(Number),
          poseFollowTip: expect.any(Number),
          maxPoseOffsetRoot: expect.any(Number),
          maxPoseOffsetTip: expect.any(Number)
        })
      );
      expect(Array.isArray(record.chains)).toBe(true);
      expect((record.chains as unknown[]).length).toBeGreaterThan(0);
    }
  });

  test('restores the real hair prefab spring configuration without loading mesh assets', async () => {
    const prefab = JSON.parse(readFileSync(labHairPrefab, 'utf8')) as {
      data: Record<string, unknown>;
    };
    removeSerializedMeshes(prefab.data);
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    const restored = (await manager.deserializeObject<SceneNode>(container, prefab.data))!;
    const modifiers = restored.animationSet.rigs.flatMap((rigRef) =>
      rigRef.get()!.modifiers.filter((modifier) => modifier instanceof SpringModifier)
    ) as SpringModifier[];

    expect(modifiers).not.toHaveLength(0);
    expect(modifiers[0].sourceId).toMatch(/^spring:/);
    const system = modifiers[0].springSystem as any as MultiChainSpringSystem;
    expect(system).toBeInstanceOf(MultiChainSpringSystem);
    expect(system.chains.length).toBeGreaterThan(1);
    expect(system.poseFollowRoot).toBeCloseTo(0.15);
    expect(system.maxPoseOffsetTip).toBeCloseTo(0.4);
  });
});
