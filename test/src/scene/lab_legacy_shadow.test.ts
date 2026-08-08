import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryFS } from '@zephyr3d/base';
import { RectLight, ResourceManager, Scene, SceneNode, SpotLight } from '@zephyr3d/scene';

describe('legacy Poisson-disc shadow compatibility', () => {
  test.each([
    ['SpotLight', SpotLight],
    ['RectLight', RectLight]
  ] as const)('restores %s sample tuning and implementation', async (className, LightClass) => {
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    const light = await manager.deserializeObject<SpotLight | RectLight>(container, {
      ClassName: className,
      Object: {
        CastShadow: true,
        ShadowType: 'pcf-pd',
        PCFSampleCount: 17,
        PCFSampleRadius: 6
      }
    });

    expect(light).toBeInstanceOf(LightClass);
    expect(light!.shadow.mode).toBe('pcf-pd');
    expect(light!.shadow.pdSampleCount).toBe(17);
    expect(light!.shadow.pdSampleRadius).toBe(6);
    expect((light!.shadow as any)._impl.getType()).toBe('pcf-pd');

    const serialized = await manager.serializeObject(light!);
    expect(serialized.Object).toMatchObject({
      CastShadow: true,
      ShadowType: 'pcf-pd',
      PCFSampleCount: 17,
      PCFSampleRadius: 6
    });
  });

  test('keeps the current PCF mode on the optimized implementation', () => {
    const light = new SpotLight(new Scene());
    light.shadow.mode = 'pcf';

    expect((light.shadow as any)._impl.getType()).toBe('pcf-opt');
  });
});

const labAssetsRoot =
  process.env.ZEPHYR3D_LAB_ASSETS_DIR ?? resolve(__dirname, '../../../../lab/digitalman/assets');
const legacyScenePaths = [
  resolve(labAssetsRoot, 'Levels/BaseLight.zscn'),
  resolve(labAssetsRoot, 'Levels/BaseLight2.zscn')
];
const describeWithLabAssets = legacyScenePaths.every((path) => existsSync(path)) ? describe : describe.skip;

function collectLegacyShadowLights(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectLegacyShadowLights(item, output));
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const object = record.Object as Record<string, unknown> | undefined;
    if (
      (record.ClassName === 'SpotLight' || record.ClassName === 'RectLight') &&
      object?.ShadowType === 'pcf-pd'
    ) {
      output.push(record);
    }
    Object.values(record).forEach((item) => collectLegacyShadowLights(item, output));
  }
}

describeWithLabAssets('digitalman Poisson-disc shadow baseline', () => {
  test.each(legacyScenePaths)('restores all tuned lights from %s', async (path) => {
    const records: Record<string, unknown>[] = [];
    collectLegacyShadowLights(JSON.parse(readFileSync(path, 'utf8')), records);

    expect(records).toHaveLength(3);
    const manager = new ResourceManager(new MemoryFS());
    const scene = new Scene();
    const container = new SceneNode(scene);
    container.remove();
    for (const record of records) {
      expect(record.Object).toMatchObject({
        CastShadow: true,
        ShadowType: 'pcf-pd',
        PCFSampleCount: 24,
        PCFSampleRadius: 3
      });
      const light = await manager.deserializeObject<SpotLight | RectLight>(container, record);
      expect(light!.shadow.pdSampleCount).toBe(24);
      expect(light!.shadow.pdSampleRadius).toBe(3);
      expect((light!.shadow as any)._impl.getType()).toBe('pcf-pd');
    }
  });
});
