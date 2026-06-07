# JointDynamics

JointDynamics 用于给骨骼链添加弹性、惯性和碰撞反馈，适合头发、尾巴、飘带、裙摆、布料网格、挂件等二级运动。

系统会从一组场景节点骨骼链生成物理点和约束，使用 Verlet 积分推进模拟，再把结果写回关节节点的位置和旋转。它既可以独立手动更新，也可以通过 `JointDynamicsModifier` 接入骨骼后处理流程。

---

## 主要类

| 类 / 函数 | 作用 |
|-----------|------|
| `JointDynamicsSystem` | 高层封装，负责根据骨骼链创建模拟系统 |
| `JointDynamicsSystemController` | 底层控制器，提供运行时参数、碰撞体、抓取器、固定点等接口 |
| `JointDynamicsModifier` | 把 `JointDynamicsSystem` 接入骨骼 modifier 流程 |
| `createTransformAccess()` | 把 `SceneNode` 包装为求解器可读写的 transform 适配器 |

---

## 创建骨骼链模拟

最小配置需要一个系统根节点和至少一条骨骼链。每条链由 `start` 和 `end` 指定，`end` 必须是 `start` 的子孙节点。

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

手动更新时，在主循环里调用：

```javascript
jointDynamics.update(deltaTime);
```

如果使用 `JointDynamicsModifier`，不要再手动调用 `update()`，modifier 会在骨骼更新后自动推进模拟：

```javascript
import { JointDynamicsModifier } from '@zephyr3d/scene';

const modifier = new JointDynamicsModifier(jointDynamics);
const rig = model.animationSet.rigs[0].get();
if (rig) {
  rig.modifiers.push(modifier);
}
```

`modifier.weight = 1` 表示完全应用动态模拟，`modifier.weight = 0` 表示回到原动画。底层 `controller.blendRatio` 的含义相反：`0` 为完整物理，`1` 为完整动画。

---

## 控制器参数

`controllerConfig` 是可选项，未填写的字段会使用默认值。

| 参数 | 说明 |
|------|------|
| `gravity` | 世界空间重力 |
| `windForce` | 世界空间风力 |
| `subSteps` | 每帧子步数，越大越稳定但越耗时 |
| `relaxation` | 每个子步的约束迭代次数 |
| `rootSlideLimit` | 大幅根节点运动后最多保留的相对物理滞后距离，单位为系统本地空间；`-1` 表示关闭补偿 |
| `blendRatio` | 物理到动画的混合比，`0` 为完整物理，`1` 为完整动画 |
| `enableBroadPhase` | 是否启用碰撞 broad-phase 剪枝 |
| `enableSurfaceCollision` | 是否启用表面/三角面碰撞 |
| `preserveTwist` | 写回旋转时是否保留初始轴向扭转 |
| `angleLimitConfig` | 后处理骨骼角度限制 |
| `curves` | 按骨骼深度变化的物理曲线 |
| `constraintOptions` | 生成哪些结构、剪切、弯曲约束 |

`curves` 中的曲线会按深度采样：根部为 `0`，末端为 `1`。常用曲线包括：

| 曲线 | 说明 |
|------|------|
| `resistance` | 速度保留比例，越大阻尼越小 |
| `hardness` | 回到动画姿态的刚度 |
| `pointRadius` | 每个动态点参与碰撞的半径 |
| `gravityScale` | 重力缩放 |
| `windForceScale` | 风力缩放 |
| `friction` | 碰撞摩擦缩放 |
| `structuralShrinkVertical` / `structuralStretchVertical` | 父子骨骼结构约束强度 |
| `bendingShrinkVertical` / `bendingStretchVertical` | 隔一段骨骼的弯曲约束强度 |

运行时可局部更新配置：

```javascript
jointDynamics.controller.updateConfig({
  windForce: new Vector3(20, 0, 0),
  curves: {
    hardness: InterpolatorScalar.constant(0.15)
  }
});
```

---

## 碰撞体、平面和抓取器

可以在构造函数中传入碰撞体，也可以运行时添加。

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

`addSphereCollider()` 和 `addCapsuleCollider()` 返回稳定句柄，可以用于启用、禁用或移除：

```javascript
jointDynamics.setColliderEnabled(headCollider, false);
jointDynamics.removeCollider(bodyCollider);
jointDynamics.setFlatPlaneEnabled(floor, true);
```

抓取器用于鼠标拖拽、交互牵引等效果：

```javascript
const grabber = jointDynamics.addGrabber(
  { radius: 0.25, force: 0.5 },
  grabberNode
);

jointDynamics.setGrabberEnabled(grabber, true);
grabberNode.position.setXYZ(0, 1.2, 0.4);

// 释放时关闭抓取器。
jointDynamics.setGrabberEnabled(grabber, false);
```

---

## 固定点、重置和瞬移

控制器会把每条链的第一个点固定到动画姿态。运行时可以释放或重新固定点：

```javascript
const controller = jointDynamics.controller;

controller.releasePoint(0);
controller.fixPoint(0);
controller.isPointFixed(0);
```

当角色瞬移、切换场景或重置姿态时，建议调用：

```javascript
jointDynamics.resetChains();
controller.reset();
```

`reset()` 会清除模拟历史和根运动补偿状态，避免瞬移在下一帧产生很大的惯性冲击。`warp()` 作为 `reset()` 的兼容别名保留，后续会逐渐淘汰。

如果希望大幅根节点位移后仍保留少量惯性，可以设置 `rootSlideLimit`。例如 `rootSlideLimit: 10` 表示 500 单位的瞬移最多留下 10 个本地单位的相对物理滞后，其余根运动会直接应用到模拟状态。

也可以平滑淡入或淡出动态效果：

```javascript
controller.fadeIn(0.3);
controller.fadeOut(0.3);
```

---

## 导入模型中的 JointDynamics

资源加载器默认会导入模型中包含的 JointDynamics 数据，并为匹配的骨骼 rig 创建 `JointDynamicsModifier`。该选项用于模型加载流程，例如包含 VRM SpringBone / JointDynamics 扩展数据的 glTF 或 VRM：

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

如果不希望加载模型自带的 JointDynamics，可设置：

```javascript
{ loadJointDynamics: false }
```

对于 `.zprefab`，JointDynamics modifier 会作为 prefab 序列化内容恢复，不通过 `loadJointDynamics` 开关控制。

---

## 示例

下面的示例包含骨骼链、布料网格、裙摆、闭合链、碰撞体、抓取器、风力和 broad-phase 开关。

<div class="showcase" case="tut-52"></div>

---

## 注意事项

- 每条链的 `end` 必须是 `start` 的子孙节点。
- 手动 `update()` 和 `JointDynamicsModifier` 自动更新二选一，避免同一系统每帧更新两次。
- `deltaTime` 过大时系统会内部钳制到约 30 FPS 步长；帧率不稳定时可提高 `subSteps`。
- 碰撞体 transform 每帧都会从绑定的 `SceneNode` 读取，因此碰撞体可以跟随角色骨骼或普通节点运动。
- `fixPoint()` / `releasePoint()` 使用的是系统内部点索引，顺序按构造时各条链收集节点的顺序排列。
