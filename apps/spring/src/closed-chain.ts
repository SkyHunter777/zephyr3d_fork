// Closed chain demo - open bone chain with coincident fixed endpoints.

import { InterpolatorScalar, Quaternion, Vector4 } from '@zephyr3d/base';
import type { ColliderR, GrabberR, Scene } from '@zephyr3d/scene';
import { CapsuleShape, createTransformAccess, JointDynamicsSystem } from '@zephyr3d/scene';
import { LambertMaterial, Mesh, SceneNode, SphereShape } from '@zephyr3d/scene';
import { Vector3 } from '@zephyr3d/base';

export interface ClosedChainDemo {
  root: SceneNode;
  bones: SceneNode[];
  colliderObj: SceneNode;
  grabberObj: SceneNode;
  springSystem: JointDynamicsSystem;
  collidersR: ColliderR[];
  fixedIndices: number[];
  update: (time: number, dt: number) => void;
}

function ellipsePoint(index: number, segmentCount: number, radiusX: number, radiusY: number): Vector3 {
  const t = index / segmentCount;
  const angle = Math.PI / 2 + t * Math.PI * 2;
  return new Vector3(Math.cos(angle) * radiusX, Math.sin(angle) * radiusY, 0);
}

export function createClosedChainDemo(scene: Scene): ClosedChainDemo {
  const SEGMENTS = 18;
  const RADIUS_X = 0.58;
  const RADIUS_Y = 0.44;
  const POINT_RADIUS = 0.035;
  const NECK_RADIUS = 0.22;
  const NECK_HEIGHT = 0.75;

  const sysroot = new SceneNode(scene);
  sysroot.position.setXYZ(0, 1.35, 0);

  const points = Array.from({ length: SEGMENTS + 1 }, (_, i) =>
    ellipsePoint(i, SEGMENTS, RADIUS_X, RADIUS_Y)
  );

  const root = new SceneNode(scene);
  root.position.set(points[0]);
  root.parent = sysroot;

  const bones: SceneNode[] = [];
  let parent = root;
  for (let i = 1; i < points.length; i++) {
    const bone = new SceneNode(scene);
    bone.position.set(Vector3.sub(points[i], points[i - 1]));
    bone.parent = parent;
    bones.push(bone);
    parent = bone;
  }

  const beadGeo = new SphereShape({ radius: POINT_RADIUS });
  const beadMat = new LambertMaterial();
  beadMat.albedoColor = new Vector4(0.9, 0.72, 0.25, 1);
  const fixedMat = new LambertMaterial();
  fixedMat.albedoColor = new Vector4(0.2, 0.7, 1, 1);

  const allPoints = [root, ...bones];
  for (let i = 0; i < allPoints.length; i++) {
    const mesh = new Mesh(scene, beadGeo, i === 0 || i === allPoints.length - 1 ? fixedMat : beadMat);
    mesh.parent = allPoints[i];
  }

  const colliderObj = new SceneNode(scene);
  colliderObj.position.setXYZ(0, 1.27, 0);
  const colliderMat = new LambertMaterial();
  colliderMat.albedoColor = new Vector4(0.18, 0.28, 0.38, 1);
  const colliderVis = new Mesh(
    scene,
    new CapsuleShape({ radius: NECK_RADIUS, height: NECK_HEIGHT }),
    colliderMat
  );
  colliderVis.parent = colliderObj;

  const grabberObj = new SceneNode(scene);
  grabberObj.position.setXYZ(0, 0.95, 0.35);
  const grabberVis = new Mesh(scene, new SphereShape({ radius: 0.28 }), new LambertMaterial());
  grabberVis.parent = grabberObj;
  grabberVis.showState = 'hidden';

  const collidersR: ColliderR[] = [
    {
      radius: NECK_RADIUS,
      radiusTailScale: 1,
      height: NECK_HEIGHT,
      friction: 0.25,
      isInverseCollider: false,
      forceType: 0
    }
  ];
  const grabbersR: GrabberR[] = [{ radius: 0.28, force: 0.45 }];

  const springSystem = new JointDynamicsSystem(
    {
      chainConfig: {
        systemRoot: sysroot,
        chains: [{ start: root, end: bones[bones.length - 1] }]
      },
      controllerConfig: {
        gravity: new Vector3(0, -9.8, 0),
        relaxation: 6,
        subSteps: 4,
        enableBroadPhase: true,
        curves: {
          resistance: InterpolatorScalar.constant(0.992),
          hardness: InterpolatorScalar.constant(0.002),
          pointRadius: InterpolatorScalar.constant(POINT_RADIUS),
          structuralShrinkVertical: InterpolatorScalar.constant(0.95),
          structuralStretchVertical: InterpolatorScalar.constant(0.95),
          bendingShrinkVertical: InterpolatorScalar.constant(0.003),
          bendingStretchVertical: InterpolatorScalar.constant(0.003)
        },
        constraintOptions: {
          structuralVertical: true,
          bendingVertical: true,
          collideStructuralVertical: true
        }
      }
    },
    [{ r: collidersR[0], transform: createTransformAccess(colliderObj) }],
    [{ r: grabbersR[0], transform: createTransformAccess(grabberObj), enabled: false }],
    [{ up: new Vector3(0, 1, 0), position: new Vector3(0, 0, 0) }]
  );

  const fixedIndices = [0, springSystem.controller.pointCount - 1];
  const tailTransform = createTransformAccess(bones[bones.length - 1]);
  springSystem.controller.fixPoint(fixedIndices[1]);
  springSystem.controller.reset();

  const update = (time: number, dt: number) => {
    sysroot.position.x = Math.sin(time * 1.1) * 0.18;
    sysroot.rotation = Quaternion.fromAxisAngle(Vector3.axisPY(), Math.sin(time * 0.8) * 0.35);
    colliderObj.position.x = sysroot.position.x;

    tailTransform.setWorldPosition(root.getWorldPosition());
    springSystem.update(dt);
  };

  return {
    root: sysroot,
    bones,
    colliderObj,
    grabberObj,
    springSystem,
    collidersR,
    fixedIndices,
    update
  };
}
