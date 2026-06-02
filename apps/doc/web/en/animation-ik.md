# Inverse Kinematics (IK)

IK (Inverse Kinematics) solves joint rotations from an end-effector target. Typical uses include keeping a character hand on a handle, placing feet on the ground, or making a robotic arm reach a moving point.

Zephyr3D IK runs after skeletal animation. The base animation updates the joints first, then IK works as a `SkeletonModifier` and writes the corrected transforms back to the joint nodes.

---

## Main Classes

| Class | Purpose |
|-------|---------|
| `IKChain` | Describes a joint chain from root to end effector |
| `TwoBoneIKSolver` | Analytical solver for two-bone limbs such as arms and legs |
| `FABRIKSolver` | Iterative solver suitable for longer chains with stable length preservation |
| `CCDSolver` | Cyclic Coordinate Descent solver suitable for tails, tentacles, and mechanical chains |
| `IKAngleConstraint` | Limits the bend angle of a joint |
| `IKModifier` | Integrates an IK solver into the skeleton modifier pipeline |

---

## Creating an IK Chain

You can pass nodes from root to end effector manually, or build the chain from a parent-child hierarchy.

```javascript
import { IKChain } from '@zephyr3d/scene';

// endNode must be a descendant of startNode.
const chain = IKChain.fromNodeHierarchy(startNode, endNode);

// Or specify the order manually: root -> ... -> end effector
const chain2 = new IKChain([shoulder, elbow, wrist]);
```

`IKChain` stores each joint's world position, original rotation, and bone length. Create the chain after the node hierarchy and initial pose are ready.

---

## Using TwoBoneIKSolver

`TwoBoneIKSolver` requires exactly 3 joints, meaning 2 bones. It is the preferred solver for arms and legs.

```javascript
import { Vector3 } from '@zephyr3d/base';
import {
  IKChain,
  IKModifier,
  TwoBoneIKSolver
} from '@zephyr3d/scene';

const chain = IKChain.fromNodeHierarchy(upperArm, hand);

// poleVector is a world-space point that controls the bend direction.
const solver = new TwoBoneIKSolver(chain, new Vector3(0, 0, 1), 1);
const target = new Vector3(0.4, 1.2, 0.2);
const ikModifier = new IKModifier(solver, target, 1);

// Attach IK to the model's skeleton rig. Imported models usually expose rigs through animationSet.rigs.
const rig = model.animationSet.rigs[0].get();
if (rig) {
  rig.modifiers.push(ikModifier);
}
```

If the target moves every frame, update the modifier target:

```javascript
ikModifier.setTarget(targetNode.getWorldPosition());
```

`IKModifier.weight` is in the `[0, 1]` range. `0` keeps the original animation, and `1` applies the full IK result.

---

## Choosing a Solver

| Solver | Best for | Notes |
|--------|----------|-------|
| `TwoBoneIKSolver` | Arms and legs | Analytical, fast, stable, but only supports 3 joints |
| `FABRIKSolver` | Multi-bone arms, spines, longer chains | Preserves bone lengths well, often needs more iterations |
| `CCDSolver` | Tails, tentacles, chains | Fast and simple, works well for flexible multi-joint chains |

```javascript
import { CCDSolver, FABRIKSolver, IKChain } from '@zephyr3d/scene';

const chain = IKChain.fromNodeHierarchy(chainRoot, chainEnd);

// maxIterations and tolerance control iteration count and convergence distance.
const fabrik = new FABRIKSolver(chain, 15, 0.001);
const ccd = new CCDSolver(chain, 10, 0.001);
```

Both `FABRIKSolver` and `CCDSolver` support pole vectors per joint:

```javascript
// jointIndex is the index in the IK chain. 0 is the root joint.
solver.setPoleVector(1, poleTarget.getWorldPosition(), 1);
```

---

## Joint Constraints

Use `IKAngleConstraint` to limit a joint's bend angle. The angle unit is degrees.

```javascript
import { IKAngleConstraint } from '@zephyr3d/scene';

// Limit joint 1 to a bend angle between 10 and 160 degrees.
chain.addConstraint(new IKAngleConstraint(1, 10, 160));
```

Solvers also expose twist constraints for limiting axial rotation. These angles are in radians:

```javascript
solver.setTwistConstraint(0, -Math.PI * 0.25, Math.PI * 0.25, 0.3);
```

---

## Manual Solving

If you do not want to use a skeleton modifier, call the solver from your own update code:

```javascript
const ok = solver.solve(targetNode.getWorldPosition());
solver.applyToNodes(1);
```

`solve()` returns whether the chain converged within tolerance. Even when it returns `false`, the solver still moves the end effector as close to the target as possible.

---

## Notes

- `IKChain.fromNodeHierarchy(start, end)` requires `end` to be a descendant of `start`.
- `TwoBoneIKSolver` only accepts 3 joints. Use `FABRIKSolver` or `CCDSolver` for longer chains.
- Targets and pole vectors are world-space positions.
- IK is usually applied after regular skeletal animation to correct hands, feet, or end effectors.
- After teleporting a character or switching to a very different pose, recreate the related chain / solver to avoid stale twist-continuity state.
