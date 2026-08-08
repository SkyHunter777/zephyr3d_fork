import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryFS } from '@zephyr3d/base';
import { ResourceManager, Scene, SceneNode } from '@zephyr3d/scene';

const legacySpringConfig = {
  ClassName: 'SpringScriptConfig',
  Object: {
    Enabled: true,
    ModifierWeight: 0.75,
    Damping: 0.9,
    Stiffness: 0.82,
    BoneChains: [
      {
        ClassName: 'SpringBoneChain',
        Object: {
          StartBone: 'joint2',
          EndBone: 'joint8'
        }
      }
    ],
    Gravity: [0, -9.8, 0],
    Iterations: 5,
    EnableInertialForces: true,
    CentrifugalScale: 2,
    CoriolisScale: 1,
    Solver: 'xpbd',
    PoseFollowRoot: 0.2,
    PoseFollowTip: 0.1,
    MaxPoseOffsetRoot: 0.2,
    MaxPoseOffsetTip: 0.4,
    ColliderOffset: [0, 1.5, 0],
    ColliderRadius: 0.15
  }
};

describe('legacy scene-node spring script compatibility', () => {
  test('migrates SpringConfig to the current script attachment config', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    const node = await manager.deserializeObject<SceneNode>(container, {
      ClassName: 'SceneNode',
      Object: {
        Name: 'legacy spring host',
        Script: '/assets/@builtins/scripts/springtest',
        SpringConfig: legacySpringConfig
      }
    });

    expect(node!.script).toBe('/assets/@builtins/scripts/springtest');
    expect(node!.scriptConfig).toMatchObject({
      __editorPluginType: 'springtest',
      enabled: true,
      modifierWeight: 0.75,
      chainDamping: 0.9,
      chainStiffness: 0.82,
      gravity: [0, -9.8, 0],
      iterations: 5,
      chains: [{ startBone: 'joint2', endBone: 'joint8' }],
      colliders: [
        {
          type: 'sphere',
          offsetX: 0,
          offsetY: 1.5,
          offsetZ: 0,
          radius: 0.15
        }
      ]
    });

    const serialized = await manager.serializeObject(node!);
    expect(serialized.Object).not.toHaveProperty('SpringConfig');
    expect(serialized.Object).toHaveProperty('ScriptConfig');
  });

  test('uses BuiltInScript when the legacy asset has no Script field', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    const node = await manager.deserializeObject<SceneNode>(container, {
      ClassName: 'SceneNode',
      Object: {
        BuiltInScript: '/assets/@builtins/scripts/springtest',
        SpringConfig: legacySpringConfig
      }
    });

    expect(node!.script).toBe('/assets/@builtins/scripts/springtest');
    expect(node!.scriptConfig).toMatchObject({ __editorPluginType: 'springtest' });
  });

  test('keeps current Script and ScriptConfig fields authoritative', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    const node = await manager.deserializeObject<SceneNode>(container, {
      ClassName: 'SceneNode',
      Object: {
        Script: '/assets/plugins/current.js',
        BuiltInScript: '/assets/@builtins/scripts/springtest',
        ScriptConfig: { enabled: false, source: 'current' },
        SpringConfig: legacySpringConfig
      }
    });

    expect(node!.script).toBe('/assets/plugins/current.js');
    expect(node!.scriptConfig).toEqual({ enabled: false, source: 'current' });
  });
});

const labAssetsRoot =
  process.env.ZEPHYR3D_LAB_ASSETS_DIR ?? resolve(__dirname, '../../../../lab/digitalman/assets');
const legacyPrefabPaths = [
  resolve(labAssetsRoot, 'model/prop/chocolate/chocolate.zprefab'),
  resolve(labAssetsRoot, 'model/prop/chocolate/chocolateSpring.zprefab')
];
const describeWithLabAssets = legacyPrefabPaths.every((path) => existsSync(path)) ? describe : describe.skip;

function removeSerializedMeshes(node: any): void {
  const children = node?.Object?.Children;
  if (!Array.isArray(children)) {
    return;
  }
  node.Object.Children = children.filter((child: any) => child?.ClassName !== 'Mesh');
  node.Object.Children.forEach((child: any) => removeSerializedMeshes(child));
}

describeWithLabAssets('digitalman legacy spring prefab baseline', () => {
  test.each(legacyPrefabPaths)('locks the old SpringConfig layout in %s', (path) => {
    const content = JSON.parse(readFileSync(path, 'utf8'));
    const object = content.data.Object;

    expect(object.Script).toMatch(/springtest$/);
    expect(object.SpringConfig).toMatchObject({
      ClassName: 'SpringScriptConfig',
      Object: {
        Enabled: true,
        BoneChains: [
          {
            ClassName: 'SpringBoneChain'
          }
        ]
      }
    });
    expect(object).not.toHaveProperty('ScriptConfig');
  });

  test.each(legacyPrefabPaths)('restores the old spring config from %s', async (path) => {
    const content = JSON.parse(readFileSync(path, 'utf8'));
    removeSerializedMeshes(content.data);
    delete content.data.Object.Skeletons;
    delete content.data.Object.Animations;
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    const node = await manager.deserializeObject<SceneNode>(container, content.data);

    expect(node!.script).toMatch(/springtest$/);
    expect(node!.scriptConfig).toMatchObject({
      __editorPluginType: 'springtest',
      enabled: true,
      chainDamping: 0.9,
      chains: [{ startBone: 'joint2', endBone: 'joint8' }]
    });
  });
});
