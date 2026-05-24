import type { InterpolationMode, InterpolationTarget } from '@zephyr3d/base';
import { AABB, InterpolatorScalar, Quaternion } from '@zephyr3d/base';
import { base64ToUint8Array, Matrix4x4, uint8ArrayToBase64 } from '@zephyr3d/base';
import { Interpolator, Vector3 } from '@zephyr3d/base';
import { AnimationTrack, Skeleton } from '../../../animation';
import {
  AnimationClip,
  FixedGeometryCacheTrack,
  JointDynamicsModifier,
  JointDynamicsSystem,
  createTransformAccess,
  PCAGeometryCacheTrack,
  MorphTargetTrack,
  NodeEulerRotationTrack,
  NodeRotationTrack,
  NodeScaleTrack,
  NodeTranslationTrack,
  PropertyTrack
} from '../../../animation';
import type { ControllerConfig } from '../../../animation/joint_dynamics/controller';
import type { ColliderR, GrabberR, JointDynamicSystemConfig } from '../../../animation/joint_dynamics';
import type { ResourceManager } from '../manager';
import { defineProps, type SerializableClass } from '../types';
import { SceneNode } from '../../../scene';
import { BoundingBox } from '../../bounding_volume';

type SerializedScalarCurve = {
  mode: InterpolationMode;
  inputs: number[];
  outputs: number[];
};

type SerializedControllerConfig = Partial<Omit<ControllerConfig, 'gravity' | 'windForce' | 'curves'>> & {
  gravity?: number[];
  windForce?: number[];
  curves?: Record<string, SerializedScalarCurve>;
};

type SerializedJointDynamicsCollider = {
  collider: ColliderR;
  transform?: string;
  enabled?: boolean;
};

type SerializedJointDynamicsFlatPlane = {
  up: number[];
  position: number[];
  enabled?: boolean;
};

type SerializedJointDynamicsGrabber = {
  grabber: GrabberR;
  transform?: string;
  enabled?: boolean;
};

type SerializedJointDynamicsModifier = {
  skeleton: string;
  systemRoot: string;
  chains: { start: string; end: string }[];
  controllerConfig?: SerializedControllerConfig;
  colliders?: SerializedJointDynamicsCollider[];
  flatPlanes?: SerializedJointDynamicsFlatPlane[];
  grabbers?: SerializedJointDynamicsGrabber[];
  enabled?: boolean;
};

const jointDynamicsModifierSkeletons = new WeakMap<JointDynamicsModifier, Skeleton>();

function vectorToArray(value: Vector3): number[] {
  return [value.x, value.y, value.z];
}

function vectorFromArray(value: number[] | undefined, defaultValue = Vector3.zero()): Vector3 {
  return Array.isArray(value)
    ? new Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0)
    : defaultValue.clone();
}

function serializeScalarCurve(value: InterpolatorScalar): SerializedScalarCurve {
  return {
    mode: value.mode,
    inputs: [...value.inputs],
    outputs: [...value.outputs]
  };
}

function deserializeScalarCurve(value: SerializedScalarCurve): InterpolatorScalar {
  return new InterpolatorScalar(
    value?.mode ?? 'step',
    new Float32Array(value?.inputs ?? [0]),
    new Float32Array(value?.outputs ?? [0])
  );
}

function serializeControllerConfig(value: ControllerConfig): SerializedControllerConfig {
  const curves: Record<string, SerializedScalarCurve> = {};
  for (const [key, curve] of Object.entries(value.curves)) {
    curves[key] = serializeScalarCurve(curve);
  }
  return {
    gravity: vectorToArray(value.gravity),
    windForce: vectorToArray(value.windForce),
    relaxation: value.relaxation,
    subSteps: value.subSteps,
    rootSlideLimit: value.rootSlideLimit,
    rootRotateLimit: value.rootRotateLimit,
    constraintShrinkLimit: value.constraintShrinkLimit,
    blendRatio: value.blendRatio,
    stabilizationFrameRate: value.stabilizationFrameRate,
    isFakeWave: value.isFakeWave,
    fakeWaveSpeed: value.fakeWaveSpeed,
    fakeWavePower: value.fakeWavePower,
    enableSurfaceCollision: value.enableSurfaceCollision,
    enableBroadPhase: value.enableBroadPhase,
    preserveTwist: value.preserveTwist,
    angleLimitConfig: { ...value.angleLimitConfig },
    curves,
    constraintOptions: { ...value.constraintOptions }
  };
}

function deserializeControllerConfig(
  value: SerializedControllerConfig | undefined
): JointDynamicSystemConfig['controllerConfig'] {
  if (!value) {
    return undefined;
  }
  const curves = Object.fromEntries(
    Object.entries(value.curves ?? {}).map(([key, curve]) => [key, deserializeScalarCurve(curve)])
  ) as Partial<ControllerConfig['curves']>;
  const config: JointDynamicSystemConfig['controllerConfig'] = {};
  if (value.gravity) {
    config.gravity = vectorFromArray(value.gravity, new Vector3(0, -9.8, 0));
  }
  if (value.windForce) {
    config.windForce = vectorFromArray(value.windForce);
  }
  for (const key of [
    'relaxation',
    'subSteps',
    'rootSlideLimit',
    'rootRotateLimit',
    'constraintShrinkLimit',
    'blendRatio',
    'stabilizationFrameRate',
    'isFakeWave',
    'fakeWaveSpeed',
    'fakeWavePower',
    'enableSurfaceCollision',
    'enableBroadPhase',
    'preserveTwist'
  ] as const) {
    if (value[key] !== undefined) {
      config[key] = value[key] as never;
    }
  }
  if (value.angleLimitConfig) {
    config.angleLimitConfig = { ...value.angleLimitConfig };
  }
  if (Object.keys(curves).length > 0) {
    config.curves = curves;
  }
  if (value.constraintOptions) {
    config.constraintOptions = { ...value.constraintOptions };
  }
  return config;
}

function findSerializedNode(root: SceneNode, id: string | undefined): SceneNode | null {
  if (!id) {
    return null;
  }
  const prefabNode = root.getPrefabNode() ?? root;
  return prefabNode.findNodeById(id) ?? root.scene?.findNodeById(id) ?? null;
}

export function setJointDynamicsModifierSkeleton(modifier: JointDynamicsModifier, skeleton: Skeleton): void {
  jointDynamicsModifierSkeletons.set(modifier, skeleton);
}

export function getJointDynamicsModifierSkeleton(modifier: JointDynamicsModifier): Skeleton | null {
  return jointDynamicsModifierSkeletons.get(modifier) ?? null;
}

/** @internal */
export function getJointDynamicsModifierClass(): SerializableClass {
  return {
    ctor: JointDynamicsModifier,
    name: 'JointDynamicsModifier',
    createFunc(ctx: SceneNode, init: SerializedJointDynamicsModifier) {
      const skeleton = ctx.findSkeletonById(init.skeleton);
      const systemRoot = findSerializedNode(ctx, init.systemRoot);
      if (!skeleton || !systemRoot) {
        return { obj: null, loadProps: false };
      }
      const chains = (init.chains ?? [])
        .map((chain) => {
          const start = findSerializedNode(ctx, chain.start);
          const end = findSerializedNode(ctx, chain.end);
          return start && end ? { start, end } : null;
        })
        .filter((chain): chain is { start: SceneNode; end: SceneNode } => {
          return !!chain && chain.start.isParentOf(chain.end);
        });
      if (chains.length === 0) {
        return { obj: null, loadProps: false };
      }
      const serializedColliders = init.colliders ?? [];
      const colliders: { r: ColliderR; transform: ReturnType<typeof createTransformAccess> }[] =
        serializedColliders.map((item) => {
          const transform = findSerializedNode(ctx, item.transform);
          return {
            r: { ...item.collider },
            transform: transform
              ? createTransformAccess(transform)
              : createTransformAccess(new SceneNode(null), false)
          };
        });
      const serializedGrabbers = init.grabbers ?? [];
      const grabbers: {
        r: GrabberR;
        transform: ReturnType<typeof createTransformAccess>;
        enabled: boolean;
      }[] = serializedGrabbers.map((item) => {
        const transform = findSerializedNode(ctx, item.transform);
        return {
          r: { ...item.grabber },
          transform: transform
            ? createTransformAccess(transform)
            : createTransformAccess(new SceneNode(null), false),
          enabled: item.enabled ?? false
        };
      });
      const flatPlanes = (init.flatPlanes ?? []).map((item) => ({
        up: vectorFromArray(item.up, Vector3.axisPY()),
        position: vectorFromArray(item.position),
        enabled: item.enabled ?? true
      }));
      const controllerConfig = deserializeControllerConfig(init.controllerConfig);
      const config: JointDynamicSystemConfig = {
        chainConfig: {
          systemRoot,
          chains
        },
        controllerConfig
      };
      const system = new JointDynamicsSystem(
        config,
        colliders,
        grabbers,
        flatPlanes.map((item) => ({ up: item.up, position: item.position }))
      );
      for (let i = 0; i < serializedColliders.length; i++) {
        if (serializedColliders[i]?.enabled === false) {
          system.controller.setColliderEnabledAt(i, false);
        }
      }
      for (let i = 0; i < flatPlanes.length; i++) {
        if (!flatPlanes[i].enabled) {
          system.controller.setFlatPlaneEnabledAt(i, false);
        }
      }
      const modifier = new JointDynamicsModifier(system);
      modifier.enabled = init.enabled ?? true;
      setJointDynamicsModifierSkeleton(modifier, skeleton);
      return { obj: modifier, loadProps: false };
    },
    getInitParams(obj: JointDynamicsModifier) {
      const skeleton = getJointDynamicsModifierSkeleton(obj);
      const chainConfig = obj.jointDynamicsSystem.chainConfig;
      const controllerConfig = obj.jointDynamicsSystem.controller.getConfig();
      const init: SerializedJointDynamicsModifier = {
        skeleton: skeleton?.persistentId ?? '',
        systemRoot: chainConfig.systemRoot.persistentId,
        chains: chainConfig.chains.map((chain) => ({
          start: chain.start.persistentId,
          end: chain.end.persistentId
        })),
        controllerConfig: serializeControllerConfig(controllerConfig),
        colliders: obj.jointDynamicsSystem.getColliderSnapshots().map((item) => ({
          collider: { ...item.r },
          transform: item.transform instanceof SceneNode ? item.transform.persistentId : undefined,
          enabled: item.enabled
        })),
        flatPlanes: obj.jointDynamicsSystem.getFlatPlaneSnapshots().map((item) => ({
          up: vectorToArray(item.up),
          position: vectorToArray(item.position),
          enabled: item.enabled
        })),
        grabbers: obj.jointDynamicsSystem.getGrabberSnapshots().map((item) => ({
          grabber: { ...item.r },
          transform: item.transform instanceof SceneNode ? item.transform.persistentId : undefined,
          enabled: item.enabled
        })),
        enabled: obj.enabled
      };
      return init;
    },
    getProps() {
      return [];
    }
  };
}

/** @internal */
export function getInterpolatorClass(): SerializableClass {
  return {
    ctor: Interpolator,
    name: 'Interpolator',
    createFunc(
      ctx,
      init: { mode: InterpolationMode; target: InterpolationTarget; inputs: string; outputs: string }
    ) {
      const inputs = init.inputs
        ? new Float32Array(base64ToUint8Array(init.inputs).buffer)
        : new Float32Array();
      const outputs = init.outputs
        ? new Float32Array(base64ToUint8Array(init.outputs).buffer)
        : new Float32Array();
      return { obj: new Interpolator(init.mode, init.target, inputs, outputs) };
    },
    getInitParams(obj: Interpolator) {
      const inputs: Float32Array<ArrayBuffer> =
        obj.inputs instanceof Float32Array
          ? obj.inputs
          : obj.inputs
            ? new Float32Array(obj.inputs)
            : new Float32Array();
      const outputs: Float32Array<ArrayBuffer> =
        obj.outputs instanceof Float32Array
          ? obj.outputs
          : obj.outputs
            ? new Float32Array(obj.outputs)
            : new Float32Array();
      return {
        mode: obj.mode,
        target: obj.target,
        inputs: uint8ArrayToBase64(new Uint8Array(inputs.buffer, inputs.byteOffset, inputs.byteLength)),
        outputs: uint8ArrayToBase64(new Uint8Array(outputs.buffer, outputs.byteOffset, outputs.byteLength))
      };
    },
    getProps() {
      return defineProps([
        {
          name: 'Mode',
          description:
            'What kind of method does this interpolator use to interpolate data, possible value is `step` | `linear` | `cubicspline` | `cubicspline-natural`',
          type: 'string',
          get(this: Interpolator, value) {
            value.str[0] = this.mode;
          }
        },
        {
          name: 'Target',
          description:
            'What type of data this interpolator handles, possible value is `number` | `vec2` | `vec3` | `vec4 | `quat`',
          type: 'string',
          get(this: Interpolator, value) {
            value.str[0] = this.target ?? '';
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getMorphTrackClass(): SerializableClass {
  return {
    ctor: MorphTargetTrack,
    name: 'MorphTargetTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: MorphTargetTrack, value) {
            value.str[0] = this.name;
          },
          set(this: MorphTargetTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'Interpolator',
          description: 'Interpolator object for this track',
          type: 'object',
          options: {
            objectTypes: [Interpolator]
          },
          isHidden() {
            return true;
          },
          get(this: MorphTargetTrack, value) {
            value.object[0] = this.interpolator;
          },
          set(this: MorphTargetTrack, value) {
            this.interpolator = value.object[0] as Interpolator;
          }
        },
        {
          name: 'DefaultWeights',
          description: 'Default weights for this track',
          type: 'object',
          get(this: MorphTargetTrack, value) {
            value.object[0] = this.defaultWeights ?? null;
          },
          set(this: MorphTargetTrack, value) {
            this.defaultWeights = (value.object[0] as number[]) ?? null;
          }
        },
        {
          name: 'OriginBoundingBox',
          description: 'Original bounding box',
          type: 'object',
          get(this: MorphTargetTrack, value) {
            if (!this.originBoundingBox) {
              value.object[0] = null;
            } else {
              const arr = [...this.originBoundingBox.minPoint, ...this.originBoundingBox.maxPoint];
              value.object[0] = arr;
            }
          },
          set(this: MorphTargetTrack, value) {
            if (!value.object[0]) {
              this.originBoundingBox = null;
            } else {
              const bbox = new AABB();
              const values = value.object[0] as number[];
              bbox.minPoint.setXYZ(values[0], values[1], values[2]);
              bbox.maxPoint.setXYZ(values[3], values[4], values[5]);
              this.originBoundingBox = bbox;
            }
          }
        },
        {
          name: 'BoundingBox',
          description: 'Bounding box when this track in action',
          type: 'object',
          get(this: MorphTargetTrack, value) {
            if (!this.boundingBox) {
              value.object[0] = null;
            } else {
              const arr: number[] = [];
              for (const box of this.boundingBox) {
                arr.push(...box.minPoint);
                arr.push(...box.maxPoint);
              }
              value.object[0] = arr;
            }
          },
          set(this: MorphTargetTrack, value) {
            if (!value.object[0]) {
              this.boundingBox = null;
            } else {
              const arr: BoundingBox[] = [];
              const values = value.object[0] as number[];
              for (let i = 0; i < values.length / 6; i++) {
                arr.push(
                  new BoundingBox(
                    new Vector3(values[i * 6 + 0], values[i * 6 + 1], values[i * 6 + 2]),
                    new Vector3(values[i * 6 + 3], values[i * 6 + 4], values[i * 6 + 5])
                  )
                );
              }
              this.boundingBox = arr;
            }
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: NodeRotationTrack, value) {
            value.str[0] = this.target;
          },
          set(this: NodeRotationTrack, value) {
            this.target = value.str[0];
          }
        }
      ]);
    }
  };
}

function encodeFloat32Array(values: Float32Array) {
  return uint8ArrayToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

function decodeFloat32Array(value: string) {
  return new Float32Array(base64ToUint8Array(value).buffer);
}

export function getFixedGeometryCacheTrackClass(): SerializableClass {
  return {
    ctor: FixedGeometryCacheTrack,
    name: 'FixedGeometryCacheTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: FixedGeometryCacheTrack, value) {
            value.str[0] = this.name;
          },
          set(this: FixedGeometryCacheTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: FixedGeometryCacheTrack, value) {
            value.str[0] = this.target;
          },
          set(this: FixedGeometryCacheTrack, value) {
            this.target = value.str[0];
          }
        },
        {
          name: 'Times',
          description: 'Keyframe timestamps for this geometry cache track',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: FixedGeometryCacheTrack, value) {
            value.str[0] = encodeFloat32Array(this.times);
          },
          set(this: FixedGeometryCacheTrack, value) {
            this.times = value.str[0] ? decodeFloat32Array(value.str[0]) : new Float32Array();
          }
        },
        {
          name: 'Frames',
          description: 'Serialized geometry cache frames for this track',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: FixedGeometryCacheTrack, value) {
            value.object[0] = this.frames.map((frame) => ({
              positions: encodeFloat32Array(frame.positions),
              normals: frame.normals ? encodeFloat32Array(frame.normals) : '',
              bounds: [
                frame.boundingBox.minPoint.x,
                frame.boundingBox.minPoint.y,
                frame.boundingBox.minPoint.z,
                frame.boundingBox.maxPoint.x,
                frame.boundingBox.maxPoint.y,
                frame.boundingBox.maxPoint.z
              ]
            }));
          },
          set(this: FixedGeometryCacheTrack, value) {
            this.frames = (
              (value.object[0] as Array<{
                positions: string;
                normals: string;
                bounds: number[];
              }>) ?? []
            ).map((frame) => ({
              positions: decodeFloat32Array(frame.positions),
              normals: frame.normals ? decodeFloat32Array(frame.normals) : null,
              boundingBox: new BoundingBox(
                new Vector3(frame.bounds[0], frame.bounds[1], frame.bounds[2]),
                new Vector3(frame.bounds[3], frame.bounds[4], frame.bounds[5])
              )
            }));
          }
        }
      ]);
    }
  };
}

export function getPCAGeometryCacheTrackClass(): SerializableClass {
  return {
    ctor: PCAGeometryCacheTrack,
    name: 'PCAGeometryCacheTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.str[0] = this.name;
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.str[0] = this.target;
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.target = value.str[0];
          }
        },
        {
          name: 'Times',
          description: 'Keyframe timestamps for this PCA geometry cache track',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.str[0] = encodeFloat32Array(this.times);
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.times = value.str[0] ? decodeFloat32Array(value.str[0]) : new Float32Array();
          }
        },
        {
          name: 'Bounds',
          description: 'Per-frame bounding boxes for the PCA geometry cache',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.object[0] = this.bounds;
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.bounds = (value.object[0] as [number, number, number, number, number, number][]) ?? [];
          }
        },
        {
          name: 'PositionReference',
          description: 'Reference position data for the PCA geometry cache',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.str[0] = this.positionReference ? encodeFloat32Array(this.positionReference) : '';
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.positionReference = value.str[0] ? decodeFloat32Array(value.str[0]) : null;
          }
        },
        {
          name: 'PositionMean',
          description: 'Mean position data for the PCA geometry cache',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.str[0] = encodeFloat32Array(this.positionMean);
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.positionMean = value.str[0] ? decodeFloat32Array(value.str[0]) : new Float32Array();
          }
        },
        {
          name: 'PositionBases',
          description: 'Principal position basis vectors for the PCA geometry cache',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.object[0] = this.positionBases.map((item) => encodeFloat32Array(item));
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.positionBases = ((value.object[0] as string[]) ?? []).map((item) =>
              decodeFloat32Array(item)
            );
          }
        },
        {
          name: 'PositionCoefficients',
          description: 'Per-frame position coefficient data for the PCA geometry cache',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.object[0] = this.positionCoefficients.map((item) => encodeFloat32Array(item));
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.positionCoefficients = ((value.object[0] as string[]) ?? []).map((item) =>
              decodeFloat32Array(item)
            );
          }
        },
        {
          name: 'NormalMean',
          description: 'Mean normal data for the PCA geometry cache',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.str[0] = this.normalMean ? encodeFloat32Array(this.normalMean) : '';
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.normalMean = value.str[0] ? decodeFloat32Array(value.str[0]) : null;
          }
        },
        {
          name: 'NormalBases',
          description: 'Principal normal basis vectors for the PCA geometry cache',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.object[0] = this.normalBases?.map((item) => encodeFloat32Array(item)) ?? [];
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.normalBases =
              ((value.object[0] as string[]) ?? []).map((item) => decodeFloat32Array(item)) ?? null;
          }
        },
        {
          name: 'NormalCoefficients',
          description: 'Per-frame normal coefficient data for the PCA geometry cache',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: PCAGeometryCacheTrack, value) {
            value.object[0] = this.normalCoefficients?.map((item) => encodeFloat32Array(item)) ?? [];
          },
          set(this: PCAGeometryCacheTrack, value) {
            this.normalCoefficients =
              ((value.object[0] as string[]) ?? []).map((item) => decodeFloat32Array(item)) ?? null;
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getNodeRotationTrackClass(): SerializableClass {
  return {
    ctor: NodeRotationTrack,
    name: 'NodeRotationTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: NodeRotationTrack, value) {
            value.str[0] = this.name;
          },
          set(this: NodeRotationTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'Interpolator',
          description: 'Interpolator object for this track',
          type: 'object',
          options: {
            objectTypes: [Interpolator]
          },
          isHidden() {
            return true;
          },
          get(this: NodeRotationTrack, value) {
            value.object[0] = this.interpolator;
          },
          set(this: NodeRotationTrack, value) {
            this.interpolator = value.object[0] as Interpolator;
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: NodeRotationTrack, value) {
            value.str[0] = this.target;
          },
          set(this: NodeRotationTrack, value) {
            this.target = value.str[0];
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getNodeEulerRotationTrackClass(): SerializableClass {
  return {
    ctor: NodeEulerRotationTrack,
    name: 'NodeEulerRotationTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: NodeEulerRotationTrack, value) {
            value.str[0] = this.name;
          },
          set(this: NodeEulerRotationTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'Interpolator',
          description: 'Interpolator object for this track',
          type: 'object',
          options: {
            objectTypes: [Interpolator]
          },
          isHidden() {
            return true;
          },
          get(this: NodeEulerRotationTrack, value) {
            value.object[0] = this.interpolator;
          },
          set(this: NodeEulerRotationTrack, value) {
            this.interpolator = value.object[0] as Interpolator;
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: NodeEulerRotationTrack, value) {
            value.str[0] = this.target;
          },
          set(this: NodeEulerRotationTrack, value) {
            this.target = value.str[0];
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getNodeTranslationTrackClass(): SerializableClass {
  return {
    ctor: NodeTranslationTrack,
    name: 'NodeTranslationTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: NodeTranslationTrack, value) {
            value.str[0] = this.name;
          },
          set(this: NodeTranslationTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'Interpolator',
          description: 'Interpolator object for this track',
          type: 'object',
          options: {
            objectTypes: [Interpolator]
          },
          isHidden() {
            return true;
          },
          get(this: NodeTranslationTrack, value) {
            value.object[0] = this.interpolator;
          },
          set(this: NodeTranslationTrack, value) {
            this.interpolator = value.object[0] as Interpolator;
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: NodeTranslationTrack, value) {
            value.str[0] = this.target;
          },
          set(this: NodeTranslationTrack, value) {
            this.target = value.str[0];
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getNodeScaleTrackClass(): SerializableClass {
  return {
    ctor: NodeScaleTrack,
    name: 'NodeScaleTrack',
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: NodeScaleTrack, value) {
            value.str[0] = this.name;
          },
          set(this: NodeScaleTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'Interpolator',
          description: 'Interpolator object for this track',
          type: 'object',
          options: {
            objectTypes: [Interpolator]
          },
          isHidden() {
            return true;
          },
          get(this: NodeScaleTrack, value) {
            value.object[0] = this.interpolator;
          },
          set(this: NodeScaleTrack, value) {
            this.interpolator = value.object[0] as Interpolator;
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          isHidden() {
            return true;
          },
          get(this: NodeScaleTrack, value) {
            value.str[0] = this.target;
          },
          set(this: NodeScaleTrack, value) {
            this.target = value.str[0];
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getPropTrackClass(manager: ResourceManager): SerializableClass {
  return {
    ctor: PropertyTrack,
    name: 'PropertyTrack',
    createFunc(ctx, init) {
      return { obj: new PropertyTrack(manager.getPropertyByName(init)) };
    },
    getInitParams(obj: PropertyTrack) {
      return manager.getPropertyName(obj.getProp());
    },
    getProps() {
      return defineProps([
        {
          name: 'TrackName',
          description: 'The track name',
          type: 'string',
          options: {
            label: 'Name'
          },
          get(this: PropertyTrack, value) {
            value.str[0] = this.name;
          },
          set(this: PropertyTrack, value) {
            this.name = value.str[0];
          }
        },
        {
          name: 'TrackTarget',
          description: 'Target object this track applys to',
          type: 'string',
          options: {
            label: 'Target'
          },
          get(this: PropertyTrack, value) {
            value.str[0] = this.target;
          },
          set(this: PropertyTrack, value) {
            this.target = value.str[0];
          }
        },
        {
          name: 'TrackProp',
          description: 'Which property of the target object does this track handle',
          type: 'string',
          get(this: PropertyTrack, value) {
            value.str[0] = manager.getPropertyName(this.getProp()) ?? '';
          }
        },
        {
          name: 'TrackData',
          description: 'Interpolator data used by this property track',
          type: 'object_array',
          options: {
            objectTypes: [Interpolator]
          },
          isHidden(this: PropertyTrack, index: number) {
            return index >= 0;
          },
          get(this: PropertyTrack, value) {
            value.object = this.interpolatorAlpha
              ? [this.interpolator, this.interpolatorAlpha]
              : [this.interpolator];
          },
          set(this: PropertyTrack, value) {
            this.interpolator = value.object[0] as Interpolator;
            this.interpolatorAlpha = value.object[1] as Interpolator;
          }
        }
      ]);
    }
  };
}

/** @internal */
export function getSkeletonClass(): SerializableClass {
  return {
    ctor: Skeleton,
    name: 'Skeleton',
    createFunc(
      ctx: SceneNode,
      init: {
        joints: string[];
        inverseBindMatrices: string;
        bindPoseMatrices: string;
        bindPose: string;
        id: string;
      }
    ) {
      const prefabNode = ctx.getPrefabNode() ?? ctx;
      const joints = init.joints
        .map((id) => prefabNode.findNodeById(id)!)
        .map((node) => {
          node!.jointTypeT = 'static';
          node!.jointTypeS = 'static';
          node!.jointTypeR = 'static';
          return node;
        });
      const inverseBindMatricesArray = new Float32Array(base64ToUint8Array(init.inverseBindMatrices).buffer);
      const bindPoseArray = new Float32Array(
        base64ToUint8Array(init.bindPose ?? init.bindPoseMatrices).buffer
      );
      const inverseBindMatrices: Matrix4x4[] = [];
      const bindPose: { rotation: Quaternion; scale: Vector3; position: Vector3 }[] = [];
      for (let i = 0; i < joints.length; i++) {
        inverseBindMatrices.push(new Matrix4x4(inverseBindMatricesArray.slice(i * 16, i * 16 + 16)));
        if (!init.bindPose) {
          const matrix = new Matrix4x4(bindPoseArray.slice(i * 16, i * 16 + 16));
          const trs = {
            position: new Vector3(),
            rotation: new Quaternion(),
            scale: new Vector3()
          };
          matrix.decompose(trs.scale, trs.rotation, trs.position);
          bindPose.push(trs);
        } else {
          bindPose.push({
            position: new Vector3(
              bindPoseArray[i * 10 + 0],
              bindPoseArray[i * 10 + 1],
              bindPoseArray[i * 10 + 2]
            ),
            rotation: new Quaternion(
              bindPoseArray[i * 10 + 3],
              bindPoseArray[i * 10 + 4],
              bindPoseArray[i * 10 + 5],
              bindPoseArray[i * 10 + 6]
            ),
            scale: new Vector3(
              bindPoseArray[i * 10 + 7],
              bindPoseArray[i * 10 + 8],
              bindPoseArray[i * 10 + 9]
            )
          });
        }
      }
      const skeleton = new Skeleton(joints, inverseBindMatrices, bindPose);
      skeleton.persistentId = init.id;
      return {
        obj: skeleton,
        loadProps: false
      };
    },
    getInitParams(obj: Skeleton) {
      const inverseBindMatrices: number[] = obj.inverseBindMatrices
        .map((v) => [...v])
        .reduce((a, b) => [...a, ...b], []);
      const bindPose: number[] = obj.bindPose
        .map((v) => [...v.position, ...v.rotation, ...v.scale])
        .reduce((a, b) => [...a, ...b], []);
      return {
        joints: obj.joints.map((joint) => joint.persistentId),
        inverseBindMatrices: uint8ArrayToBase64(new Uint8Array(new Float32Array(inverseBindMatrices).buffer)),
        bindPose: uint8ArrayToBase64(new Uint8Array(new Float32Array(bindPose).buffer)),
        id: obj.persistentId
      };
    },
    getProps() {
      return [];
    }
  };
}

/** @internal */
export function getAnimationClass(manager: ResourceManager): SerializableClass {
  return {
    ctor: AnimationClip,
    name: 'AnimationClip',
    createFunc(ctx: SceneNode, init: string) {
      return { obj: ctx.animationSet.get(init) ?? ctx.animationSet.createAnimation(init, false) };
    },
    getInitParams(obj: AnimationClip) {
      return obj.name;
    },
    getProps() {
      return defineProps([
        {
          name: 'Name',
          description: 'The animation name, unique in `AnimationSet`',
          type: 'string',
          get(this: AnimationClip, value) {
            value.str[0] = this.name;
          }
        },
        {
          name: 'Duration',
          description: 'Time duration of the animation in seconds',
          type: 'float',
          default: 1,
          get(this: AnimationClip, value) {
            value.num[0] = this.timeDuration;
          },
          set(this: AnimationClip, value) {
            this.timeDuration = value.num[0];
          }
        },
        {
          name: 'Weight',
          description: 'Weight of this animation, used in animation blending',
          type: 'float',
          default: 1,
          get(this: AnimationClip, value) {
            value.num[0] = this.weight;
          },
          set(this: AnimationClip, value) {
            this.weight = value.num[0];
          }
        },
        {
          name: 'AutoPlay',
          description: 'Whether this animation should automatically start playing when model is loaded',
          type: 'bool',
          default: false,
          get(this: AnimationClip, value) {
            value.bool[0] = this.autoPlay;
          },
          set(this: AnimationClip, value) {
            this.autoPlay = value.bool[0];
          }
        },
        {
          name: 'Skeletons',
          description: 'Skeleton references used by this animation clip',
          type: 'object',
          isHidden() {
            return true;
          },
          get(this: AnimationClip, value) {
            value.object[0] = [...this.skeletons];
          },
          set(this: AnimationClip, value) {
            if (!this.skeletons) {
              this.skeletons = new Set();
            }
            for (const val of (value.object[0] as string[]) ?? []) {
              this.skeletons.add(val);
            }
          }
        },
        {
          name: 'Tracks',
          description: 'Animation tracks of this animation clip',
          type: 'object_array',
          options: {
            edit: 'proptrack',
            objectTypes: [PropertyTrack]
          },
          readonly: true,
          isHidden(this: AnimationClip, index: number, obj: unknown) {
            if (index < 0) {
              return false;
            } else {
              return !(obj instanceof PropertyTrack);
            }
          },
          get(this: AnimationClip, value) {
            value.object = [];
            for (const tracks of this.tracks) {
              for (const track of tracks[1]) {
                if (tracks[0] instanceof SceneNode && !(track instanceof PropertyTrack)) {
                  track.target = tracks[0].persistentId;
                }
              }
              //value.object.push(...tracks[1].filter((track) => track instanceof PropertyTrack));
              value.object.push(...tracks[1]);
            }
          },
          set(this: AnimationClip, value) {
            for (const track of value.object) {
              if (track instanceof PropertyTrack) {
                const targetObj = manager.findAnimationTarget(this._animationSet.model, track);
                if (targetObj) {
                  this.addTrack(targetObj, track);
                }
              } else if (track instanceof AnimationTrack) {
                const prefabNode = this._animationSet.model.getPrefabNode() ?? this._animationSet.model;
                const node = prefabNode.findNodeById(track.target);
                if (node) {
                  this.addTrack(node, track);
                } else {
                  console.error(`No node found with id = ${track.target}`);
                }
              }
            }
          },
          delete(this: AnimationClip, index) {
            const trackList: AnimationTrack[] = [];
            for (const tracks of this.tracks) {
              trackList.push(...tracks[1].filter((track) => track instanceof PropertyTrack));
            }
            const trackToRemove = trackList[index];
            if (trackToRemove) {
              this.deleteTrack(trackToRemove);
            }
          }
        }
      ]);
    }
  };
}
