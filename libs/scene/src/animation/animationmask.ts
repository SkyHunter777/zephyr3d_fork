import type { AnimationSet } from './animationset';
import type { AnimationClip } from './animation';
import type { AnimationTrack } from './animationtrack';
import { NodeEulerRotationTrack } from './eulerrotationtrack';
import { NodeRotationTrack } from './rotationtrack';
import { NodeScaleTrack } from './scaletrack';
import { HumanoidBodyRig } from './skeleton';
import type { HumanoidJointMapping, SkeletonRig, HumanoidHandRig } from './skeleton';
import { NodeTranslationTrack } from './translationtrack';
import type { SceneNode } from '../scene';

/** @public */
export type SkeletalAnimationMaskRootMotionMode = 'include' | 'exclude' | 'only';

/** @public */
export type SkeletalAnimationMaskUnsupportedTrackMode = 'skip' | 'error';

/** @public */
export type HumanoidSkeletalAnimationMaskPreset =
  | 'fullBody'
  | 'upperBody'
  | 'lowerBody'
  | 'head'
  | 'arms'
  | 'leftArm'
  | 'rightArm'
  | 'legs'
  | 'leftLeg'
  | 'rightLeg';

/** @public */
export type JointNameMatcher = string | RegExp | ((joint: SceneNode) => boolean);

/** @public */
export type SkeletalAnimationMaskCommonOptions = {
  /**
   * How root translation tracks are copied.
   *
   * Defaults to `include` for lower/full body humanoid masks and to `exclude` otherwise.
   */
  rootMotion?: SkeletalAnimationMaskRootMotionMode;
  /**
   * How tracks outside node transform animation should be handled.
   *
   * Defaults to `skip`.
   */
  unsupportedTracks?: SkeletalAnimationMaskUnsupportedTrackMode;
};

/** @public */
export type HumanoidSkeletalAnimationMaskOptions = SkeletalAnimationMaskCommonOptions & {
  type: 'humanoid';
  /**
   * Optional semantic preset used as the initial joint set.
   */
  preset?: HumanoidSkeletalAnimationMaskPreset;
  /**
   * Boundary joint for `upperBody`. Defaults to `HumanoidBodyRig.Spine`.
   */
  boundary?: HumanoidBodyRig;
  /**
   * Additional body joints selected by semantic name.
   */
  includeBody?: HumanoidBodyRig[];
  /**
   * Body joints removed from the selected set.
   */
  excludeBody?: HumanoidBodyRig[];
  includeLeftHand?: HumanoidHandRig[];
  includeRightHand?: HumanoidHandRig[];
  excludeLeftHand?: HumanoidHandRig[];
  excludeRightHand?: HumanoidHandRig[];
  /**
   * Whether explicit semantic include/exclude entries affect their descendants.
   *
   * Defaults to true for humanoid semantic masks.
   */
  includeDescendants?: boolean;
};

/** @public */
export type NamedJointsSkeletalAnimationMaskOptions = SkeletalAnimationMaskCommonOptions & {
  type: 'joints';
  /**
   * Joint name matchers. If omitted, all rig joints are selected before exclusions.
   */
  include?: JointNameMatcher[];
  /**
   * Joint name matchers removed from the selected set.
   */
  exclude?: JointNameMatcher[];
  /**
   * Whether selected or excluded joints affect their descendants.
   *
   * Defaults to false for name masks.
   */
  includeDescendants?: boolean;
};

/** @public */
export type SkeletalAnimationMaskOptions =
  | HumanoidSkeletalAnimationMaskOptions
  | NamedJointsSkeletalAnimationMaskOptions;

function isNodeTransformTrack(track: AnimationTrack): boolean {
  return (
    track instanceof NodeRotationTrack ||
    track instanceof NodeEulerRotationTrack ||
    track instanceof NodeTranslationTrack ||
    track instanceof NodeScaleTrack
  );
}

function cloneTrack(track: AnimationTrack): AnimationTrack {
  const cloned = track.clone();
  cloned.name = track.name;
  cloned.target = track.target;
  cloned.jointIndex = track.jointIndex;
  return cloned;
}

function addJoint(set: Set<SceneNode>, rig: SkeletonRig, joint: SceneNode | undefined) {
  if (joint && rig.joints.includes(joint)) {
    set.add(joint);
  }
}

function addJointAndDescendants(set: Set<SceneNode>, rig: SkeletonRig, joint: SceneNode | undefined) {
  if (!joint) {
    return;
  }
  for (const candidate of rig.joints) {
    if (joint === candidate || joint.isParentOf(candidate)) {
      set.add(candidate);
    }
  }
}

function removeJointAndDescendants(set: Set<SceneNode>, rig: SkeletonRig, joint: SceneNode | undefined) {
  if (!joint) {
    return;
  }
  for (const candidate of rig.joints) {
    if (joint === candidate || joint.isParentOf(candidate)) {
      set.delete(candidate);
    }
  }
}

function addSemanticJoint(
  set: Set<SceneNode>,
  rig: SkeletonRig,
  joint: SceneNode | undefined,
  includeDescendants: boolean
) {
  if (includeDescendants) {
    addJointAndDescendants(set, rig, joint);
  } else {
    addJoint(set, rig, joint);
  }
}

function removeSemanticJoint(
  set: Set<SceneNode>,
  rig: SkeletonRig,
  joint: SceneNode | undefined,
  includeDescendants: boolean
) {
  if (includeDescendants) {
    removeJointAndDescendants(set, rig, joint);
  } else if (joint) {
    set.delete(joint);
  }
}

function addHumanoidPreset(
  set: Set<SceneNode>,
  rig: SkeletonRig,
  mapping: HumanoidJointMapping<SceneNode>,
  preset: HumanoidSkeletalAnimationMaskPreset,
  boundary: HumanoidBodyRig | undefined
) {
  const body = mapping.body;
  switch (preset) {
    case 'fullBody':
      for (const joint of rig.joints) {
        set.add(joint);
      }
      break;
    case 'upperBody':
      addJointAndDescendants(set, rig, body[boundary ?? HumanoidBodyRig.Spine]);
      removeJointAndDescendants(set, rig, body[HumanoidBodyRig.LeftUpperLeg]);
      removeJointAndDescendants(set, rig, body[HumanoidBodyRig.RightUpperLeg]);
      break;
    case 'lowerBody':
      addJoint(set, rig, body[HumanoidBodyRig.Hips]);
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.LeftUpperLeg]);
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.RightUpperLeg]);
      break;
    case 'head':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.Neck]);
      break;
    case 'arms':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.LeftShoulder]);
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.RightShoulder]);
      break;
    case 'leftArm':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.LeftShoulder]);
      break;
    case 'rightArm':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.RightShoulder]);
      break;
    case 'legs':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.LeftUpperLeg]);
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.RightUpperLeg]);
      break;
    case 'leftLeg':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.LeftUpperLeg]);
      break;
    case 'rightLeg':
      addJointAndDescendants(set, rig, body[HumanoidBodyRig.RightUpperLeg]);
      break;
  }
}

function selectHumanoidJoints(
  rig: SkeletonRig,
  options: HumanoidSkeletalAnimationMaskOptions
): Set<SceneNode> | null {
  const mapping = rig.humanoidJointMapping;
  if (!mapping) {
    console.error('createSkeletalMaskedAnimation: skeleton does not have a humanoid joint mapping');
    return null;
  }
  const selected = new Set<SceneNode>();
  if (options.preset) {
    addHumanoidPreset(selected, rig, mapping, options.preset, options.boundary);
  } else if (
    !options.includeBody?.length &&
    !options.includeLeftHand?.length &&
    !options.includeRightHand?.length
  ) {
    for (const joint of rig.joints) {
      selected.add(joint);
    }
  }

  const includeDescendants = options.includeDescendants ?? true;
  for (const semantic of options.includeBody ?? []) {
    addSemanticJoint(selected, rig, mapping.body[semantic], includeDescendants);
  }
  for (const semantic of options.includeLeftHand ?? []) {
    addSemanticJoint(selected, rig, mapping.leftHand?.[semantic], includeDescendants);
  }
  for (const semantic of options.includeRightHand ?? []) {
    addSemanticJoint(selected, rig, mapping.rightHand?.[semantic], includeDescendants);
  }
  for (const semantic of options.excludeBody ?? []) {
    removeSemanticJoint(selected, rig, mapping.body[semantic], includeDescendants);
  }
  for (const semantic of options.excludeLeftHand ?? []) {
    removeSemanticJoint(selected, rig, mapping.leftHand?.[semantic], includeDescendants);
  }
  for (const semantic of options.excludeRightHand ?? []) {
    removeSemanticJoint(selected, rig, mapping.rightHand?.[semantic], includeDescendants);
  }
  return selected;
}

function matchesJointName(joint: SceneNode, matcher: JointNameMatcher): boolean {
  if (typeof matcher === 'string') {
    return joint.name === matcher;
  }
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(joint.name);
  }
  return matcher(joint);
}

function selectNamedJoints(
  rig: SkeletonRig,
  options: NamedJointsSkeletalAnimationMaskOptions
): Set<SceneNode> {
  const selected = new Set<SceneNode>();
  const includeDescendants = options.includeDescendants ?? false;
  const included = options.include?.length
    ? rig.joints.filter((joint) => options.include!.some((matcher) => matchesJointName(joint, matcher)))
    : rig.joints;

  for (const joint of included) {
    if (includeDescendants) {
      addJointAndDescendants(selected, rig, joint);
    } else {
      selected.add(joint);
    }
  }

  for (const joint of rig.joints) {
    if (options.exclude?.some((matcher) => matchesJointName(joint, matcher))) {
      if (includeDescendants) {
        removeJointAndDescendants(selected, rig, joint);
      } else {
        selected.delete(joint);
      }
    }
  }
  return selected;
}

function getDefaultRootMotionMode(
  options: SkeletalAnimationMaskOptions
): SkeletalAnimationMaskRootMotionMode {
  if (options.rootMotion) {
    return options.rootMotion;
  }
  if (options.type === 'humanoid' && (options.preset === 'lowerBody' || options.preset === 'fullBody')) {
    return 'include';
  }
  return 'exclude';
}

function isRootMotionTrack(target: object, track: AnimationTrack, rig: SkeletonRig): boolean {
  if (!(track instanceof NodeTranslationTrack)) {
    return false;
  }
  const hips = rig.humanoidJointMapping?.body[HumanoidBodyRig.Hips];
  return (!!rig.rootJoint && target === rig.rootJoint) || (!!hips && target === hips);
}

function copySkeletonReferences(sourceClip: AnimationClip, targetClip: AnimationClip) {
  for (const id of sourceClip.skeletons) {
    targetClip.addSkeleton(id);
  }
}

/** @internal */
export function createSkeletalMaskedAnimationClip(
  animationSet: AnimationSet,
  sourceClip: AnimationClip,
  targetName: string,
  rig: SkeletonRig,
  options: SkeletalAnimationMaskOptions
): AnimationClip | null {
  const selectedJoints =
    options.type === 'humanoid' ? selectHumanoidJoints(rig, options) : selectNamedJoints(rig, options);
  if (!selectedJoints) {
    return null;
  }

  const rootMotion = getDefaultRootMotionMode(options);
  const unsupportedTracks = options.unsupportedTracks ?? 'skip';
  const targetClip = animationSet.createAnimation(targetName);
  if (!targetClip) {
    return null;
  }
  targetClip.timeDuration = sourceClip.timeDuration;
  targetClip.weight = sourceClip.weight;
  targetClip.autoPlay = sourceClip.autoPlay;
  copySkeletonReferences(sourceClip, targetClip);

  for (const [target, tracks] of sourceClip.tracks) {
    for (const track of tracks) {
      if (!isNodeTransformTrack(track)) {
        if (unsupportedTracks === 'error') {
          console.error(`createSkeletalMaskedAnimation: unsupported track type '${track.constructor.name}'`);
          animationSet.deleteAnimation(targetName);
          return null;
        }
        continue;
      }

      const rootMotionTrack = isRootMotionTrack(target, track, rig);
      const shouldCopy =
        rootMotion === 'only'
          ? rootMotionTrack
          : rootMotionTrack
            ? rootMotion === 'include'
            : selectedJoints.has(target as SceneNode);

      if (shouldCopy) {
        targetClip.addTrack(target, cloneTrack(track));
      }
    }
  }
  targetClip.timeDuration = sourceClip.timeDuration;
  return targetClip;
}
