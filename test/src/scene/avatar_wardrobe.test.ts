import { DRef, Matrix4x4, Quaternion, Vector3 } from '@zephyr3d/base';
import { AvatarWardrobe, Mesh, Scene, SceneNode, SkeletonRig, SkinBinding } from '../../../libs/scene/src';

jest.mock('@zephyr3d/scene/app/api', () => ({
  getDevice: jest.fn(() => ({
    type: 'webgpu',
    frameInfo: {
      frameCounter: 0,
      elapsedFrame: 16.6667
    },
    createTexture2D: (_format: string, width: number, height: number) => ({
      width,
      height,
      update: () => undefined,
      dispose: () => undefined
    })
  })),
  tryGetApp: jest.fn(() => null)
}));

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

function createNamedRig(parent: SceneNode, names: string[]) {
  const joints: SceneNode[] = [];
  let currentParent = parent;
  for (const name of names) {
    const joint = appendNode(currentParent, name);
    joints.push(joint);
    currentParent = joint;
  }
  return new SkeletonRig(joints, bindPose(joints), { rootJoint: joints[0] });
}

function createSkinnedOutfit(parent: SceneNode, jointNames: string[]) {
  const rig = createNamedRig(parent, jointNames);
  const binding = new SkinBinding(rig, inverseBind(rig.joints), rig.joints);
  parent.animationSet.rigs.push(new DRef(rig));
  parent.animationSet.skeletons.push(new DRef(binding));
  const mesh = new Mesh(parent.scene!);
  mesh.name = 'OutfitMesh';
  mesh.parent = parent;
  mesh.skinBindingName = binding.persistentId;
  return { rig, binding, mesh };
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

describe('AvatarWardrobe', () => {
  test('equips a skinned outfit on the avatar rig', async () => {
    const scene = new Scene();
    const avatarRoot = appendNode(scene.rootNode, 'Avatar');
    const outfitRoot = appendNode(scene.rootNode, 'Outfit');
    const avatarRig = createNamedRig(avatarRoot, ['Root', 'Spine']);
    avatarRoot.animationSet.rigs.push(new DRef(avatarRig));
    const outfit = createSkinnedOutfit(outfitRoot, ['Root', 'Spine']);

    const wardrobe = AvatarWardrobe.from(avatarRoot);
    const instance = await wardrobe.equip(outfitRoot, {
      slot: 'top',
      bindMode: 'name',
      fitMode: 'reuseInverseBind'
    });

    expect(instance.root.get().parent).toBe(avatarRoot);
    expect(instance.skinBindings).toHaveLength(1);
    expect(instance.skinBindings[0].rig).toBe(avatarRig);
    expect(instance.skinBindings[0].joints).toEqual(avatarRig.joints);
    expect(outfit.mesh.skinBindingName).toBe(instance.skinBindings[0].persistentId);
    expect(avatarRoot.animationSet.skeletons.some((ref) => ref.get() === instance.skinBindings[0])).toBe(
      true
    );
    expect(outfitRoot.animationSet.skeletons).toHaveLength(0);
    expect(outfitRoot.animationSet.rigs).toHaveLength(0);
  });

  test('hides body regions for a slot and restores them on unequip', async () => {
    const scene = new Scene();
    const avatarRoot = appendNode(scene.rootNode, 'Avatar');
    const outfitRoot = appendNode(scene.rootNode, 'Outfit');
    const avatarRig = createNamedRig(avatarRoot, ['Root', 'Spine']);
    avatarRoot.animationSet.rigs.push(new DRef(avatarRig));
    const outfit = createSkinnedOutfit(outfitRoot, ['Root', 'Spine']);
    const torso = new Mesh(scene);
    torso.name = 'Body_Torso';
    torso.parent = avatarRoot;
    torso.showState = 'inherit';
    const wardrobe = AvatarWardrobe.from(avatarRoot, {
      slots: [{ id: 'top', hideBodyRegions: ['torso'] }],
      bodyRegions: { torso: [torso] }
    });

    const instance = await wardrobe.equip(outfitRoot, {
      slot: 'top',
      bindMode: 'name',
      fitMode: 'reuseInverseBind'
    });

    expect(torso.showState).toBe('hidden');
    expect(wardrobe.getEquipped('top')).toEqual([instance]);

    wardrobe.unequip('top');

    expect(torso.showState).toBe('inherit');
    expect(outfit.mesh.skinBindingName).toBe('');
    expect(outfitRoot.parent).toBeNull();
    expect(wardrobe.getEquipped('top')).toHaveLength(0);
  });

  test('maps prefixed humanoid outfit joints to the avatar humanoid rig', async () => {
    const scene = new Scene();
    const avatarRoot = appendNode(scene.rootNode, 'Avatar');
    const outfitRoot = appendNode(scene.rootNode, 'Outfit');
    const avatarJoints = buildHumanoid(avatarRoot, 'Dst');
    const sourceJoints = buildHumanoid(outfitRoot, 'Src');
    avatarJoints[0].position.setXYZ(0, 0, 0);
    sourceJoints[0].position.setXYZ(0, 0, 0);
    avatarJoints[1].rotation.set(Quaternion.identity());
    sourceJoints[1].rotation.set(Quaternion.identity());
    avatarJoints[14].position.set(Vector3.axisNY());
    sourceJoints[14].position.set(Vector3.axisNY());
    const avatarRig = new SkeletonRig(avatarJoints, bindPose(avatarJoints));
    const sourceRig = new SkeletonRig(sourceJoints, bindPose(sourceJoints));
    avatarRoot.animationSet.rigs.push(new DRef(avatarRig));
    const sourceBinding = new SkinBinding(sourceRig, inverseBind(sourceJoints), sourceJoints);
    outfitRoot.animationSet.rigs.push(new DRef(sourceRig));
    outfitRoot.animationSet.skeletons.push(new DRef(sourceBinding));
    const mesh = new Mesh(scene);
    mesh.name = 'HumanoidOutfit';
    mesh.parent = outfitRoot;
    mesh.skinBindingName = sourceBinding.persistentId;

    const wardrobe = AvatarWardrobe.from(avatarRoot);
    const instance = await wardrobe.equip(outfitRoot, {
      slot: 'top',
      bindMode: 'humanoid'
    });

    expect(instance.skinBindings[0].joints[0]).toBe(avatarJoints[0]);
    expect(instance.skinBindings[0].joints[1]).toBe(avatarJoints[1]);
    expect(mesh.skinBindingName).toBe(instance.skinBindings[0].persistentId);
  });
});
