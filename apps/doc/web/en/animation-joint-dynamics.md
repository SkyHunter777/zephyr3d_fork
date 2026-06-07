# Joint Dynamics

Joint Dynamics adds elasticity, inertia, and collision response to bone chains. It is useful for secondary motion such as hair, tails, ribbons, skirts, cloth-like grids, and hanging accessories.

The system builds simulation points and constraints from scene-node bone chains, advances them with Verlet integration, then writes the result back to the joint node positions and rotations. It can be updated manually, or attached to the skeleton post-processing pipeline through `JointDynamicsModifier`.

---

## Main Classes

| Class / Function | Purpose |
|------------------|---------|
| `JointDynamicsSystem` | High-level wrapper that creates a simulation from bone chains |
| `JointDynamicsSystemController` | Low-level runtime controller for parameters, colliders, grabbers, and fixed points |
| `JointDynamicsModifier` | Integrates a `JointDynamicsSystem` into the skeleton modifier pipeline |
| `createTransformAccess()` | Wraps a `SceneNode` as a transform adapter readable and writable by the solver |

---

## Creating a Bone Chain Simulation

The minimal setup requires a system root and at least one chain. Each chain is defined by `start` and `end`, where `end` must be a descendant of `start`.

```javascript
import { InterpolatorScalar, Vector3 } from '@zephyr3d/base';
import { JointDynamicsSystem } from '@zephyr3d/scene';

const jointDynamics = new JointDynamicsSystem({
  chainConfig: {
    systemRoot: model,
    chains: [
      { start: hairRoot, end: hairTip },
      { start: ribbonRoot, end: ribbonTip }
    ]
  },
  controllerConfig: {
    gravity: new Vector3(0, -9.8, 0),
    subSteps: 3,
    relaxation: 3,
    curves: {
      resistance: InterpolatorScalar.constant(0.92),
      hardness: InterpolatorScalar.constant(0.04),
      pointRadius: InterpolatorScalar.constant(0.03)
    },
    constraintOptions: {
      structuralVertical: true,
      bendingVertical: true
    }
  }
});
```

For manual updates, call this in the main loop:

```javascript
jointDynamics.update(deltaTime);
```

If you use `JointDynamicsModifier`, do not call `update()` manually. The modifier updates the simulation after the skeleton animation step:

```javascript
import { JointDynamicsModifier } from '@zephyr3d/scene';

const modifier = new JointDynamicsModifier(jointDynamics);
const rig = model.animationSet.rigs[0].get();
if (rig) {
  rig.modifiers.push(modifier);
}
```

`modifier.weight = 1` means full dynamics, and `modifier.weight = 0` means original animation only. The lower-level `controller.blendRatio` has the opposite meaning: `0` is full physics, and `1` is full animation.

---

## Controller Parameters

`controllerConfig` is optional. Missing fields use default values.

| Parameter | Description |
|-----------|-------------|
| `gravity` | World-space gravity |
| `windForce` | World-space wind force |
| `subSteps` | Simulation substeps per frame; higher is more stable but slower |
| `relaxation` | Constraint iterations per substep |
| `rootSlideLimit` | Maximum system-local root movement left as relative physics lag after large root motion; `-1` disables compensation |
| `blendRatio` | Blend from physics to animation; `0` is full physics, `1` is full animation |
| `enableBroadPhase` | Enables broad-phase pruning for collision tests |
| `enableSurfaceCollision` | Enables surface/triangle collision |
| `preserveTwist` | Preserves initial axial twist when writing rotations back |
| `angleLimitConfig` | Post-simulation bone angle limits |
| `curves` | Depth-based physics curves |
| `constraintOptions` | Selects structural, shear, and bending constraints to generate |

Curves are sampled by chain depth: root is `0`, tip is `1`. Common curves include:

| Curve | Description |
|-------|-------------|
| `resistance` | Velocity preservation. Higher values mean less damping |
| `hardness` | Stiffness that pulls points back toward the animated pose |
| `pointRadius` | Collision radius for each dynamic point |
| `gravityScale` | Gravity scale |
| `windForceScale` | Wind scale |
| `friction` | Collision friction scale |
| `structuralShrinkVertical` / `structuralStretchVertical` | Parent-child structural constraint strength |
| `bendingShrinkVertical` / `bendingStretchVertical` | Skip-one-bone bending constraint strength |

You can update configuration at runtime:

```javascript
jointDynamics.controller.updateConfig({
  windForce: new Vector3(20, 0, 0),
  curves: {
    hardness: InterpolatorScalar.constant(0.15)
  }
});
```

---

## Colliders, Planes, and Grabbers

Colliders can be passed to the constructor or added at runtime.

```javascript
const headCollider = jointDynamics.addSphereCollider(
  0.12,
  headNode,
  0.4
);

const bodyCollider = jointDynamics.addCapsuleCollider(
  0.18,
  0.8,
  bodyNode,
  1,
  0.2
);

const floor = jointDynamics.addFlatPlane(
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 0)
);
```

`addSphereCollider()` and `addCapsuleCollider()` return stable handles that can be used to enable, disable, or remove runtime colliders:

```javascript
jointDynamics.setColliderEnabled(headCollider, false);
jointDynamics.removeCollider(bodyCollider);
jointDynamics.setFlatPlaneEnabled(floor, true);
```

Grabbers are useful for mouse dragging and interaction forces:

```javascript
const grabber = jointDynamics.addGrabber(
  { radius: 0.25, force: 0.5 },
  grabberNode
);

jointDynamics.setGrabberEnabled(grabber, true);
grabberNode.position.setXYZ(0, 1.2, 0.4);

// Disable the grabber when released.
jointDynamics.setGrabberEnabled(grabber, false);
```

---

## Fixed Points, Reset, and Teleporting

The first point of each chain is fixed to the animated pose. You can release or re-fix points at runtime:

```javascript
const controller = jointDynamics.controller;

controller.releasePoint(0);
controller.fixPoint(0);
controller.isPointFixed(0);
```

After teleporting a character, switching scenes, or resetting a pose, call:

```javascript
jointDynamics.resetChains();
controller.reset();
```

`reset()` clears simulation history and root-motion compensation so teleportation does not create a large inertial impulse on the next frame. `warp()` is kept as a deprecated alias for `reset()`.

For large root motion where you still want some follow-through, set `rootSlideLimit` instead. For example, `rootSlideLimit: 10` means a 500-unit teleport leaves at most 10 local units of relative physics lag; the remaining root motion is applied directly to the simulation state.

You can also fade dynamics in or out:

```javascript
controller.fadeIn(0.3);
controller.fadeOut(0.3);
```

---

## Loading Joint Dynamics from Models

The resource loader imports model-provided Joint Dynamics data by default and creates `JointDynamicsModifier` instances for matching skeleton rigs. This option applies to model loading, such as glTF or VRM assets that contain VRM SpringBone / Joint Dynamics extension data:

```javascript
const model = await getEngine().resourceManager.fetchModel(
  '/assets/character.vrm',
  scene,
  {
    loadJointDynamics: true
  }
);

model.parent = scene.rootNode;
```

To skip model-provided Joint Dynamics, set:

```javascript
{ loadJointDynamics: false }
```

For `.zprefab` assets, serialized Joint Dynamics modifiers are restored as prefab content and are not controlled by the `loadJointDynamics` model-loading option.

---

## Example

The example below includes a bone chain, cloth grid, skirt, closed chain, colliders, grabbers, wind, and a broad-phase toggle.

<div class="showcase" case="tut-52"></div>

---

## Notes

- For each chain, `end` must be a descendant of `start`.
- Use either manual `update()` or `JointDynamicsModifier` auto-updates, not both for the same system.
- Large `deltaTime` values are internally clamped to about a 30 FPS step; increase `subSteps` if frame time is unstable.
- Collider transforms are read from their bound `SceneNode` every frame, so colliders can follow character bones or ordinary scene nodes.
- `fixPoint()` and `releasePoint()` use internal point indices ordered by the chain nodes collected during construction.
