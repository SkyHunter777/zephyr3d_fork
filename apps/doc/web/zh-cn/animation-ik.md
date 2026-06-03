# IK（反向运动学）

IK（Inverse Kinematics，反向运动学）用于通过末端目标反推骨骼链的旋转。例如让角色的手贴住门把手、脚踩在地面、机械臂末端追踪目标等。

Zephyr3D 的 IK 系统工作在骨骼动画之后。基础动画先更新关节姿态，IK 再作为 `SkeletonModifier` 对指定骨骼链做后处理，并把结果写回关节节点。

---

## 主要类

| 类 | 作用 |
|----|------|
| `IKChain` | 描述从根关节到末端关节的一条 IK 链 |
| `TwoBoneIKSolver` | 两段骨骼的解析求解器，适合手臂、腿部 |
| `FABRIKSolver` | 迭代式求解器，适合较长且需要稳定长度约束的链 |
| `CCDSolver` | 循环坐标下降求解器，适合尾巴、触手、机械链等多关节链 |
| `IKAngleConstraint` | 限制某个关节的弯曲角度 |
| `IKModifier` | 把 IK 求解器接入骨骼后处理流程 |

---

## 创建 IK 链

可以直接传入从根到末端的节点数组，也可以从父子层级自动收集。

```javascript
import { IKChain } from '@zephyr3d/scene';

// endNode 必须是 startNode 的子孙节点。
const chain = IKChain.fromNodeHierarchy(startNode, endNode);

// 或者手工指定顺序：root -> ... -> end effector
const chain2 = new IKChain([shoulder, elbow, wrist]);
```

`IKChain` 会记录每个关节的世界坐标、初始旋转和骨骼长度。创建链之前应确保节点层级和初始姿态已经设置好。

---

## 使用 TwoBoneIKSolver

`TwoBoneIKSolver` 要求链中正好有 3 个关节，也就是 2 段骨骼，常用于手臂和腿。

```javascript
import { Vector3 } from '@zephyr3d/base';
import {
  IKChain,
  IKModifier,
  TwoBoneIKSolver
} from '@zephyr3d/scene';

const chain = IKChain.fromNodeHierarchy(upperArm, hand);

// poleVector 是世界空间中的弯曲方向控制点。
const solver = new TwoBoneIKSolver(chain, new Vector3(0, 0, 1), 1);
const target = new Vector3(0.4, 1.2, 0.2);
const ikModifier = new IKModifier(solver, target, 1);

// 把 IK 接入模型的骨骼 rig。通常导入模型后 animationSet.rigs 中会包含 rig。
const rig = model.animationSet.rigs[0].get();
if (rig) {
  rig.modifiers.push(ikModifier);
}
```

如果目标点每帧移动，只需要更新 modifier 的目标：

```javascript
ikModifier.setTarget(targetNode.getWorldPosition());
```

`IKModifier` 的 `weight` 取值范围为 `[0, 1]`。`0` 表示只保留原动画，`1` 表示完全应用 IK。

---

## 选择求解器

| 求解器 | 适合场景 | 特点 |
|--------|----------|------|
| `TwoBoneIKSolver` | 手臂、腿部 | 解析求解，速度快，姿态稳定，但只支持 3 个关节 |
| `FABRIKSolver` | 多段机械臂、脊柱、长骨骼链 | 对骨长保持较稳定，迭代次数通常略高 |
| `CCDSolver` | 尾巴、触手、链条 | 实现简单，速度较快，适合多关节柔性链 |

```javascript
import { CCDSolver, FABRIKSolver, IKChain } from '@zephyr3d/scene';

const chain = IKChain.fromNodeHierarchy(chainRoot, chainEnd);

// maxIterations 和 tolerance 控制迭代上限与收敛距离。
const fabrik = new FABRIKSolver(chain, 15, 0.001);
const ccd = new CCDSolver(chain, 10, 0.001);
```

`FABRIKSolver` 和 `CCDSolver` 都支持为指定关节设置 pole vector：

```javascript
// jointIndex 是 IK 链中的关节索引，0 表示根关节。
solver.setPoleVector(1, poleTarget.getWorldPosition(), 1);
```

---

## 关节约束

可以使用 `IKAngleConstraint` 限制某个关节的弯曲范围，角度单位是度。

```javascript
import { IKAngleConstraint } from '@zephyr3d/scene';

// 限制第 1 个关节的弯曲角度在 10 到 160 度之间。
chain.addConstraint(new IKAngleConstraint(1, 10, 160));
```

求解器也提供 twist 约束，用于限制骨骼轴向扭转，角度单位是弧度：

```javascript
solver.setTwistConstraint(0, -Math.PI * 0.25, Math.PI * 0.25, 0.3);
```

---

## 手动求解

如果不需要接入骨骼 modifier，也可以在自己的更新逻辑里手动调用：

```javascript
const ok = solver.solve(targetNode.getWorldPosition());
solver.applyToNodes(1);
```

`solve()` 返回是否在容差内收敛。即使返回 `false`，求解器也会尽量把末端拉向目标点。

<div class="showcase" case="tut-53"></div>

---

## 注意事项

- `IKChain.fromNodeHierarchy(start, end)` 要求 `end` 是 `start` 的子孙节点。
- `TwoBoneIKSolver` 只接受 3 个关节，超过 3 个关节请使用 `FABRIKSolver` 或 `CCDSolver`。
- target、pole vector 都使用世界空间坐标。
- IK 通常放在普通骨骼动画之后，用于修正手、脚或末端执行器的位置。
- 如果角色发生瞬移或切换到差异很大的姿态，建议重新创建相关 chain / solver，避免上一帧 twist 连续性状态影响当前求解。
