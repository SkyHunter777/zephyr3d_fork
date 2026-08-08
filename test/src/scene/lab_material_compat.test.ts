import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryFS } from '@zephyr3d/base';
import { PBRMetallicRoughnessMaterial, ResourceManager } from '@zephyr3d/scene';

describe('lab material compatibility', () => {
  test('migrates legacy ClearCoatFactor without changing the serialized schema', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const material = await manager.deserializeObject<PBRMetallicRoughnessMaterial>(null, {
      ClassName: 'PBRMetallicRoughnessMaterial',
      Object: {
        ClearCoatFactor: 0.8,
        ClearCoatRoughnessFactor: 0.05
      }
    });

    expect(material).toBeInstanceOf(PBRMetallicRoughnessMaterial);
    expect(material!.clearcoat).toBe(true);
    expect(material!.clearcoatIntensity).toBeCloseTo(0.8);
    expect(material!.clearcoatRoughnessFactor).toBeCloseTo(0.05);

    const serialized = await manager.serializeObject(material!);
    expect(serialized.Object.ClearCoat).toBe(true);
    expect(serialized.Object.ClearCoatIntensity).toBeCloseTo(0.8);
    expect(serialized.Object.ClearCoatRoughnessFactor).toBeCloseTo(0.05);
    expect(serialized.Object).not.toHaveProperty('ClearCoatFactor');
  });

  test('keeps current clear-coat fields authoritative when both schemas are present', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const material = await manager.deserializeObject<PBRMetallicRoughnessMaterial>(null, {
      ClassName: 'PBRMetallicRoughnessMaterial',
      Object: {
        ClearCoatFactor: 0.8,
        ClearCoat: true,
        ClearCoatIntensity: 0.25
      }
    });

    expect(material!.clearcoat).toBe(true);
    expect(material!.clearcoatIntensity).toBeCloseTo(0.25);
  });

  test('does not re-enable a layer explicitly disabled by the current schema', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const material = await manager.deserializeObject<PBRMetallicRoughnessMaterial>(null, {
      ClassName: 'PBRMetallicRoughnessMaterial',
      Object: {
        ClearCoatFactor: 0.8,
        ClearCoat: false
      }
    });

    expect(material!.clearcoat).toBe(false);
  });

  test('maps a zero legacy factor to a disabled clear-coat layer', async () => {
    const manager = new ResourceManager(new MemoryFS());
    const material = await manager.deserializeObject<PBRMetallicRoughnessMaterial>(null, {
      ClassName: 'PBRMetallicRoughnessMaterial',
      Object: { ClearCoatFactor: 0 }
    });

    expect(material!.clearcoat).toBe(false);
    expect(material!.clearcoatIntensity).toBe(0);
  });
});

const labAssetsRoot =
  process.env.ZEPHYR3D_LAB_ASSETS_DIR ?? resolve(__dirname, '../../../../lab/digitalman/assets');
const speakerMaterialPath = resolve(labAssetsRoot, 'model/scene/stage_5/SPEAKER.zmtl');
const describeWithLabAssets = existsSync(speakerMaterialPath) ? describe : describe.skip;

describeWithLabAssets('digitalman legacy clear-coat material baseline', () => {
  test('locks the real SPEAKER material legacy field layout', () => {
    const content = JSON.parse(readFileSync(speakerMaterialPath, 'utf8'));

    expect(content.type).toBe('Default');
    expect(content.data.ClassName).toBe('PBRMetallicRoughnessMaterial');
    expect(content.data.Object).toMatchObject({
      ClearCoatFactor: 0.8,
      ClearCoatRoughnessFactor: 0.05
    });
    expect(content.data.Object).not.toHaveProperty('ClearCoat');
    expect(content.data.Object).not.toHaveProperty('ClearCoatIntensity');
  });
});
