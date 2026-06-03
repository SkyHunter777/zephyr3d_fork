import { Quaternion, Vector3, Vector4 } from '@zephyr3d/base';
import {
  BoxShape,
  IKChain,
  LambertMaterial,
  Mesh,
  SceneNode,
  SphereShape,
  TwoBoneIKSolver
} from '@zephyr3d/scene';

const DEFAULT_TARGET = new Vector3(1.1, 1.35, 0.28);
const DEFAULT_POLE = new Vector3(0.75, 1.0, 0.75);
const ROOT_POSITION = new Vector3(0, 1.0, 0);
const SHOULDER_POSITION = new Vector3(0.38, 0.52, 0);
const UPPER_ARM_LENGTH = 0.48;
const FOREARM_LENGTH = 0.46;

function makeMaterial(color) {
  const material = new LambertMaterial();
  material.albedoColor = color;
  return material;
}

function addSphere(scene, parent, radius, color) {
  const mesh = new Mesh(scene, new SphereShape({ radius }), makeMaterial(color));
  mesh.parent = parent;
  return mesh;
}

function addBox(scene, parent, options, color) {
  const mesh = new Mesh(scene, new BoxShape(options), makeMaterial(color));
  mesh.parent = parent;
  return mesh;
}

function resetRotation(node) {
  node.rotation = Quaternion.identity();
}

function createArmRig(scene, root) {
  const shoulder = new SceneNode(scene);
  shoulder.name = 'IK_RightShoulder';
  shoulder.parent = root;
  shoulder.position.set(SHOULDER_POSITION);
  addSphere(scene, shoulder, 0.06, new Vector4(0.95, 0.78, 0.42, 1));

  const elbow = new SceneNode(scene);
  elbow.name = 'IK_RightElbow';
  elbow.parent = shoulder;
  elbow.position.setXYZ(UPPER_ARM_LENGTH, 0, 0);
  addSphere(scene, elbow, 0.055, new Vector4(0.95, 0.78, 0.42, 1));

  const wrist = new SceneNode(scene);
  wrist.name = 'IK_RightWrist';
  wrist.parent = elbow;
  wrist.position.setXYZ(FOREARM_LENGTH, 0, 0);
  addSphere(scene, wrist, 0.05, new Vector4(0.95, 0.78, 0.42, 1));

  addBox(
    scene,
    shoulder,
    {
      sizeX: UPPER_ARM_LENGTH,
      sizeY: 0.065,
      sizeZ: 0.065,
      anchorX: 0,
      anchorY: 0.5,
      anchorZ: 0.5
    },
    new Vector4(0.74, 0.56, 0.28, 1)
  );
  addBox(
    scene,
    elbow,
    {
      sizeX: FOREARM_LENGTH,
      sizeY: 0.055,
      sizeZ: 0.055,
      anchorX: 0,
      anchorY: 0.5,
      anchorZ: 0.5
    },
    new Vector4(0.72, 0.62, 0.36, 1)
  );

  return { shoulder, elbow, wrist };
}

export function createIKDemo(scene) {
  const root = new SceneNode(scene);
  root.name = 'IK_DemoRoot';
  root.position.set(ROOT_POSITION);

  const { shoulder, elbow, wrist } = createArmRig(scene, root);
  const chain = IKChain.fromNodeHierarchy(shoulder, wrist);
  const solver = new TwoBoneIKSolver(chain, DEFAULT_POLE, 10);
  solver.poleVector = DEFAULT_POLE;
  solver.setTwistConstraint(0, -Math.PI * 0.01, Math.PI * 0.01, 0.8);
  solver.setTwistConstraint(1, -Math.PI * 0.01, Math.PI * 0.01, 0.8);

  const targetNode = new SceneNode(scene);
  targetNode.name = 'IK_Target';
  targetNode.position.set(DEFAULT_TARGET);
  addSphere(scene, targetNode, 0.075, new Vector4(0.2, 0.72, 0.95, 1));

  const poleNode = new SceneNode(scene);
  poleNode.name = 'IK_Pole';
  poleNode.position.set(DEFAULT_POLE);
  addSphere(scene, poleNode, 0.055, new Vector4(0.96, 0.38, 0.58, 1));

  let weight = 1;
  const targetWorld = new Vector3();
  const poleWorld = new Vector3();

  const reset = () => {
    root.position.set(ROOT_POSITION);
    targetNode.position.set(DEFAULT_TARGET);
    poleNode.position.set(DEFAULT_POLE);
    resetRotation(shoulder);
    resetRotation(elbow);
    resetRotation(wrist);
  };

  const update = (time) => {
    root.position.y = ROOT_POSITION.y + Math.sin(time * 1.2) * 0.025;
    resetRotation(shoulder);
    resetRotation(elbow);
    resetRotation(wrist);
    targetNode.getWorldPosition(targetWorld);
    poleNode.getWorldPosition(poleWorld);
    solver.poleVector = poleWorld;
    solver.solve(targetWorld);
    solver.applyToNodes(weight);
  };

  return {
    root,
    targetNode,
    poleNode,
    setWeight(nextWeight) {
      weight = Math.max(0, Math.min(1, nextWeight));
    },
    reset,
    update
  };
}
