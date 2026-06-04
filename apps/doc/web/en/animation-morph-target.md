# Morph Target / BlendShape

Morph targets, also called blend shapes, deform a mesh by blending vertex deltas. They are commonly used for facial expressions, lip sync, muscle bulges, corrective shapes, and other local deformations that are difficult to control with bones alone.

The mesh topology does not change. Each target stores offsets for the same vertices as the base mesh, and the final vertex data is calculated from the current target weights on the GPU.

---

## Main Classes

| Class / Function | Purpose |
|------------------|---------|
| `Mesh` | Owns morph target data and per-target weights |
| `SceneNode` | Provides subtree-level morph target and expression helpers |
| `SceneMorphTargetGroup` | Runtime expression/group binding for one model instance |
| `AssetMorphTargetGroup` | Model-level expression/group data, usually imported from VRM |
| `MorphTargetTrack` | Animation track for glTF `weights` channels |

---

## Loading Morph Targets

Morph target data is imported automatically from glTF / GLB models that contain primitive `targets`.

```javascript
const model = await getEngine().resourceManager.fetchModel(
  '/assets/character.glb',
  scene
);

model.parent = scene.rootNode;
```

The loader also reads initial weights from glTF mesh `weights` and node `weights`. Target names are read from `extras.targetNames`; if a target has no name, Zephyr3D uses `Target0`, `Target1`, and so on.

You can inspect the imported targets from the model root:

```javascript
const targetNames = model.collectMorphTargetNames();
const groupNames = model.collectMorphTargetGroupNames();

console.log(targetNames);
console.log(groupNames);
```

For VRM models, VRM 0.x BlendShape groups and VRM 1.0 expressions are imported as morph target groups. Typical group names include expression names such as `happy`, `angry`, `blink`, or phoneme names such as `aa`.

Morph target data can also be restored automatically when instantiating a Zephyr3D prefab:

```javascript
const model = await getEngine().resourceManager.instantiatePrefab(
  scene.rootNode,
  '/assets/character.zprefab'
);
```

For `.zprefab` assets, serialized morph target data, target names, current weights, bounding data, and morph target groups are restored as prefab content. This is different from direct model loading: model assets import morph targets from the source file, but model Morph Target settings are not serialized as model asset data. If you need to persist edited Morph Target settings, save the result as a prefab.

---

## Setting Target Weights

If you want to drive every mesh target with the same name under a model, use `SceneNode.setMorphTargetWeight()`:

```javascript
model.setMorphTargetWeight('Smile', 0.8);
model.setMorphTargetWeight('Blink_L', 1);
```

If you already have a specific mesh node, you can control its targets directly:

```javascript
if (faceMesh.isMesh()) {
  const smileIndex = faceMesh.getMorphTargetIndexByName('Smile');

  if (smileIndex >= 0) {
    faceMesh.setMorphWeightByIndex(smileIndex, 0.75);
  }

  faceMesh.setMorphWeight('Blink_L', 1);
  const currentSmile = faceMesh.getMorphWeight('Smile');
}
```

For setting several weights on the same mesh at once, use `updateMorphWeights()`:

```javascript
if (faceMesh.isMesh()) {
  faceMesh.updateMorphWeights([
    0.8, // Target0
    0.0, // Target1
    1.0  // Target2
  ]);
}
```

The array length must not exceed the mesh's morph target count.

---

## Morph Target Groups

Morph target groups are useful when a single expression needs to affect several mesh targets, possibly across multiple meshes. For example, a `happy` expression can drive mouth, cheek, and eye targets together.

Imported VRM expressions are available through the model root:

```javascript
const expressions = model.collectMorphTargetGroupNames();

model.setMorphTargetGroupWeight('happy', 1);
model.setMorphTargetGroupWeight('blink', 0);
```

`setMorphTargetGroupWeight()` first looks for a runtime or model-level group. If no group with that name exists, it falls back to `setMorphTargetWeight()` and applies the weight to mesh targets with the same name.

You can also create a runtime group manually:

```javascript
model.morphTargetGroups = [
  {
    name: 'smileLeft',
    bindings: [
      {
        mesh: faceMesh,
        targetName: 'Smile_L',
        weight: 1
      },
      {
        mesh: faceMesh,
        targetName: 'Cheek_L',
        weight: 0.5
      }
    ],
    weight: 0
  }
];

model.setMorphTargetGroupWeight('smileLeft', 0.6);
```

For binary groups, set `isBinary: true`. Their weights are resolved to `0` or `1` using `0.5` as the threshold.

---

## Morph Target Animation

glTF animation channels with target path `weights` are converted to `MorphTargetTrack` automatically. You can play them through the model's `animationSet` just like skeletal or keyframe animation:

```javascript
const animationNames = model.animationSet.getAnimationNames();

if (animationNames.length > 0) {
  model.animationSet.playAnimation(animationNames[0], {
    repeat: 0
  });
}
```

`MorphTargetTrack` animates all morph weights for one mesh at a time and participates in the normal animation blending system.

---

## Materials and Rendering

Standard mesh materials handle morph target position, normal, and tangent deltas automatically. Custom materials based on `MeshMaterial` also receive the common skinning and morphing setup in the base vertex shader flow.

If a custom vertex shader bypasses the common helpers, use `ShaderHelper.hasMorphing()` and `ShaderHelper.calculateMorphDelta()` to apply the required morph attributes yourself.

---

## Notes

- A mesh can contain up to `256` morph targets.
- glTF morph attributes supported by the importer include `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD_0` to `TEXCOORD_3`, and `COLOR_0`.
- Target names are per mesh. Use `collectMorphTargetNames()` when you are not sure which names were imported.
- Directly loaded model assets do not serialize Morph Target settings. Use `.zprefab` if the current target weights, group bindings, or imported target data need to be saved and restored later.
- Weight values are not clamped by `setMorphWeight()` or `setMorphTargetGroupWeight()`. Most expression workflows use the `[0, 1]` range, but corrective or exaggerated shapes can use values outside that range if the asset is authored for it.
- Morph targets can be combined with skeletal animation. Skinning and morphing are both applied by the mesh material pipeline.
