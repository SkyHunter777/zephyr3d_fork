import { DRef, Matrix4x4, Quaternion, Vector3 } from '@zephyr3d/base';
import {
  AnimationSet,
  NodeRotationTrack,
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
});
