import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Matrix4x4, NullVFS } from '@zephyr3d/base';
import { Scene, SharedModel, Skeleton } from '@zephyr3d/scene';
import { FBXImporter } from '../../../libs/loaders/src/fbx/fbx_importer';

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

function getFlairPath() {
  const candidates = [
    resolve(process.cwd(), 'Flair.fbx'),
    resolve(process.cwd(), '..', 'Flair.fbx'),
    resolve(__dirname, '../../../Flair.fbx')
  ];
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (!filePath) {
    throw new Error('Unable to locate Flair.fbx');
  }
  return filePath;
}

async function loadFlairModel() {
  const importer = new FBXImporter();
  const model = new SharedModel();
  const filePath = getFlairPath();
  const buffer = readFileSync(filePath);
  await importer.import(new Blob([buffer]), model, dirname(filePath), new NullVFS());
  return model;
}

describe('FBXImporter skeleton-only FBX support', () => {
  test('imports skeletons from Flair.fbx even when there is no mesh or animation', async () => {
    const model = await loadFlairModel();

    expect(model.skeletons.length).toBeGreaterThan(0);
    expect(model.skeletons[0].joints.length).toBeGreaterThan(0);
    expect(model.skeletons[0].root?.name).toBe('mixamorig:Hips');
  });

  test('creates runtime Skeleton instances in animationSet when saveSkeletons is enabled', async () => {
    const model = await loadFlairModel();
    const originalUpdateJointMatrices = (Skeleton.prototype as any).updateJointMatrices;
    (Skeleton.prototype as any).updateJointMatrices = () => undefined;

    try {
      const group = await model.createSceneNode(
        null as any,
        new Scene(),
        false,
        false,
        true,
        false,
        new NullVFS()
      );

      expect(group.animationSet.skeletons.length).toBeGreaterThan(0);
      const skeleton = group.animationSet.skeletons[0].get();
      expect(skeleton).toBeTruthy();
      expect(skeleton!.joints.length).toBe(model.skeletons[0].joints.length);
    } finally {
      (Skeleton.prototype as any).updateJointMatrices = originalUpdateJointMatrices;
    }
  });

  test('imports valid inverse bind matrices for Flair.fbx joints', async () => {
    const model = await loadFlairModel();
    const skeleton = model.skeletons[0];
    const jointNames = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:LeftArm', 'mixamorig:RightArm'];

    for (const jointName of jointNames) {
      const index = skeleton.joints.findIndex((joint) => joint.name === jointName);
      expect(index).toBeGreaterThanOrEqual(0);
      const joint = skeleton.joints[index];
      const combined = Matrix4x4.multiply(joint.worldMatrix!, skeleton.inverseBindMatrices[index]);
      const identity = Matrix4x4.identity();
      for (let i = 0; i < 16; i++) {
        expect(Math.abs(combined[i] - identity[i])).toBeLessThan(1e-3);
      }
    }
  });
});
