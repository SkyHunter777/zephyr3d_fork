import { InterpolatorScalar, Matrix4x4, Quaternion, Vector3 } from '@zephyr3d/base';
import { Scene, SceneNode } from '../../../libs/scene/src/scene';
import {
  ColliderForce,
  type ColliderR,
  type ColliderRW,
  JointDynamicsSystem,
  type PointR,
  pushoutFromCapsule,
  simulate
} from '../../../libs/scene/src/animation/joint_dynamics';

function makeCapsule(height: number, scaledHeight: number): { colR: ColliderR; colRW: ColliderRW } {
  const colR: ColliderR = {
    radius: 0.5,
    radiusTailScale: 1,
    height,
    friction: 0,
    isInverseCollider: false,
    forceType: ColliderForce.Off
  };
  const colRW: ColliderRW = {
    positionCurrent: new Vector3(0, 0, 0),
    directionCurrent: new Vector3(0, scaledHeight, 0),
    boundsCenter: new Vector3(0, scaledHeight * 0.5, 0),
    boundsRadius: scaledHeight * 0.5 + colR.radius,
    positionCurrentTransform: new Vector3(0, scaledHeight * 0.5, 0),
    positionPreviousTransform: new Vector3(0, scaledHeight * 0.5, 0),
    directionCurrentTransform: Quaternion.identity(),
    directionPreviousTransform: Quaternion.identity(),
    worldToLocal: Matrix4x4.identity(),
    worldScale: new Vector3(2, 2, 2),
    localBoundsMin: Vector3.zero(),
    localBoundsMax: Vector3.zero(),
    radius: colR.radius * 2,
    height: scaledHeight,
    enabled: 1
  };
  return { colR, colRW };
}

describe('JointDynamics capsule collision', () => {
  it('rescales point parameters and constraints when the system root scale changes', () => {
    const scene = new Scene();
    const root = new SceneNode(scene);
    const child = new SceneNode(scene);
    root.parent = scene.rootNode;
    child.parent = root;
    child.position.setXYZ(0, 1, 0);

    const system = new JointDynamicsSystem({
      chainConfig: {
        systemRoot: root,
        chains: [{ start: root, end: child }]
      },
      controllerConfig: {
        gravity: new Vector3(0, -10, 0),
        curves: {
          pointRadius: InterpolatorScalar.constant(0.2)
        },
        constraintOptions: {
          structuralVertical: true
        }
      }
    });

    root.scale.setXYZ(0.1, 0.1, 0.1);
    system.update(1 / 60);

    const controller = system.controller as unknown as {
      _pointsR: Array<{ parentLength: number; pointRadius: number; gravity: Vector3 }>;
      _constraints: Array<{ length: number }>;
    };

    expect(controller._pointsR[1].parentLength).toBeCloseTo(0.1);
    expect(controller._pointsR[1].pointRadius).toBeCloseTo(0.02);
    expect(controller._pointsR[1].gravity.y).toBeCloseTo(-1);
    expect(controller._constraints[0].length).toBeCloseTo(0.1);
  });

  it('scales runtime capsule height during collider update', () => {
    const { colR, colRW } = makeCapsule(1, 0);
    colRW.positionCurrentTransform.setXYZ(0, 0, 0);
    colRW.positionPreviousTransform.setXYZ(0, 0, 0);

    simulate(
      {
        isPaused: false,
        stepTime: 1 / 60,
        subSteps: 1,
        rootPosition: Vector3.zero(),
        previousRootPosition: Vector3.zero(),
        rootSlideLimit: -1,
        rootRotation: Quaternion.identity(),
        previousRootRotation: Quaternion.identity(),
        rootRotateLimit: -1,
        windForce: Vector3.zero(),
        enableSurfaceCollision: false,
        surfaceConstraints: [],
        relaxation: 0,
        constraintShrinkLimit: 0,
        blendRatio: 0,
        isFakeWave: false,
        fakeWaveSpeed: 0,
        fakeWavePower: 0,
        fakeWaveCounter: 0,
        collisionScale: 1,
        enableBroadPhase: true
      },
      [],
      [],
      [],
      [colR],
      [colRW],
      [],
      [],
      [],
      []
    );

    expect(colRW.height).toBeCloseTo(2);
    expect(colRW.directionCurrent.y).toBeCloseTo(2);
    expect(colRW.positionCurrent.y).toBeCloseTo(-1);
  });

  it('uses scaled runtime capsule height for side contacts', () => {
    const { colR, colRW } = makeCapsule(1, 2);
    const pointR = { pointRadius: 0 } as PointR;
    const point = new Vector3(0.75, 1.25, 0);

    const result = pushoutFromCapsule(colR, colRW, point, pointR);

    expect(result.hit).toBe(true);
    expect(result.point.x).toBeCloseTo(1);
    expect(result.point.y).toBeCloseTo(1.25);
  });
});
