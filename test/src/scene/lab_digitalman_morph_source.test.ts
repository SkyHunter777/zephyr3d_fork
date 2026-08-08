import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryFS } from '@zephyr3d/base';
import { getVertexAttribFormat } from '@zephyr3d/device';
import { MAX_ACTIVE_MORPH_TARGETS, Mesh, ResourceManager, Scene, SharedModel } from '../../../libs/scene/src';
import { GLTFImporter } from '../../../libs/loaders/src/gltf/gltf_importer';

jest.mock('@zephyr3d/scene/app/api', () => ({
  getDevice: jest.fn(() => ({
    type: 'webgpu',
    frameInfo: { frameCounter: 0, elapsedFrame: 16.6667, elapsedOverall: 16.6667 },
    createStructuredBuffer: jest.fn(() => ({ bufferSubData: jest.fn(), dispose: jest.fn() })),
    createTexture2D: jest.fn((_format: string, width: number, height: number) => ({
      width,
      height,
      update: jest.fn(),
      dispose: jest.fn()
    })),
    getVertexAttribFormat,
    getDeviceCaps: jest.fn(() => ({
      textureCaps: { maxTextureSize: 4096 },
      miscCaps: { support32BitIndex: true }
    }))
  })),
  getEngine: jest.fn(() => ({ resourceManager: null })),
  tryGetApp: jest.fn(() => null)
}));

const assetsRoot = resolve(
  process.env.ZEPHYR3D_LAB_ASSETS_DIR ?? resolve(__dirname, '../../../../lab/digitalman/assets')
);
const prefabPath = resolve(assetsRoot, 'test/bbb/headRig_whole.zprefab');
const glbPath = resolve(assetsRoot, 'test/bbb/headRig_whole.glb');
const describeWithAssets = existsSync(prefabPath) && existsSync(glbPath) ? describe : describe.skip;

type MeshProps = Record<string, unknown>;

function findLargestMorphMesh(value: unknown): MeshProps {
  let largest: { count: number; props: MeshProps } | null = null;
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
    if (typeof object.MorphInfo === 'string' && object.MorphInfo && typeof object.MorphSource === 'string') {
      const info = JSON.parse(object.MorphInfo) as { data: string };
      const bytes = Buffer.from(info.data, 'base64');
      const count = bytes.readFloatLE(3 * Float32Array.BYTES_PER_ELEMENT);
      if (!largest || count > largest.count) {
        largest = { count, props: object };
      }
    }
    pending.push(...Object.values(object));
  }
  if (!largest) {
    throw new Error('No source-reference morph mesh found in digitalman prefab');
  }
  return largest.props;
}

describeWithAssets('lab digitalman morph source compatibility', () => {
  test('loads the 737-target source reference and compacts active GPU data', async () => {
    const prefab = JSON.parse(readFileSync(prefabPath, 'utf8')) as { data: unknown };
    const sourceProps = findLargestMorphMesh(prefab.data);
    const source = JSON.parse(sourceProps.MorphSource as string) as {
      sourcePath: string;
      nodePath: string;
      subMeshName: string;
    };
    expect(source.sourcePath).toBe('/assets/test/bbb/headRig_whole.glb');

    const manager = new ResourceManager(new MemoryFS());
    manager.setModelLoader('model/gltf-binary', {
      loadModel: async () => {
        const bytes = readFileSync(glbPath);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const model = new SharedModel();
        await new GLTFImporter().loadBinary(
          buffer,
          model as unknown as Parameters<GLTFImporter['loadBinary']>[1],
          '/assets/test/bbb',
          new MemoryFS()
        );
        return model;
      }
    });

    const scene = new Scene();
    const mesh = new Mesh(scene);
    const morphProps: MeshProps = {
      MorphInfo: sourceProps.MorphInfo,
      MorphBoundingInfo: sourceProps.MorphBoundingInfo,
      MorphData: '',
      MorphSourceData: '',
      MorphSource: sourceProps.MorphSource
    };
    await manager.deserializeObjectProps(mesh, morphProps);

    expect(mesh.getMorphInfo()?.data[3]).toBe(737);
    expect(mesh.getMorphSource()?.nodePath).toBe(source.nodePath);
    expect(mesh.getMorphSourceData()?.numTargets).toBe(737);
    expect(mesh.getMorphInfo()?.data[4]).toBe(0);

    mesh.setMorphWeightByIndex(0, 1);
    const renderInfo = mesh.getRenderMorphInfo();
    expect(renderInfo?.data[3]).toBe(1);
    expect(renderInfo?.data[4 + MAX_ACTIVE_MORPH_TARGETS]).toBe(0);
    expect(mesh.getMorphData()).not.toBeNull();
  });
});
