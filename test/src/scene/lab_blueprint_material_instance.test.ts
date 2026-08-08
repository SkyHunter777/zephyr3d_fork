import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryFS } from '@zephyr3d/base';
import {
  PBRBluePrintMaterial,
  PBRBluePrintMaterialInstance,
  ResourceManager,
  SubsurfaceProfile
} from '@zephyr3d/scene';

let mockResourceManager: ResourceManager;

jest.mock('@zephyr3d/scene/app/api', () => ({
  getEngine: () => ({ resourceManager: mockResourceManager })
}));

const blueprint = {
  type: 'PBRMaterial',
  state: {
    fragment: {
      nodes: [{ id: 1, title: '', locked: true, node: { ClassName: 'PBRBlockNode', Object: {} } }],
      links: [],
      canvasOffset: [0, 0],
      canvasScale: 1
    },
    vertex: {
      nodes: [{ id: 1, title: '', locked: true, node: { ClassName: 'VertexBlockNode', Object: {} } }],
      links: [],
      canvasOffset: [0, 0],
      canvasScale: 1
    }
  }
};

async function writeJson(vfs: MemoryFS, path: string, value: unknown) {
  await vfs.writeFile(path, JSON.stringify(value), { encoding: 'utf8', create: true });
}

describe('lab blueprint material instance compatibility', () => {
  test('loads parent inheritance, uniform overrides and lab subsurface properties', async () => {
    const vfs = new MemoryFS();
    const manager = new ResourceManager(vfs);
    mockResourceManager = manager;
    const blueprintPath = '/materials/parent.zbpt';
    const parentPath = '/materials/parent.zmtl';
    const instancePath = '/materials/instance.zmtl';

    await writeJson(vfs, blueprintPath, blueprint);
    await writeJson(vfs, parentPath, {
      type: 'PBRBluePrintMaterial',
      props: {
        ClearCoat: true,
        RectSpecularScale: 0.25,
        doubleSidedLighting: false,
        SubsurfaceProfile: {
          ClassName: 'SubsurfaceProfile',
          Object: {
            ScatterColor: [0.8, 0.5, 0.3],
            TransmissionTintColor: [0.9, 0.6, 0.4]
          }
        }
      },
      data: {
        IR: blueprintPath,
        uniformValues: [
          {
            name: 'u_tint',
            type: 'float',
            value: [0.2],
            inVertexShader: false,
            inFragmentShader: true
          },
          {
            name: 'u_inherited',
            type: 'float',
            value: [0.4],
            inVertexShader: false,
            inFragmentShader: true
          }
        ],
        uniformTextures: []
      }
    });
    await writeJson(vfs, instancePath, {
      type: 'PBRBluePrintMaterialInstance',
      props: {
        Reflection: 'anisotropic',
        SubsurfaceMeanFreePathColor: [1, 0.45, 0.17],
        SubsurfaceTransmissionTintColor: [1, 0.46, 0.34]
      },
      data: {
        parent: parentPath,
        uniformValues: [
          {
            name: 'u_tint',
            type: 'float',
            value: [0.75]
          }
        ],
        uniformTextures: []
      }
    });

    const parent = await manager.fetchMaterial<PBRBluePrintMaterial>(parentPath);
    const instance = await manager.fetchMaterial<PBRBluePrintMaterialInstance>(instancePath);

    expect(parent).toBeInstanceOf(PBRBluePrintMaterial);
    expect(instance).toBeInstanceOf(PBRBluePrintMaterialInstance);
    expect(instance!.parentMaterial).toBe(parent);
    expect(instance!.parentMaterialId).toBe(parentPath);
    expect(instance!.clearcoat).toBe(true);
    expect(instance!.rectSpecularScale).toBeCloseTo(0.25);
    expect(instance!.doubleSidedLighting).toBe(false);
    expect(instance!.reflectionMode).toBe('anisotropic');
    expect(instance!.uniformValues.find((value) => value.name === 'u_tint')?.value[0]).toBeCloseTo(0.75);
    expect(instance!.uniformValues.find((value) => value.name === 'u_inherited')?.value[0]).toBeCloseTo(0.4);
    expect(instance!.subsurfaceProfile).toBeInstanceOf(SubsurfaceProfile);
    expect(instance!.subsurfaceProfile).not.toBe(parent!.subsurfaceProfile);
    expect(instance!.subsurfaceProfile!.meanFreePathColor.y).toBeCloseTo(0.45);
    expect(instance!.subsurfaceProfile!.transmissionTintColor.z).toBeCloseTo(0.34);

    const isolated = new PBRBluePrintMaterialInstance(instance!.parentMaterial, instance!.parentMaterialId);
    isolated.setOverrides(instance!.uniformValues, instance!.uniformTextures);
    isolated.copyFrom(instance!);
    isolated.setMaterialPropertyOverrides(instance!.getMaterialPropertyOverrides());
    isolated.syncInheritedUniforms();
    expect(isolated.subsurfaceProfile!.meanFreePathColor.y).toBeCloseTo(0.45);
    expect(isolated.subsurfaceProfile!.transmissionTintColor.z).toBeCloseTo(0.34);
  });

  test('reloads parents before instances and preserves only declared instance properties', async () => {
    const vfs = new MemoryFS();
    const manager = new ResourceManager(vfs);
    const blueprintPath = '/materials/parent.zbpt';
    const parentPath = '/materials/parent.zmtl';
    const instancePath = '/materials/instance.zmtl';
    const parentFile: {
      type: string;
      props: Record<string, unknown>;
      data: { IR: string; uniformValues: unknown[]; uniformTextures: unknown[] };
    } = {
      type: 'PBRBluePrintMaterial',
      props: {
        ClearCoat: false,
        RectSpecularScale: 0.25,
        SubsurfaceProfile: {
          ClassName: 'SubsurfaceProfile',
          Object: { ScatterColor: [0.7, 0.4, 0.2] }
        }
      },
      data: { IR: blueprintPath, uniformValues: [], uniformTextures: [] }
    };
    const instanceFile: {
      type: string;
      props: Record<string, unknown>;
      data: { parent: string; uniformValues: unknown[]; uniformTextures: unknown[] };
    } = {
      type: 'PBRBluePrintMaterialInstance',
      props: {
        RectSpecularScale: 0.75,
        SubsurfaceMeanFreePathColor: [1, 0.45, 0.17]
      },
      data: { parent: parentPath, uniformValues: [], uniformTextures: [] }
    };

    await writeJson(vfs, blueprintPath, blueprint);
    await writeJson(vfs, parentPath, parentFile);
    await writeJson(vfs, instancePath, instanceFile);
    const parent = await manager.fetchMaterial<PBRBluePrintMaterial>(parentPath);
    const instance = await manager.fetchMaterial<PBRBluePrintMaterialInstance>(instancePath);

    expect(instance!.subsurfaceProfile).not.toBe(parent!.subsurfaceProfile);
    parentFile.props = {
      ClearCoat: true,
      RectSpecularScale: 0.5,
      SubsurfaceProfile: {
        ClassName: 'SubsurfaceProfile',
        Object: { ScatterColor: [0.6, 0.3, 0.1] }
      }
    };
    instanceFile.props = {};
    await writeJson(vfs, parentPath, parentFile);
    await writeJson(vfs, instancePath, instanceFile);
    await manager.reloadBluePrintMaterials();

    expect(parent!.clearcoat).toBe(true);
    expect(instance!.clearcoat).toBe(true);
    expect(instance!.rectSpecularScale).toBeCloseTo(0.5);
    expect(instance!.subsurfaceProfile).toBe(parent!.subsurfaceProfile);
    expect(instance!.getMaterialPropertyOverrides()).toEqual([]);
  });

  test('supports instance chains used by the digitalman material baseline', async () => {
    const vfs = new MemoryFS();
    const manager = new ResourceManager(vfs);
    await writeJson(vfs, '/materials/parent.zbpt', blueprint);
    await writeJson(vfs, '/materials/parent.zmtl', {
      type: 'PBRBluePrintMaterial',
      props: {},
      data: {
        IR: '/materials/parent.zbpt',
        uniformValues: [
          {
            name: 'u_value',
            type: 'float',
            value: [0.1],
            inVertexShader: false,
            inFragmentShader: true
          }
        ],
        uniformTextures: []
      }
    });
    await writeJson(vfs, '/materials/first.zmtl', {
      type: 'PBRBluePrintMaterialInstance',
      props: {},
      data: {
        parent: '/materials/parent.zmtl',
        uniformValues: [{ name: 'u_value', type: 'float', value: [0.6] }],
        uniformTextures: []
      }
    });
    await writeJson(vfs, '/materials/second.zmtl', {
      type: 'PBRBluePrintMaterialInstance',
      props: {},
      data: {
        parent: '/materials/first.zmtl',
        uniformValues: [],
        uniformTextures: []
      }
    });

    const second = await manager.fetchMaterial<PBRBluePrintMaterialInstance>('/materials/second.zmtl');

    expect(second).toBeInstanceOf(PBRBluePrintMaterialInstance);
    expect(second!.parentMaterial).toBeInstanceOf(PBRBluePrintMaterialInstance);
    expect(second!.parentMaterialId).toBe('/materials/first.zmtl');
    expect(second!.uniformValues.find((value) => value.name === 'u_value')?.value[0]).toBeCloseTo(0.6);

    await writeJson(vfs, '/materials/first.zmtl', {
      type: 'PBRBluePrintMaterialInstance',
      props: {},
      data: {
        parent: '/materials/parent.zmtl',
        uniformValues: [{ name: 'u_value', type: 'float', value: [0.8] }],
        uniformTextures: []
      }
    });
    await manager.reloadBluePrintMaterials();

    expect(second!.uniformValues.find((value) => value.name === 'u_value')?.value[0]).toBeCloseTo(0.8);
  });
});

const labAssetsRoot = resolve(__dirname, '../../../../lab/digitalman/assets');
const describeWithLabAssets = existsSync(labAssetsRoot) ? describe : describe.skip;

function collectMaterialFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMaterialFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.zmtl')) {
      files.push(path);
    }
  }
  return files;
}

describeWithLabAssets('digitalman blueprint material instance baseline', () => {
  test('covers every instance asset and resolves each parent blueprint material', () => {
    const instances: Array<{ path: string; content: any }> = [];
    for (const path of collectMaterialFiles(labAssetsRoot)) {
      const content = JSON.parse(readFileSync(path, 'utf8'));
      if (content.type === 'PBRBluePrintMaterialInstance') {
        instances.push({ path, content });
      }
    }

    expect(instances).toHaveLength(116);
    for (const { content } of instances) {
      expect(content.data.parent).toMatch(/^\/assets\/.+\.zmtl$/);
      let parentAssetId = content.data.parent as string;
      const visited = new Set<string>();
      while (true) {
        expect(visited.has(parentAssetId)).toBe(false);
        visited.add(parentAssetId);
        const parentPath = resolve(labAssetsRoot, parentAssetId.replace(/^\/assets\//, ''));
        expect(existsSync(parentPath)).toBe(true);
        const parentContent = JSON.parse(readFileSync(parentPath, 'utf8'));
        expect(['PBRBluePrintMaterial', 'PBRBluePrintMaterialInstance']).toContain(parentContent.type);
        if (parentContent.type === 'PBRBluePrintMaterial') {
          break;
        }
        parentAssetId = parentContent.data.parent;
      }
      expect(Array.isArray(content.data.uniformValues)).toBe(true);
      expect(Array.isArray(content.data.uniformTextures)).toBe(true);
      expect(
        Object.keys(content.props ?? {}).every((key) =>
          [
            'Reflection',
            'SubsurfaceMeanFreePathColor',
            'SubsurfaceTransmissionTintColor',
            'ThicknessTexture'
          ].includes(key)
        )
      ).toBe(true);
    }
  });
});
