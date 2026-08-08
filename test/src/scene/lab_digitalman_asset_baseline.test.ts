import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type DataMode = 'embedded' | 'source-reference';

type BaselineCase = {
  name: string;
  prefab: string;
  morphInfoFloatLength: number;
  morphMeshCount: number;
  maxTargetCount: number;
  dataMode: DataMode;
  skinInfluenceCount?: number;
};

type BaselineManifest = {
  assetsRootEnvironmentVariable: string;
  defaultRelativeAssetsRoot: string;
  cases: BaselineCase[];
};

type MorphRecord = {
  floatLength: number;
  targetCount: number;
  hasEmbeddedData: boolean;
  sourcePath: string | null;
  skinInfluenceCount: number | null;
};

const manifestPath = resolve(__dirname, '../fixtures/lab-digitalman-assets.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BaselineManifest;
const repositoryRoot = resolve(__dirname, '../../..');
const assetsRoot = resolve(
  process.env[manifest.assetsRootEnvironmentVariable] ??
    resolve(repositoryRoot, manifest.defaultRelativeAssetsRoot)
);
const describeWithAssets = existsSync(assetsRoot) ? describe : describe.skip;

function collectMorphRecords(value: unknown): MorphRecord[] {
  const records: MorphRecord[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const object = current as Record<string, unknown>;
    if (typeof object.MorphInfo === 'string' && object.MorphInfo) {
      const info = JSON.parse(object.MorphInfo) as { data: string };
      const bytes = Buffer.from(info.data, 'base64');
      const source =
        typeof object.MorphSource === 'string' && object.MorphSource
          ? (JSON.parse(object.MorphSource) as { sourcePath: string })
          : null;
      const skinBytes =
        typeof object.SkinInfluenceData === 'string' && object.SkinInfluenceData
          ? Buffer.from(object.SkinInfluenceData, 'base64')
          : null;
      records.push({
        floatLength: bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
        targetCount: bytes.readFloatLE(3 * Float32Array.BYTES_PER_ELEMENT),
        hasEmbeddedData: typeof object.MorphData === 'string' && object.MorphData.length > 0,
        sourcePath: source?.sourcePath ?? null,
        skinInfluenceCount: skinBytes ? skinBytes.readUInt32LE(8) : null
      });
    }
    pending.push(...Object.values(object));
  }
  return records;
}

describeWithAssets('lab digitalman asset baseline', () => {
  test.each(manifest.cases)('$name matches the locked compatibility profile', (entry) => {
    const prefabPath = resolve(assetsRoot, entry.prefab);
    const prefab = JSON.parse(readFileSync(prefabPath, 'utf8')) as unknown;
    const records = collectMorphRecords(prefab);

    expect(records).toHaveLength(entry.morphMeshCount);
    expect(new Set(records.map((record) => record.floatLength))).toEqual(
      new Set([entry.morphInfoFloatLength])
    );
    expect(Math.max(...records.map((record) => record.targetCount))).toBe(entry.maxTargetCount);
    if (entry.dataMode === 'embedded') {
      expect(records.every((record) => record.hasEmbeddedData && !record.sourcePath)).toBe(true);
    } else {
      expect(records.every((record) => !record.hasEmbeddedData && !!record.sourcePath)).toBe(true);
      for (const sourcePath of new Set(records.map((record) => record.sourcePath!))) {
        const relativeSourcePath = sourcePath.replace(/^\/assets\//, '');
        expect(existsSync(resolve(assetsRoot, relativeSourcePath))).toBe(true);
      }
    }
    if (entry.skinInfluenceCount !== undefined) {
      expect(records.every((record) => record.skinInfluenceCount === entry.skinInfluenceCount)).toBe(true);
    }
  });
});
