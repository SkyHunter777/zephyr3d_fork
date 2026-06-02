import { DRef, Disposable, Matrix4x4, guessMimeType } from '@zephyr3d/base';
import type { Nullable } from '@zephyr3d/base';
import { getEngine } from '../app/api';
import type { ModelFetchOptions } from '../asset/assetmanager';
import { SharedModel } from '../asset/model';
import type { SceneNode, SceneNodeVisible } from '../scene/scene_node';
import type { Mesh } from '../scene/mesh';
import type { SkeletonBindPose } from '../animation/skeleton';
import { SkeletonRig, SkinBinding } from '../animation/skeleton';

/** @public */
export type AvatarSlotId = string;

/** @public */
export type AvatarBindMode = 'exact' | 'humanoid' | 'name' | 'custom';

/** @public */
export type AvatarFitMode = 'reuseInverseBind' | 'preserveRestPose';

/** @public */
export type AvatarOutfitSource = string | SceneNode | SharedModel;

/** @public */
export type AvatarBodyRegionTarget = SceneNode | Mesh;

/** @public */
export type AvatarBodyRegions = Record<string, AvatarBodyRegionTarget[]>;

/** @public */
export type AvatarJointMap =
  | Record<string, string>
  | ((sourceJoint: SceneNode, targetRig: SkeletonRig, sourceRig: SkeletonRig) => Nullable<SceneNode>);

/** @public */
export type AvatarSlotOptions = {
  id: AvatarSlotId;
  hideBodyRegions?: string[];
  exclusiveWith?: AvatarSlotId[];
  allowMultiple?: boolean;
};

/** @public */
export type AvatarWardrobeOptions = {
  root: SceneNode;
  rig?: SkeletonRig | string;
  slots?: AvatarSlotOptions[];
  bodyRegions?: AvatarBodyRegions;
  modelFetchOptions?: ModelFetchOptions;
};

/** @public */
export type AvatarEquipOptions = {
  slot?: AvatarSlotId;
  bindMode?: AvatarBindMode;
  fitMode?: AvatarFitMode;
  jointMap?: AvatarJointMap;
  hideBodyRegions?: string[];
  modelFetchOptions?: ModelFetchOptions;
};

/** @public */
export type AvatarOutfitValidation = {
  ok: boolean;
  meshes: number;
  skinBindings: number;
  mappedJoints: number;
  missingJoints: string[];
  errors: string[];
  warnings: string[];
};

type MeshBindingUse = {
  binding: SkinBinding;
  meshes: Mesh[];
};

let outfitInstanceId = 0;

/**
 * A concrete equipped outfit item.
 *
 * Disposing the instance unequips it from the owning wardrobe.
 *
 * @public
 */
export class AvatarOutfitInstance extends Disposable {
  readonly id: string;
  readonly slot: AvatarSlotId;
  readonly root: DRef<SceneNode>;
  readonly meshes: DRef<Mesh>[];
  readonly skinBindings: SkinBinding[];
  readonly hiddenBodyRegions: string[];
  private _wardrobe: Nullable<AvatarWardrobe>;

  /** @internal */
  constructor(
    wardrobe: AvatarWardrobe,
    slot: AvatarSlotId,
    root: SceneNode,
    meshes: Mesh[],
    skinBindings: SkinBinding[],
    hiddenBodyRegions: string[]
  ) {
    super();
    this.id = `outfit-${++outfitInstanceId}`;
    this.slot = slot;
    this.root = new DRef(root);
    this.meshes = meshes.map((mesh) => new DRef(mesh));
    this.skinBindings = skinBindings;
    this.hiddenBodyRegions = hiddenBodyRegions;
    this._wardrobe = wardrobe;
  }

  protected onDispose() {
    this._wardrobe?._releaseInstance(this);
    this._wardrobe = null;
    for (const meshRef of this.meshes) {
      meshRef.dispose();
    }
    this.meshes.length = 0;
  }
}

/**
 * High level avatar outfit controller.
 *
 * The wardrobe keeps one avatar {@link SkeletonRig} as the animation source and
 * binds equipped clothing meshes to that rig with new {@link SkinBinding}s.
 *
 * @public
 */
export class AvatarWardrobe extends Disposable {
  private readonly _root: SceneNode;
  private readonly _rig: SkeletonRig;
  private readonly _slots: Map<AvatarSlotId, AvatarSlotOptions>;
  private readonly _bodyRegions: Map<string, SceneNode[]>;
  private readonly _equipped: Map<AvatarSlotId, AvatarOutfitInstance[]>;
  private readonly _hiddenBodyNodeCounts: Map<SceneNode, number>;
  private readonly _bodyNodeOriginalState: Map<SceneNode, SceneNodeVisible>;
  private readonly _modelFetchOptions: ModelFetchOptions;

  constructor(options: AvatarWardrobeOptions) {
    super();
    this._root = options.root;
    this._rig = this.resolveTargetRig(options.root, options.rig);
    this._slots = new Map();
    this._bodyRegions = new Map();
    this._equipped = new Map();
    this._hiddenBodyNodeCounts = new Map();
    this._bodyNodeOriginalState = new Map();
    this._modelFetchOptions = options.modelFetchOptions ?? {};
    for (const slot of options.slots ?? []) {
      this._slots.set(slot.id, { ...slot });
    }
    for (const [name, nodes] of Object.entries(options.bodyRegions ?? {})) {
      this._bodyRegions.set(name, this.uniqueNodes(nodes));
    }
    this.ensureRigRegistered();
  }

  static from(root: SceneNode, options?: Omit<AvatarWardrobeOptions, 'root'>): AvatarWardrobe {
    return new AvatarWardrobe({ root, ...(options ?? {}) });
  }

  get root(): SceneNode {
    return this._root;
  }

  get rig(): SkeletonRig {
    return this._rig;
  }

  getEquipped(slot?: AvatarSlotId): AvatarOutfitInstance[] {
    if (slot) {
      return [...(this._equipped.get(slot) ?? [])];
    }
    return [...this._equipped.values()].flatMap((items) => [...items]);
  }

  async equip(
    source: AvatarOutfitSource,
    options?: AvatarEquipOptions
  ): Promise<Nullable<AvatarOutfitInstance>> {
    const slot = options?.slot ?? 'default';
    this.enforceSlotRules(slot);
    const root = await this.resolveSource(source, options);
    if (!root) {
      console.error('AvatarWardrobe.equip(): failed to load outfit source');
      return null;
    }
    if (root === this._root) {
      console.error('AvatarWardrobe.equip(): outfit root cannot be the avatar root');
      return null;
    }
    if (root.scene !== this._root.scene) {
      console.error('AvatarWardrobe.equip(): outfit node must belong to the same scene as the avatar');
      return null;
    }

    const meshUses = this.collectSkinnedMeshes(root);
    if (meshUses.length === 0) {
      console.error('AvatarWardrobe.equip(): outfit does not contain skinned meshes');
      return null;
    }

    const newBindings: SkinBinding[] = [];
    const equippedMeshes: Mesh[] = [];
    const bindMode = options?.bindMode ?? this.chooseBindMode(meshUses[0].binding.rig);
    const fitMode = options?.fitMode ?? (bindMode === 'exact' ? 'reuseInverseBind' : 'preserveRestPose');
    for (const use of meshUses) {
      const targetJoints = use.binding.joints.map((joint) =>
        this.resolveTargetJoint(joint, use.binding.rig, bindMode, options?.jointMap)
      );
      const missing = use.binding.joints
        .filter((_, index) => !targetJoints[index])
        .map((joint) => joint.name);
      if (missing.length > 0) {
        console.error(`AvatarWardrobe.equip(): cannot map outfit joints: ${missing.join(', ')}`);
        return null;
      }
      const mappedJoints = targetJoints as SceneNode[];
      const inverseBindMatrices = this.createInverseBindMatrices(use.binding, mappedJoints, fitMode);
      const binding = new SkinBinding(this._rig, inverseBindMatrices, mappedJoints);
      this._root.animationSet.skeletons.push(new DRef(binding));
      newBindings.push(binding);
      for (const mesh of use.meshes) {
        mesh.skinBindingName = binding.persistentId;
        equippedMeshes.push(mesh);
      }
    }

    this.stripSourceSkinBindings(
      root,
      meshUses.map((use) => use.binding)
    );
    root.parent = this._root;

    const hiddenBodyRegions = this.getHiddenBodyRegions(slot, options);
    this.retainBodyRegions(hiddenBodyRegions);
    const instance = new AvatarOutfitInstance(
      this,
      slot,
      root,
      equippedMeshes,
      newBindings,
      hiddenBodyRegions
    );
    const items = this._equipped.get(slot) ?? [];
    items.push(instance);
    this._equipped.set(slot, items);
    return instance;
  }

  unequip(slotOrInstance: AvatarSlotId | AvatarOutfitInstance): void {
    if (typeof slotOrInstance === 'string') {
      for (const instance of this.getEquipped(slotOrInstance)) {
        instance.dispose();
      }
    } else {
      slotOrInstance.dispose();
    }
  }

  clear(): void {
    for (const instance of this.getEquipped()) {
      instance.dispose();
    }
  }

  validateOutfit(source: SceneNode, options?: AvatarEquipOptions): AvatarOutfitValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const meshUses = this.collectSkinnedMeshes(source);
    const bindMode =
      options?.bindMode ?? (meshUses[0] ? this.chooseBindMode(meshUses[0].binding.rig) : 'name');
    let mappedJoints = 0;
    const missingJoints: string[] = [];
    if (meshUses.length === 0) {
      errors.push('No skinned meshes found');
    }
    for (const use of meshUses) {
      for (const joint of use.binding.joints) {
        if (this.resolveTargetJoint(joint, use.binding.rig, bindMode, options?.jointMap)) {
          mappedJoints++;
        } else {
          missingJoints.push(joint.name);
        }
      }
    }
    if (missingJoints.length > 0) {
      errors.push(`Missing mapped joints: ${missingJoints.join(', ')}`);
    }
    const unknownRegions = this.getHiddenBodyRegions(options?.slot ?? 'default', options).filter(
      (region) => !this._bodyRegions.has(region)
    );
    if (unknownRegions.length > 0) {
      warnings.push(`Unknown body regions: ${unknownRegions.join(', ')}`);
    }
    return {
      ok: errors.length === 0,
      meshes: meshUses.reduce((sum, use) => sum + use.meshes.length, 0),
      skinBindings: meshUses.length,
      mappedJoints,
      missingJoints,
      errors,
      warnings
    };
  }

  /** @internal */
  _releaseInstance(instance: AvatarOutfitInstance): void {
    const items = this._equipped.get(instance.slot);
    if (!items || !items.includes(instance)) {
      return;
    }
    const index = items.indexOf(instance);
    items.splice(index, 1);
    if (items.length === 0) {
      this._equipped.delete(instance.slot);
    }
    for (const meshRef of instance.meshes) {
      const mesh = meshRef.get()!;
      if (instance.skinBindings.some((binding) => binding.persistentId === mesh.skinBindingName)) {
        mesh.skinBindingName = '';
      }
    }
    for (const binding of instance.skinBindings) {
      this.removeSkinBinding(binding);
    }
    this.releaseBodyRegions(instance.hiddenBodyRegions);
    instance.root.get()?.remove();
    instance.root.dispose();
  }

  protected onDispose() {
    this.clear();
  }

  private resolveTargetRig(root: SceneNode, rig: SkeletonRig | string | undefined): SkeletonRig {
    if (rig instanceof SkeletonRig) {
      return rig;
    }
    if (typeof rig === 'string') {
      const found = root.findSkeletonRigById(rig);
      if (!found) {
        throw new Error(`AvatarWardrobe: rig '${rig}' was not found under avatar root`);
      }
      return found;
    }
    const animationSet = root.animationSet;
    const registeredRig = animationSet.rigs
      .map((ref) => ref.get())
      .find((item): item is SkeletonRig => !!item);
    if (registeredRig) {
      return registeredRig;
    }
    const bindingRig = animationSet.skeletons
      .map((ref) => ref.get()?.rig)
      .find((item): item is SkeletonRig => !!item);
    if (bindingRig) {
      return bindingRig;
    }
    throw new Error('AvatarWardrobe: avatar root does not have a skeleton rig');
  }

  private ensureRigRegistered(): void {
    if (!this._root.animationSet.rigs.some((ref) => ref.get() === this._rig)) {
      this._root.animationSet.rigs.push(new DRef(this._rig));
    }
  }

  private enforceSlotRules(slot: AvatarSlotId): void {
    const slotOptions = this._slots.get(slot);
    if (!slotOptions?.allowMultiple) {
      this.unequip(slot);
    }
    for (const other of slotOptions?.exclusiveWith ?? []) {
      this.unequip(other);
    }
    for (const [otherSlot, options] of this._slots) {
      if (otherSlot !== slot && options.exclusiveWith?.includes(slot)) {
        this.unequip(otherSlot);
      }
    }
  }

  private async resolveSource(
    source: AvatarOutfitSource,
    options?: AvatarEquipOptions
  ): Promise<Nullable<SceneNode>> {
    const resourceManager = getEngine().resourceManager;
    if (typeof source === 'string') {
      const scene = this._root.scene!;
      const root =
        guessMimeType(source) === 'application/vnd.zephyr3d.prefab+json'
          ? await resourceManager.instantiatePrefab(scene.rootNode, source)
          : await resourceManager.fetchModel(source, scene, {
              loadAnimations: false,
              loadMeshes: true,
              loadSkeletons: true,
              loadJointDynamics: false,
              ...this._modelFetchOptions,
              ...(options?.modelFetchOptions ?? {})
            });
      if (!root) {
        console.error(`AvatarWardrobe.equip(): failed to load outfit '${source}'`);
        return null;
      }
      return root;
    }
    if (source instanceof SharedModel) {
      const scene = this._root.scene!;
      const root = await source.createSceneNode(
        resourceManager,
        scene,
        false,
        true,
        true,
        false,
        false,
        resourceManager.VFS
      );
      return root;
    }
    return source;
  }

  private collectSkinnedMeshes(root: SceneNode): MeshBindingUse[] {
    const bindings = root.animationSet.skeletons
      .map((ref) => ref.get())
      .filter((item): item is SkinBinding => !!item);
    if (bindings.length === 0) {
      return [];
    }
    const meshUses = new Map<SkinBinding, Mesh[]>();
    root.iterate((node) => {
      if (!node.isMesh()) {
        return false;
      }
      const mesh = node as Mesh;
      const binding =
        bindings.find((item) => item.persistentId === mesh.skinBindingName) ??
        (bindings.length === 1 && mesh.skinBindingName ? bindings[0] : null);
      if (binding) {
        const meshes = meshUses.get(binding) ?? [];
        meshes.push(mesh);
        meshUses.set(binding, meshes);
      }
      return false;
    });
    return [...meshUses.entries()].map(([binding, meshes]) => ({ binding, meshes }));
  }

  private chooseBindMode(sourceRig: SkeletonRig): AvatarBindMode {
    return sourceRig.humanoidJointMapping && this._rig.humanoidJointMapping ? 'humanoid' : 'name';
  }

  private resolveTargetJoint(
    sourceJoint: SceneNode,
    sourceRig: SkeletonRig,
    bindMode: AvatarBindMode,
    jointMap?: AvatarJointMap
  ): Nullable<SceneNode> {
    if (bindMode === 'custom') {
      if (typeof jointMap === 'function') {
        const mapped = jointMap(sourceJoint, this._rig, sourceRig);
        return mapped && this._rig.joints.includes(mapped) ? mapped : null;
      }
      if (jointMap) {
        return this.findTargetJointByName(jointMap[sourceJoint.name]);
      }
      return null;
    }
    if (bindMode === 'humanoid') {
      const mapped = this.resolveHumanoidTargetJoint(sourceJoint, sourceRig);
      if (mapped) {
        return mapped;
      }
    }
    return this.findTargetJointByName(sourceJoint.name);
  }

  private resolveHumanoidTargetJoint(sourceJoint: SceneNode, sourceRig: SkeletonRig): Nullable<SceneNode> {
    const src = sourceRig.humanoidJointMapping;
    const dst = this._rig.humanoidJointMapping;
    if (!src || !dst) {
      return null;
    }
    return (
      this.findHumanoidMappedJoint(sourceJoint, src.body, dst.body) ??
      (src.leftHand && dst.leftHand
        ? this.findHumanoidMappedJoint(sourceJoint, src.leftHand, dst.leftHand)
        : null) ??
      (src.rightHand && dst.rightHand
        ? this.findHumanoidMappedJoint(sourceJoint, src.rightHand, dst.rightHand)
        : null)
    );
  }

  private findHumanoidMappedJoint<T extends string>(
    sourceJoint: SceneNode,
    sourceMap: Record<T, SceneNode>,
    targetMap: Record<T, SceneNode>
  ): Nullable<SceneNode> {
    for (const key of Object.keys(sourceMap) as T[]) {
      if (sourceMap[key] === sourceJoint) {
        const target = targetMap[key];
        return target && this._rig.joints.includes(target) ? target : null;
      }
    }
    return null;
  }

  private findTargetJointByName(name: string | undefined): Nullable<SceneNode> {
    return name ? (this._rig.joints.find((joint) => joint.name === name) ?? null) : null;
  }

  private createInverseBindMatrices(
    sourceBinding: SkinBinding,
    targetJoints: SceneNode[],
    fitMode: AvatarFitMode
  ): Matrix4x4[] {
    if (fitMode === 'reuseInverseBind') {
      return sourceBinding.inverseBindMatrices.map((matrix) => new Matrix4x4(matrix));
    }
    const sourceBindWorld = this.computeBindWorldMatrices(sourceBinding.rig);
    const targetBindWorld = this.computeBindWorldMatrices(this._rig);
    return sourceBinding.inverseBindMatrices.map((sourceInverseBind, index) => {
      const sourceJointBind =
        sourceBindWorld.get(sourceBinding.joints[index]) ?? sourceBinding.joints[index].worldMatrix;
      const targetJointBind = targetBindWorld.get(targetJoints[index]) ?? targetJoints[index].worldMatrix;
      const sourceFinalBind = Matrix4x4.multiply(sourceJointBind, sourceInverseBind);
      return Matrix4x4.multiply(Matrix4x4.invertAffine(targetJointBind), sourceFinalBind);
    });
  }

  private computeBindWorldMatrices(rig: SkeletonRig): Map<SceneNode, Matrix4x4> {
    const cache = new Map<SceneNode, Matrix4x4>();
    const jointSet = new Set(rig.joints);
    const compute = (node: SceneNode): Matrix4x4 => {
      const cached = cache.get(node);
      if (cached) {
        return cached;
      }
      const bindPose = this.getRigNodeBindPose(rig, node);
      const local = Matrix4x4.compose(bindPose.scale, bindPose.rotation, bindPose.position);
      const parent = node.parent;
      const world =
        parent && (jointSet.has(parent) || parent === rig.rootJoint)
          ? Matrix4x4.multiply(compute(parent), local)
          : parent
            ? Matrix4x4.multiply(parent.worldMatrix, local)
            : local;
      cache.set(node, world);
      return world;
    };
    for (const joint of rig.joints) {
      compute(joint);
    }
    if (rig.rootJoint) {
      compute(rig.rootJoint);
    }
    return cache;
  }

  private getRigNodeBindPose(rig: SkeletonRig, node: SceneNode): SkeletonBindPose {
    return (
      rig.getBindPoseForJoint(node) ??
      (node === rig.rootJoint
        ? rig.rootBindPose
        : {
            position: node.position,
            rotation: node.rotation,
            scale: node.scale
          })
    );
  }

  private stripSourceSkinBindings(sourceRoot: SceneNode, sourceBindings: SkinBinding[]): void {
    const sourceBindingSet = new Set(sourceBindings);
    const sourceRigSet = new Set(sourceBindings.map((binding) => binding.rig));
    this.removeRefs(sourceRoot.animationSet.skeletons, (binding) => sourceBindingSet.has(binding));
    this.removeRefs(sourceRoot.animationSet.rigs, (rig) => rig !== this._rig && sourceRigSet.has(rig));
  }

  private removeSkinBinding(binding: SkinBinding): void {
    this.removeRefs(this._root.animationSet.skeletons, (item) => item === binding);
  }

  private removeRefs<T extends Disposable>(refs: DRef<T>[], predicate: (item: T) => boolean): void {
    for (let i = refs.length - 1; i >= 0; i--) {
      const item = refs[i].get();
      if (item && predicate(item)) {
        refs[i].dispose();
        refs.splice(i, 1);
      }
    }
  }

  private getHiddenBodyRegions(slot: AvatarSlotId, options?: AvatarEquipOptions): string[] {
    return [
      ...new Set([...(this._slots.get(slot)?.hideBodyRegions ?? []), ...(options?.hideBodyRegions ?? [])])
    ];
  }

  private retainBodyRegions(regions: string[]): void {
    for (const node of this.collectBodyRegionNodes(regions)) {
      const count = this._hiddenBodyNodeCounts.get(node) ?? 0;
      if (count === 0) {
        this._bodyNodeOriginalState.set(node, node.showState);
        node.showState = 'hidden';
      }
      this._hiddenBodyNodeCounts.set(node, count + 1);
    }
  }

  private releaseBodyRegions(regions: string[]): void {
    for (const node of this.collectBodyRegionNodes(regions)) {
      const count = this._hiddenBodyNodeCounts.get(node) ?? 0;
      if (count <= 1) {
        this._hiddenBodyNodeCounts.delete(node);
        node.showState = this._bodyNodeOriginalState.get(node) ?? 'inherit';
        this._bodyNodeOriginalState.delete(node);
      } else {
        this._hiddenBodyNodeCounts.set(node, count - 1);
      }
    }
  }

  private collectBodyRegionNodes(regions: string[]): SceneNode[] {
    const nodes: SceneNode[] = [];
    const seen = new Set<SceneNode>();
    for (const region of regions) {
      for (const node of this._bodyRegions.get(region) ?? []) {
        if (!seen.has(node)) {
          seen.add(node);
          nodes.push(node);
        }
      }
    }
    return nodes;
  }

  private uniqueNodes(nodes: AvatarBodyRegionTarget[]): SceneNode[] {
    return [...new Set(nodes.filter((node): node is SceneNode => !!node))];
  }
}
