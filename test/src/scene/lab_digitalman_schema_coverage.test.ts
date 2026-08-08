import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { applyPatch, MemoryFS } from '@zephyr3d/base';
import { ResourceManager } from '@zephyr3d/scene';
import type { SerializableClass } from '@zephyr3d/scene';

const labAssetsRoot =
  process.env.ZEPHYR3D_LAB_ASSETS_DIR ?? resolve(__dirname, '../../../../lab/digitalman/assets');
const describeWithLabAssets = existsSync(labAssetsRoot) ? describe : describe.skip;

const engineJSONExtensions = new Set(['.zprefab', '.zscn', '.zmtl']);
const expectedAssetCounts: Record<string, number> = {
  '.zprefab': 130,
  '.zscn': 11,
  '.zmtl': 458,
  '.zmsh': 537,
  '.zspring': 13,
  '.zjdyn': 3,
  '.zcloth': 1
};
const expectedPrimitiveFormats: Record<string, string> = {
  position: 'position_f32x3',
  normal: 'normal_f32x3',
  texCoord0: 'tex0_f32x2',
  texCoord1: 'tex1_f32x2',
  texCoord2: 'tex2_f32x2',
  diffuse: 'diffuse_f32x4',
  blendIndices: 'blendindices_f32x4',
  blendWeights: 'blendweights_f32x4'
};
const legacyClasses = new Set(['SpringScriptConfig', 'SpringBoneChain']);

function collectAssetFiles(directory: string, output: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      collectAssetFiles(path, output);
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

function hasSerializableAncestor(
  manager: ResourceManager,
  info: SerializableClass,
  className: string
): boolean {
  let current: SerializableClass | null = info;
  while (current) {
    if (current.name === className) {
      return true;
    }
    current = current.parent ? manager.getClassByConstructor(current.parent) : null;
  }
  return false;
}

function isSupportedLegacyProperty(
  manager: ResourceManager,
  info: SerializableClass,
  propertyName: string
): boolean {
  if (
    hasSerializableAncestor(manager, info, 'SceneNode') &&
    (propertyName === 'BuiltInScript' || propertyName === 'SpringConfig')
  ) {
    return true;
  }
  return (
    hasSerializableAncestor(manager, info, 'PBRMetallicRoughnessMaterial') &&
    propertyName === 'ClearCoatFactor'
  );
}

describeWithLabAssets('digitalman resource schema coverage', () => {
  const files = collectAssetFiles(labAssetsRoot);

  test('locks the compatibility resource inventory', () => {
    const counts: Record<string, number> = {};
    for (const path of files) {
      const extension = extname(path).toLowerCase();
      counts[extension] = (counts[extension] ?? 0) + 1;
    }

    expect(counts).toMatchObject(expectedAssetCounts);
  });

  test('recognizes every serialized class and property in prefab, scene and material assets', () => {
    const manager = new ResourceManager(new MemoryFS());
    const errors = new Set<string>();
    const expandedPrefabs = new Set<string>();

    const scan = (value: unknown, sourcePath: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => scan(item, sourcePath));
        return;
      }
      if (!value || typeof value !== 'object') {
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.ClassName === 'string') {
        const info = manager.getClassByName(record.ClassName);
        if (!info) {
          if (!legacyClasses.has(record.ClassName)) {
            errors.add(`${sourcePath}: unknown class ${record.ClassName}`);
          }
        } else if (record.Object && typeof record.Object === 'object' && !Array.isArray(record.Object)) {
          const knownProps = new Set(manager.getAllPropertiesByClass(info).map((property) => property.name));
          for (const propertyName of Object.keys(record.Object as Record<string, unknown>)) {
            if (!knownProps.has(propertyName) && !isSupportedLegacyProperty(manager, info, propertyName)) {
              errors.add(`${sourcePath}: unknown property ${record.ClassName}::${propertyName}`);
            }
          }
        }
      }
      if (
        record.ClassName === 'SceneNode' &&
        record.Init &&
        typeof record.Init === 'object' &&
        !Array.isArray(record.Init)
      ) {
        const init = record.Init as { prefabId?: unknown; patch?: unknown };
        if (typeof init.prefabId === 'string' && init.prefabId) {
          const prefabPath = resolve(labAssetsRoot, init.prefabId.replace(/^\/assets\//, ''));
          const expansionKey = `${prefabPath}:${JSON.stringify(init.patch ?? [])}`;
          if (!expandedPrefabs.has(expansionKey)) {
            expandedPrefabs.add(expansionKey);
            // Several archived scenes intentionally reference character prefabs supplied by a
            // runtime content package instead of this local asset baseline.
            if (existsSync(prefabPath)) {
              const prefab = JSON.parse(readFileSync(prefabPath, 'utf8'));
              scan(applyPatch(prefab.data, Array.isArray(init.patch) ? init.patch : []), sourcePath);
            }
          }
        }
      }
      Object.values(record).forEach((item) => scan(item, sourcePath));
    };

    for (const path of files.filter((path) => engineJSONExtensions.has(extname(path).toLowerCase()))) {
      const relativePath = path.slice(labAssetsRoot.length + 1);
      const content = JSON.parse(readFileSync(path, 'utf8'));
      scan(content, relativePath);
      if (content.props && typeof content.props === 'object' && !Array.isArray(content.props)) {
        const info = manager.getClassByName(content.type);
        if (!info) {
          errors.add(`${relativePath}: unknown material type ${String(content.type)}`);
        } else {
          const knownProps = new Set(manager.getAllPropertiesByClass(info).map((property) => property.name));
          for (const propertyName of Object.keys(content.props)) {
            if (!knownProps.has(propertyName)) {
              errors.add(`${relativePath}: unknown material property ${content.type}::${propertyName}`);
            }
          }
        }
      }
    }

    expect([...errors]).toEqual([]);
  });

  test('recognizes every mesh asset layout and vertex format', () => {
    for (const path of files.filter((path) => extname(path).toLowerCase() === '.zmsh')) {
      const content = JSON.parse(readFileSync(path, 'utf8'));
      expect(content.type).toBe('Primitive');
      expect(Object.keys(content.data).sort()).toEqual(
        ['boxMax', 'boxMin', 'indexCount', 'indexType', 'indices', 'type', 'vertices'].sort()
      );
      expect(['u16', 'u32']).toContain(content.data.indexType);
      expect(['triangle-list', 'line-list']).toContain(content.data.type);
      expect(content.data.boxMin).toHaveLength(3);
      expect(content.data.boxMax).toHaveLength(3);
      for (const [semantic, vertex] of Object.entries(content.data.vertices) as Array<
        [string, { format: string; data: string }]
      >) {
        expect(vertex.format).toBe(expectedPrimitiveFormats[semantic]);
        expect(typeof vertex.data).toBe('string');
        expect(vertex.data.length).toBeGreaterThan(0);
      }
    }
  });

  test.each([
    ['.zspring', 'SpringConfigPreset'],
    ['.zjdyn', 'JointDynamicsConfigPreset'],
    ['.zcloth', 'ClothConfigPreset']
  ])('keeps %s files scoped as digitalman plugin presets', (extension, expectedType) => {
    const presetFiles = files.filter((path) => extname(path).toLowerCase() === extension);
    expect(presetFiles).toHaveLength(expectedAssetCounts[extension]);
    for (const path of presetFiles) {
      const content = JSON.parse(readFileSync(path, 'utf8'));
      expect(content.type).toBe(expectedType);
      expect(content.version).toBe(1);
    }
  });
});
