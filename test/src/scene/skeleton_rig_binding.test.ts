import { DRef, Matrix4x4, Quaternion, Vector3 } from '@zephyr3d/base';
import type { AnimationSet } from '@zephyr3d/scene';
import {
  NodeRotationTrack,
  NodeTranslationTrack,
  Scene,
  SceneNode,
  SkeletonModifier,
  SkeletonRig,
  SkinBinding
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

class CountingModifier extends SkeletonModifier {
  count = 0;
  apply(_skeleton: SkeletonRig, _deltaTime: number): void {
    this.count++;
  }
  reset(): void {}
  protected _getWeight(): number {
    return 1;
  }
  protected _setWeight(_value: number): void {}
}

function appendNode(parent: SceneNode, name: string) {
  const node = new SceneNode(parent.scene);
  node.name = name;
  node.parent = parent;
  return node;
}

function bindPose(nodes: SceneNode[]) {
  return nodes.map((node) => ({
    position: node.position.clone(),
    rotation: node.rotation.clone(),
    scale: node.scale.clone()
  }));
}

function inverseBind(nodes: SceneNode[]) {
  return nodes.map(() => Matrix4x4.identity());
}

function buildHumanoid(parent: SceneNode, prefix: string) {
  const hips = appendNode(parent, `${prefix}Hips`);
  const spine = appendNode(hips, `${prefix}Spine`);
  const chest = appendNode(spine, `${prefix}Chest`);
  const upperChest = appendNode(chest, `${prefix}UpperChest`);
  const neck = appendNode(upperChest, `${prefix}Neck`);
  const head = appendNode(neck, `${prefix}Head`);
  const leftShoulder = appendNode(upperChest, `${prefix}LeftShoulder`);
  const leftUpperArm = appendNode(leftShoulder, `${prefix}LeftUpperArm`);
  const leftLowerArm = appendNode(leftUpperArm, `${prefix}LeftLowerArm`);
  const leftHand = appendNode(leftLowerArm, `${prefix}LeftHand`);
  const rightShoulder = appendNode(upperChest, `${prefix}RightShoulder`);
  const rightUpperArm = appendNode(rightShoulder, `${prefix}RightUpperArm`);
  const rightLowerArm = appendNode(rightUpperArm, `${prefix}RightLowerArm`);
  const rightHand = appendNode(rightLowerArm, `${prefix}RightHand`);
  const leftUpperLeg = appendNode(hips, `${prefix}LeftUpperLeg`);
  const leftLowerLeg = appendNode(leftUpperLeg, `${prefix}LeftLowerLeg`);
  const leftFoot = appendNode(leftLowerLeg, `${prefix}LeftFoot`);
  const leftToes = appendNode(leftFoot, `${prefix}LeftToes`);
  const rightUpperLeg = appendNode(hips, `${prefix}RightUpperLeg`);
  const rightLowerLeg = appendNode(rightUpperLeg, `${prefix}RightLowerLeg`);
  const rightFoot = appendNode(rightLowerLeg, `${prefix}RightFoot`);
  const rightToes = appendNode(rightFoot, `${prefix}RightToes`);
  return [
    hips,
    spine,
    chest,
    upperChest,
    neck,
    head,
    leftShoulder,
    leftUpperArm,
    leftLowerArm,
    leftHand,
    rightShoulder,
    rightUpperArm,
    rightLowerArm,
    rightHand,
    leftUpperLeg,
    leftLowerLeg,
    leftFoot,
    leftToes,
    rightUpperLeg,
    rightLowerLeg,
    rightFoot,
    rightToes
  ];
}

function scaleHumanoidLegs(joints: SceneNode[], scale: number) {
  for (const joint of [
    joints[14],
    joints[15],
    joints[16],
    joints[17],
    joints[18],
    joints[19],
    joints[20],
    joints[21]
  ]) {
    joint.position.scaleBy(scale);
  }
}

describe('SkeletonRig and SkinBinding', () => {
  test('updates shared rig modifiers once while preserving multiple skin bindings', () => {
    const scene = new Scene();
    const model = appendNode(scene.rootNode, 'model');
    const root = appendNode(model, 'root');
    const joint = appendNode(root, 'joint');
    joint.position.setXYZ(0, 1, 0);

    const joints = [root, joint];
    const rig = new SkeletonRig(joints, bindPose(joints));
    const bindingA = new SkinBinding(rig, inverseBind(joints));
    const bindingB = new SkinBinding(rig, inverseBind(joints));
    const modifier = new CountingModifier();
    rig.modifiers.push(modifier);
    model.animationSet.rigs.push(new DRef(rig));
    model.animationSet.skeletons.push(new DRef(bindingA), new DRef(bindingB));

    model.animationSet.update(1 / 60);

    expect(modifier.count).toBe(1);
    expect(model.animationSet.rigs).toHaveLength(1);
    expect(model.animationSet.skinBindings).toHaveLength(2);
    expect(bindingA.rig).toBe(rig);
    expect(bindingB.rig).toBe(rig);
    expect(bindingA.jointTexture).toBeTruthy();
    expect(bindingB.jointTexture).toBeTruthy();
  });

  test('retarget accepts legacy clips referencing multiple bindings for one rig', () => {
    const scene = new Scene();
    const srcModel = appendNode(scene.rootNode, 'srcModel');
    const dstModel = appendNode(scene.rootNode, 'dstModel');
    const srcRoot = appendNode(srcModel, 'SrcRoot');
    const dstRoot = appendNode(dstModel, 'DstRoot');
    const srcJoints = buildHumanoid(srcRoot, 'Src');
    const dstJoints = buildHumanoid(dstRoot, 'Dst');
    const srcHips = srcJoints[0];
    const srcRig = new SkeletonRig(srcJoints, bindPose(srcJoints));
    const dstRig = new SkeletonRig(dstJoints, bindPose(dstJoints));
    const srcBindingA = new SkinBinding(srcRig, inverseBind(srcJoints));
    const srcBindingB = new SkinBinding(srcRig, inverseBind(srcJoints));
    srcModel.animationSet.rigs.push(new DRef(srcRig));
    srcModel.animationSet.skeletons.push(new DRef(srcBindingA), new DRef(srcBindingB));
    dstModel.animationSet.rigs.push(new DRef(dstRig));

    const srcClip = srcModel.animationSet.createAnimation('idle')!;
    srcClip.addSkeleton(srcBindingA.persistentId);
    srcClip.addSkeleton(srcBindingB.persistentId);
    srcClip.addTrack(
      srcHips,
      new NodeRotationTrack('linear', [
        { time: 0, value: Quaternion.identity() },
        { time: 1, value: Quaternion.fromAxisAngle(Vector3.axisPY(), Math.PI / 4) }
      ])
    );

    const copied = dstModel.animationSet.copyHumanoidAnimationFrom(
      srcModel.animationSet as AnimationSet,
      'idle',
      'idle_copy'
    );

    expect(copied).toBeTruthy();
    expect(copied!.skeletons.has(dstRig.persistentId)).toBe(true);
  });

  test('retarget scales humanoid hips translation by leg length', () => {
    const scene = new Scene();
    const srcModel = appendNode(scene.rootNode, 'srcModel');
    const dstModel = appendNode(scene.rootNode, 'dstModel');
    const srcRoot = appendNode(srcModel, 'SrcRoot');
    const dstRoot = appendNode(dstModel, 'DstRoot');
    const srcJoints = buildHumanoid(srcRoot, 'Src');
    const dstJoints = buildHumanoid(dstRoot, 'Dst');
    const srcHips = srcJoints[0];
    const dstHips = dstJoints[0];
    srcHips.position.setXYZ(0, 0, 0);
    dstHips.position.setXYZ(0, 0, 0);
    srcJoints[14].position.setXYZ(0.2, -0.5, 0);
    srcJoints[15].position.setXYZ(0, -0.5, 0);
    srcJoints[16].position.setXYZ(0, -0.1, 0.2);
    srcJoints[17].position.setXYZ(0, 0, 0.2);
    srcJoints[18].position.setXYZ(-0.2, -0.5, 0);
    srcJoints[19].position.setXYZ(0, -0.5, 0);
    srcJoints[20].position.setXYZ(0, -0.1, 0.2);
    srcJoints[21].position.setXYZ(0, 0, 0.2);
    for (let i = 14; i <= 21; i++) {
      dstJoints[i].position.set(srcJoints[i].position);
    }
    scaleHumanoidLegs(dstJoints, 2);
    const srcRig = new SkeletonRig(srcJoints, bindPose(srcJoints));
    const dstRig = new SkeletonRig(dstJoints, bindPose(dstJoints));
    srcModel.animationSet.rigs.push(new DRef(srcRig));
    dstModel.animationSet.rigs.push(new DRef(dstRig));

    const srcClip = srcModel.animationSet.createAnimation('jump')!;
    srcClip.addSkeleton(srcRig.persistentId);
    srcClip.addTrack(
      srcHips,
      new NodeTranslationTrack('linear', [
        { time: 0, value: new Vector3(0, 0, 0) },
        { time: 1, value: new Vector3(0, 0.25, 0) }
      ])
    );

    const copied = dstModel.animationSet.copyHumanoidAnimationFrom(
      srcModel.animationSet as AnimationSet,
      'jump',
      'jump_copy'
    );

    expect(copied).toBeTruthy();
    const dstTrack = copied!.tracks.get(dstHips)!.find((track) => track instanceof NodeTranslationTrack);
    expect(dstTrack).toBeInstanceOf(NodeTranslationTrack);
    const outputs = (dstTrack as NodeTranslationTrack).interpolator.outputs as Float32Array;
    expect(outputs[1]).toBeCloseTo(0);
    expect(outputs[4]).toBeCloseTo(0.5);
  });

  test('retarget handles explicit humanoid root motion modes', () => {
    const scene = new Scene();
    const srcModel = appendNode(scene.rootNode, 'srcModel');
    const dstModel = appendNode(scene.rootNode, 'dstModel');
    const srcRoot = appendNode(srcModel, 'SrcRoot');
    const dstRoot = appendNode(dstModel, 'DstRoot');
    const srcJoints = buildHumanoid(srcRoot, 'Src');
    const dstJoints = buildHumanoid(dstRoot, 'Dst');
    srcRoot.position.setXYZ(0, 0.1, 0);
    dstRoot.position.setXYZ(0, 1, 0);
    srcJoints[14].position.setXYZ(0.2, -0.5, 0);
    srcJoints[15].position.setXYZ(0, -0.5, 0);
    srcJoints[16].position.setXYZ(0, -0.1, 0.2);
    srcJoints[17].position.setXYZ(0, 0, 0.2);
    srcJoints[18].position.setXYZ(-0.2, -0.5, 0);
    srcJoints[19].position.setXYZ(0, -0.5, 0);
    srcJoints[20].position.setXYZ(0, -0.1, 0.2);
    srcJoints[21].position.setXYZ(0, 0, 0.2);
    for (let i = 14; i <= 21; i++) {
      dstJoints[i].position.set(srcJoints[i].position);
    }
    scaleHumanoidLegs(dstJoints, 2);

    const srcRig = new SkeletonRig(srcJoints, bindPose(srcJoints), { rootJoint: srcRoot });
    const dstRig = new SkeletonRig(dstJoints, bindPose(dstJoints), { rootJoint: dstRoot });
    srcModel.animationSet.rigs.push(new DRef(srcRig));
    dstModel.animationSet.rigs.push(new DRef(dstRig));

    const srcClip = srcModel.animationSet.createAnimation('walk')!;
    srcClip.addSkeleton(srcRig.persistentId);
    srcClip.addTrack(
      srcRoot,
      new NodeTranslationTrack('linear', [
        { time: 0, value: new Vector3(0, 0.1, 0) },
        { time: 1, value: new Vector3(0, 0.35, 0) }
      ])
    );

    const scaled = dstModel.animationSet.copyHumanoidAnimationFrom(
      srcModel.animationSet as AnimationSet,
      'walk',
      'walk_scaled',
      { rootMotion: 'scaled' }
    );
    expect(scaled).toBeTruthy();
    const scaledTrack = scaled!.tracks.get(dstRoot)!.find((track) => track instanceof NodeTranslationTrack);
    expect(scaledTrack).toBeInstanceOf(NodeTranslationTrack);
    expect(scaledTrack!.target).toBe(dstRoot.persistentId);
    expect(scaledTrack!.jointIndex).toBe(-1);
    const scaledOutputs = (scaledTrack as NodeTranslationTrack).interpolator.outputs as Float32Array;
    expect(scaledOutputs[1]).toBeCloseTo(1);
    expect(scaledOutputs[4]).toBeCloseTo(1.5);

    const locked = dstModel.animationSet.copyHumanoidAnimationFrom(
      srcModel.animationSet as AnimationSet,
      'walk',
      'walk_locked',
      { rootMotion: 'locked' }
    );
    expect(locked).toBeTruthy();
    const lockedTrack = locked!.tracks.get(dstRoot)!.find((track) => track instanceof NodeTranslationTrack);
    expect(lockedTrack).toBeInstanceOf(NodeTranslationTrack);
    const lockedOutputs = (lockedTrack as NodeTranslationTrack).interpolator.outputs as Float32Array;
    expect(lockedOutputs[0]).toBeCloseTo(0);
    expect(lockedOutputs[1]).toBeCloseTo(1);
    expect(lockedOutputs[2]).toBeCloseTo(0);
  });

  test('retarget skips non-root humanoid translations unless explicitly preserved', () => {
    const scene = new Scene();
    const srcModel = appendNode(scene.rootNode, 'srcModel');
    const dstModel = appendNode(scene.rootNode, 'dstModel');
    const srcRoot = appendNode(srcModel, 'SrcRoot');
    const dstRoot = appendNode(dstModel, 'DstRoot');
    const srcJoints = buildHumanoid(srcRoot, 'Src');
    const dstJoints = buildHumanoid(dstRoot, 'Dst');
    const srcLowerLeg = srcJoints[15];
    const dstLowerLeg = dstJoints[15];
    const srcRig = new SkeletonRig(srcJoints, bindPose(srcJoints), { rootJoint: srcRoot });
    const dstRig = new SkeletonRig(dstJoints, bindPose(dstJoints), { rootJoint: dstRoot });
    srcModel.animationSet.rigs.push(new DRef(srcRig));
    dstModel.animationSet.rigs.push(new DRef(dstRig));

    const srcClip = srcModel.animationSet.createAnimation('bend')!;
    srcClip.addSkeleton(srcRig.persistentId);
    srcClip.addTrack(
      srcRoot,
      new NodeTranslationTrack('linear', [
        { time: 0, value: Vector3.zero() },
        { time: 1, value: new Vector3(0, 0.1, 0) }
      ])
    );
    srcClip.addTrack(
      srcLowerLeg,
      new NodeTranslationTrack('linear', [
        { time: 0, value: srcLowerLeg.position.clone() },
        { time: 1, value: srcLowerLeg.position.clone().addBy(new Vector3(0, 0.2, 0)) }
      ])
    );

    const skipped = dstModel.animationSet.copyHumanoidAnimationFrom(
      srcModel.animationSet as AnimationSet,
      'bend',
      'bend_skipped'
    );
    expect(skipped).toBeTruthy();
    expect(skipped!.tracks.get(dstLowerLeg)).toBeUndefined();

    const preserved = dstModel.animationSet.copyHumanoidAnimationFrom(
      srcModel.animationSet as AnimationSet,
      'bend',
      'bend_preserved',
      { jointTranslations: 'preserve' }
    );
    expect(preserved).toBeTruthy();
    const preservedTrack = preserved!.tracks
      .get(dstLowerLeg)!
      .find((track) => track instanceof NodeTranslationTrack);
    expect(preservedTrack).toBeInstanceOf(NodeTranslationTrack);
  });
});
