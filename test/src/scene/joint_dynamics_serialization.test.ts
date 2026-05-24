import { DRef, MemoryFS, Vector3 } from '@zephyr3d/base';
import {
  ColliderForce,
  JointDynamicsModifier,
  JointDynamicsSystem,
  ResourceManager,
  Scene,
  SceneNode,
  Skeleton,
  createTransformAccess
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

function appendNode(parent: SceneNode, name: string) {
  const node = new SceneNode(parent.scene);
  node.name = name;
  node.parent = parent;
  return node;
}

describe('JointDynamics serialization', () => {
  let updateJointMatricesSpy: jest.SpyInstance;

  beforeAll(() => {
    updateJointMatricesSpy = jest
      .spyOn(Skeleton.prototype as any, 'updateJointMatrices')
      .mockImplementation(() => undefined);
  });

  afterAll(() => {
    updateJointMatricesSpy.mockRestore();
  });

  it('round-trips joint dynamics modifiers through SceneNode serialization', async () => {
    const scene = new Scene();
    const model = appendNode(scene.rootNode, 'model');
    const root = appendNode(model, 'root');
    const mid = appendNode(root, 'mid');
    const tip = appendNode(mid, 'tip');
    const colliderNode = appendNode(model, 'collider');
    const grabberNode = appendNode(model, 'grabber');

    mid.position.setXYZ(0, 1, 0);
    tip.position.setXYZ(0, 2, 0);
    colliderNode.position.setXYZ(1, 0, 0);
    grabberNode.position.setXYZ(0, 1, 1);

    const skeleton = new Skeleton(
      [root, mid, tip],
      [root, mid, tip].map(() => root.worldMatrix.clone()),
      [root, mid, tip].map((node) => ({
        position: node.position.clone(),
        rotation: node.rotation.clone(),
        scale: node.scale.clone()
      }))
    );
    model.animationSet.skeletons.push(new DRef(skeleton));

    const system = new JointDynamicsSystem(
      {
        chainConfig: {
          systemRoot: model,
          chains: [{ start: root, end: tip }]
        },
        controllerConfig: {
          subSteps: 5,
          blendRatio: 0.25,
          windForce: grabberNode.position.clone(),
          preserveTwist: true
        }
      },
      [
        {
          r: {
            radius: 0.5,
            radiusTailScale: 1,
            height: 0,
            friction: 0.2,
            isInverseCollider: false,
            forceType: ColliderForce.Push
          },
          transform: createTransformAccess(colliderNode)
        }
      ],
      [
        {
          r: {
            radius: 0.75,
            force: 0.5
          },
          transform: createTransformAccess(grabberNode),
          enabled: true
        }
      ],
      [
        {
          up: new Vector3(0, 1, 0),
          position: new Vector3(0, -1, 0)
        }
      ]
    );
    system.controller.setColliderEnabledAt(0, false);
    const modifier = new JointDynamicsModifier(system);
    skeleton.modifiers.push(modifier);

    const manager = new ResourceManager(new MemoryFS());
    const serialized = await manager.serializeObject(model);
    const container = new SceneNode(scene);
    container.remove();
    const restored = (await manager.deserializeObject<SceneNode>(container, serialized))!;
    restored.parent = scene.rootNode;

    const restoredSkeleton = restored.animationSet.skeletons[0].get()!;
    const restoredModifier = restoredSkeleton.modifiers[0] as JointDynamicsModifier;
    const restoredSystem = restoredModifier.jointDynamicsSystem;
    const restoredSystemSnapshot = restoredSystem as any;

    expect(restoredModifier).toBeInstanceOf(JointDynamicsModifier);
    expect(restoredSystemSnapshot.chainConfig.systemRoot.name).toBe('model');
    expect(restoredSystemSnapshot.chainConfig.chains).toHaveLength(1);
    expect(restoredSystemSnapshot.chainConfig.chains[0].start.name).toBe('root');
    expect(restoredSystemSnapshot.chainConfig.chains[0].end.name).toBe('tip');
    expect(restoredSystem.controller.getConfig().subSteps).toBe(5);
    expect(restoredSystem.controller.getConfig().blendRatio).toBeCloseTo(0.25);
    expect(restoredSystem.controller.getConfig().preserveTwist).toBe(true);
    expect(restoredSystem.controller.colliderCount).toBe(1);
    expect(restoredSystem.controller.grabberCount).toBe(1);
    expect(restoredSystem.controller.flatPlaneCount).toBe(1);
    expect(restoredSystemSnapshot.getColliderSnapshots()[0].enabled).toBe(false);
    expect(restoredSystemSnapshot.getColliderSnapshots()[0].transform.name).toBe('collider');
    expect(restoredSystemSnapshot.getGrabberSnapshots()[0].enabled).toBe(true);
    expect(restoredSystemSnapshot.getGrabberSnapshots()[0].transform.name).toBe('grabber');
    expect(restoredSystemSnapshot.getFlatPlaneSnapshots()[0].position.y).toBeCloseTo(-1);
  });
});
