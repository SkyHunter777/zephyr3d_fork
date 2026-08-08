import { DRef, Vector4, type Nullable } from '@zephyr3d/base';
import type { BluePrintUniformTexture, BluePrintUniformValue } from '../utility/blueprint/material/ir';
import { PBRBluePrintMaterial } from './pbrblueprint';
import type { PBRReflectionMode } from './mixins/lightmodel/pbrmetallicroughness';
import { SubsurfaceProfile, type SubsurfaceProfilePreset } from './subsurfaceprofile';

function cloneUniformFinalValue(value: BluePrintUniformValue) {
  if (typeof value.finalValue === 'number') {
    return value.finalValue;
  }
  if (value.finalValue instanceof Float32Array) {
    return new Float32Array(value.finalValue);
  }
  return value.value.length === 1 ? value.value[0] : new Float32Array(value.value);
}

function cloneTextureParams(params: BluePrintUniformTexture['params']) {
  return params instanceof Vector4
    ? params.clone()
    : params && typeof params === 'object' && 'x' in params && 'y' in params && 'z' in params && 'w' in params
      ? new Vector4(
          Number((params as { x: number }).x) || 0,
          Number((params as { y: number }).y) || 0,
          Number((params as { z: number }).z) || 0,
          Number((params as { w: number }).w) || 0
        )
      : Vector4.zero();
}

function cloneUniformValues(values: Nullable<BluePrintUniformValue[]>) {
  return (values ?? []).map((value) => ({
    ...value,
    value: [...value.value],
    finalValue: cloneUniformFinalValue(value)
  }));
}

function cloneUniformTextures(values: Nullable<BluePrintUniformTexture[]>) {
  return (values ?? []).map((value) => ({
    ...value,
    exposed: value.exposed ?? true,
    params: cloneTextureParams(value.params),
    finalTexture: value.finalTexture ? new DRef(value.finalTexture.get()) : undefined,
    finalSampler: value.finalSampler
  }));
}

function mergeHydratedUniformTexture(
  base: BluePrintUniformTexture,
  runtime: Nullable<BluePrintUniformTexture>
) {
  if (!runtime) {
    return base;
  }
  return {
    ...base,
    finalTexture: runtime.finalTexture ?? base.finalTexture,
    finalSampler: runtime.finalSampler ?? base.finalSampler,
    params: runtime.params ?? base.params
  };
}

function inheritUniformTextureMetadata(parent: BluePrintUniformTexture, override: BluePrintUniformTexture) {
  return {
    ...override,
    type: parent.type,
    exposed: parent.exposed,
    sRGB: parent.sRGB,
    wrapS: parent.wrapS,
    wrapT: parent.wrapT,
    minFilter: parent.minFilter,
    magFilter: parent.magFilter,
    mipFilter: parent.mipFilter,
    inVertexShader: parent.inVertexShader,
    inFragmentShader: parent.inFragmentShader,
    finalSampler: parent.finalSampler
  };
}

function mergeUniformTextureOverride(
  parent: BluePrintUniformTexture,
  override: BluePrintUniformTexture,
  runtime: Nullable<BluePrintUniformTexture>
) {
  const hydratedOverride = override.finalTexture
    ? override
    : runtime?.texture === override.texture
      ? runtime
      : null;
  return inheritUniformTextureMetadata(parent, {
    ...override,
    finalTexture: hydratedOverride?.finalTexture ?? parent.finalTexture,
    params: hydratedOverride?.params ?? parent.params
  });
}

function uniformValueEquals(a: BluePrintUniformValue, b: BluePrintUniformValue) {
  if (a.type !== b.type || a.value.length !== b.value.length) {
    return false;
  }
  return a.value.every((value, index) => value === b.value[index]);
}

function uniformTextureEquals(a: BluePrintUniformTexture, b: BluePrintUniformTexture) {
  return a.type === b.type && a.texture === b.texture;
}

function valuesEqual(a: unknown, b: unknown) {
  if (a === b) {
    return true;
  }
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    'equalsTo' in (a as Record<string, unknown>) &&
    typeof (a as { equalsTo?: unknown }).equalsTo === 'function'
  ) {
    return !!(a as { equalsTo: (other: unknown) => boolean }).equalsTo(b);
  }
  return false;
}

/** Parameter overrides that cannot be migrated to a new blueprint material parent. */
export interface PBRBluePrintMaterialInstanceDiscardedOverrides {
  uniformValues: string[];
  uniformTextures: string[];
}

/**
 * Blueprint material instance asset.
 *
 * Inherits graph/IR from a parent blueprint material and stores only parameter overrides.
 * This is distinct from the per-draw MeshMaterial instance-uniform mechanism.
 *
 * @public
 */
export class PBRBluePrintMaterialInstance extends PBRBluePrintMaterial {
  private _parentMaterialId: string;
  private _parentMaterial: Nullable<PBRBluePrintMaterial>;
  private _overrideUniformValues: Map<string, BluePrintUniformValue>;
  private _overrideUniformTextures: Map<string, BluePrintUniformTexture>;
  private _reflectionModeOverridden: boolean;
  private _overrideMaterialProps: Set<string>;
  private _subsurfaceProfileOverride: SubsurfaceProfile | null;

  constructor(parentMaterial?: Nullable<PBRBluePrintMaterial>, parentMaterialId = '') {
    super();
    this._parentMaterialId = parentMaterialId;
    this._parentMaterial = null;
    this._overrideUniformValues = new Map();
    this._overrideUniformTextures = new Map();
    this._reflectionModeOverridden = false;
    this._overrideMaterialProps = new Set();
    this._subsurfaceProfileOverride = null;
    if (parentMaterial) {
      this.setParentMaterial(parentMaterial, parentMaterialId);
    }
  }

  get parentMaterialId() {
    return this._parentMaterialId;
  }

  get parentMaterial() {
    return this._parentMaterial;
  }

  get isBlueprintMaterialInstance() {
    return true;
  }

  get hasSubsurfaceProfileOverride() {
    return !!this._subsurfaceProfileOverride;
  }

  setMaterialPropertyOverrides(propNames: Iterable<string>) {
    this._overrideMaterialProps = new Set(propNames);
    this._reflectionModeOverridden = this._overrideMaterialProps.has('Reflection');
    if (
      [...this._overrideMaterialProps].some((name) => name.startsWith('Subsurface')) &&
      this.subsurfaceProfile &&
      this.subsurfaceProfile !== this._parentMaterial?.subsurfaceProfile
    ) {
      this._subsurfaceProfileOverride = this.subsurfaceProfile;
    }
  }

  /** @internal Reset persisted property overrides before reloading an instance asset. */
  resetMaterialPropertyOverrides(propNames: Iterable<string>) {
    if (this._subsurfaceProfileOverride) {
      this._subsurfaceProfileOverride = null;
      super.subsurfaceProfile = this._parentMaterial?.subsurfaceProfile ?? null;
    }
    this.setMaterialPropertyOverrides(propNames);
  }

  getMaterialPropertyOverrides() {
    return [...this._overrideMaterialProps];
  }

  markMaterialPropertyOverridden(propName: string) {
    this._overrideMaterialProps.add(propName);
  }

  isMaterialPropertyOverridden(propName: string) {
    return this._overrideMaterialProps.has(propName);
  }

  setOverrides(
    uniformValues: Nullable<BluePrintUniformValue[]>,
    uniformTextures: Nullable<BluePrintUniformTexture[]>
  ) {
    const parentValueMap = new Map(
      (this._parentMaterial?.uniformValues ?? []).map((value) => [value.name, value])
    );
    const parentTextureMap = new Map(
      (this._parentMaterial?.uniformTextures ?? []).map((value) => [value.name, value])
    );
    this._overrideUniformValues = new Map(
      cloneUniformValues(uniformValues)
        .filter((value) => {
          const parent = parentValueMap.get(value.name);
          return !parent || !uniformValueEquals(value, parent);
        })
        .map((value) => [value.name, value])
    );
    this._overrideUniformTextures = new Map(
      cloneUniformTextures(uniformTextures)
        .filter((value) => {
          const parent = parentTextureMap.get(value.name);
          return !parent || !uniformTextureEquals(value, parent);
        })
        .map((value) => {
          const parent = parentTextureMap.get(value.name);
          return [value.name, parent ? inheritUniformTextureMetadata(parent, value) : value] as const;
        })
    );
    this.syncInheritedUniforms();
  }

  getOverrideUniformValues() {
    return [...this._overrideUniformValues.values()].map((value) => ({
      name: value.name,
      type: value.type,
      value: [...value.value],
      finalValue: undefined
    }));
  }

  getOverrideUniformTextures() {
    const parentTextureMap = new Map(
      (this._parentMaterial?.uniformTextures ?? []).map((value) => [value.name, value])
    );
    return [...this._overrideUniformTextures.values()].map((value) => {
      const parent = parentTextureMap.get(value.name);
      const normalized = parent ? inheritUniformTextureMetadata(parent, value) : value;
      return {
        ...normalized,
        params: cloneTextureParams(normalized.params),
        finalTexture: undefined,
        finalSampler: undefined
      };
    });
  }

  getDiscardedOverridesForParent(
    parentMaterial: PBRBluePrintMaterial
  ): PBRBluePrintMaterialInstanceDiscardedOverrides {
    const parentValueMap = new Map(parentMaterial.uniformValues.map((value) => [value.name, value]));
    const parentTextureMap = new Map(parentMaterial.uniformTextures.map((value) => [value.name, value]));
    return {
      uniformValues: [...this._overrideUniformValues.values()]
        .filter((value) => {
          const parent = parentValueMap.get(value.name);
          return !parent || parent.type !== value.type || parent.value.length !== value.value.length;
        })
        .map((value) => value.name),
      uniformTextures: [...this._overrideUniformTextures.values()]
        .filter((value) => {
          const parent = parentTextureMap.get(value.name);
          return !parent || parent.type !== value.type || parent.exposed === false;
        })
        .map((value) => value.name)
    };
  }

  changeParentMaterial(
    parentMaterial: PBRBluePrintMaterial,
    parentMaterialId?: string
  ): PBRBluePrintMaterialInstanceDiscardedOverrides {
    const discarded = this.getDiscardedOverridesForParent(parentMaterial);
    const discardedValues = new Set(discarded.uniformValues);
    const discardedTextures = new Set(discarded.uniformTextures);
    const parentTextureMap = new Map(parentMaterial.uniformTextures.map((value) => [value.name, value]));

    this._overrideUniformValues = new Map(
      [...this._overrideUniformValues.entries()].filter(([name]) => !discardedValues.has(name))
    );
    this._overrideUniformTextures = new Map(
      [...this._overrideUniformTextures.entries()]
        .filter(([name]) => !discardedTextures.has(name))
        .map(([name, override]) => {
          const parent = parentTextureMap.get(name)!;
          return [
            name,
            {
              ...override,
              exposed: parent.exposed,
              inVertexShader: parent.inVertexShader,
              inFragmentShader: parent.inFragmentShader
            }
          ];
        })
    );
    this.uniformTextures = this.uniformTextures.filter((value) => !discardedTextures.has(value.name));
    this.setParentMaterial(parentMaterial, parentMaterialId);
    return discarded;
  }

  hasReflectionModeOverride() {
    return this._reflectionModeOverridden || this.isMaterialPropertyOverridden('Reflection');
  }

  setBlueprintInstanceReflectionMode(value: PBRReflectionMode, inherited = false) {
    this._reflectionModeOverridden =
      !inherited && !!this._parentMaterial && value !== this._parentMaterial.reflectionMode;
    if (this._reflectionModeOverridden) {
      this._overrideMaterialProps.add('Reflection');
    } else if (!inherited) {
      this._overrideMaterialProps.delete('Reflection');
    }
    super.reflectionMode = value;
  }

  private copySubsurfaceProfile(source: Nullable<SubsurfaceProfile>) {
    if (!source) {
      return null;
    }
    const profile = new SubsurfaceProfile();
    profile.preset = source.preset;
    profile.meanFreePathColor = source.meanFreePathColor;
    profile.meanFreePathDistance = source.meanFreePathDistance;
    profile.falloffColor = source.falloffColor;
    profile.strength = source.strength;
    profile.scale = source.scale;
    profile.worldUnitScale = source.worldUnitScale;
    profile.boundaryColorBleed = source.boundaryColorBleed;
    profile.transmissionTintColor = source.transmissionTintColor;
    profile.extinctionScale = source.extinctionScale;
    profile.normalScale = source.normalScale;
    profile.scatteringDistribution = source.scatteringDistribution;
    return profile;
  }

  private ensureSubsurfaceProfileOverride() {
    if (this._subsurfaceProfileOverride) {
      return this._subsurfaceProfileOverride;
    }
    const source = this.subsurfaceProfile ?? this._parentMaterial?.subsurfaceProfile ?? null;
    const profile = this.copySubsurfaceProfile(source);
    this._subsurfaceProfileOverride = profile;
    super.subsurfaceProfile = profile;
    return profile;
  }

  syncInheritedSubsurfaceProfile(parentProfile: Nullable<SubsurfaceProfile>) {
    super.subsurfaceProfile = this._subsurfaceProfileOverride ?? parentProfile ?? null;
  }

  setBlueprintInstanceSubsurfacePreset(value: SubsurfaceProfilePreset) {
    this.setBlueprintInstanceSubsurfaceProfileValue('SubsurfaceLookPreset', 'preset', value);
  }

  setBlueprintInstanceSubsurfaceStrength(value: number) {
    this.setBlueprintInstanceSubsurfaceProfileValue('SubsurfaceScatterWeight', 'strength', value);
  }

  setBlueprintInstanceSubsurfaceScale(value: number) {
    this.setBlueprintInstanceSubsurfaceProfileValue('SubsurfaceScatterScale', 'scale', value);
  }

  setBlueprintInstanceSubsurfaceProfileValue<K extends keyof SubsurfaceProfile>(
    propName: string,
    key: K,
    value: SubsurfaceProfile[K]
  ) {
    const inherited = this._parentMaterial?.subsurfaceProfile ?? null;
    const inheritedValue = inherited ? inherited[key] : undefined;
    if (!this._subsurfaceProfileOverride && inherited && valuesEqual(inheritedValue, value)) {
      this._overrideMaterialProps.delete(propName);
      super.subsurfaceProfile = inherited;
      return;
    }
    const profile = this.ensureSubsurfaceProfileOverride();
    if (profile) {
      this._overrideMaterialProps.add(propName);
      (profile as unknown as Record<string, unknown>)[key as string] = value;
      super.subsurfaceProfile = profile;
    }
  }

  setParentMaterial(parentMaterial: Nullable<PBRBluePrintMaterial>, parentMaterialId?: string) {
    this._parentMaterial = parentMaterial;
    if (parentMaterialId !== undefined) {
      this._parentMaterialId = parentMaterialId;
    }
    if (parentMaterial) {
      this.syncInheritedUniforms(parentMaterial);
      this.clearCache();
      this.optionChanged(true);
    }
  }

  syncInheritedUniforms(parentMaterial = this._parentMaterial) {
    if (!parentMaterial) {
      return;
    }
    const runtimeTextureMap = new Map((this.uniformTextures ?? []).map((value) => [value.name, value]));
    this.fragmentIR = parentMaterial.fragmentIR;
    this.vertexIR = parentMaterial.vertexIR;
    this.copyInheritedMaterialState(parentMaterial);
    this.uniformValues = cloneUniformValues(parentMaterial.uniformValues).map((value) => {
      const override = this._overrideUniformValues.get(value.name);
      return override
        ? { ...value, value: [...override.value], finalValue: cloneUniformFinalValue(override) }
        : value;
    });
    this.uniformTextures = cloneUniformTextures(parentMaterial.uniformTextures).map((value) => {
      const override = this._overrideUniformTextures.get(value.name);
      return override
        ? mergeUniformTextureOverride(value, override, runtimeTextureMap.get(value.name) ?? null)
        : mergeHydratedUniformTexture(value, runtimeTextureMap.get(value.name) ?? null);
    });
  }

  private copyInheritedMaterialState(parent: PBRBluePrintMaterial) {
    this.alphaCutoff = parent.alphaCutoff;
    this.alphaDither = parent.alphaDither;
    this.alphaToCoverage = parent.alphaToCoverage;
    this.blendMode = parent.blendMode;
    this.transparentShadowCaster = parent.transparentShadowCaster;
    this.shadowAlphaCutoff = parent.shadowAlphaCutoff;
    this.cullMode = parent.cullMode;
    this.opacity = parent.opacity;
    this.objectColor = parent.objectColor;
    this.TAAStrength = parent.TAAStrength;
    this.vertexColor = parent.vertexColor;
    this.vertexNormal = parent.vertexNormal;
    this.vertexTangent = parent.vertexTangent;
    if (!this.isMaterialPropertyOverridden('NormalScale')) {
      this.normalScale = parent.normalScale;
    }
    if (!this.isMaterialPropertyOverridden('doubleSidedLighting')) {
      this.doubleSidedLighting = parent.doubleSidedLighting;
    }
    if (!this.isMaterialPropertyOverridden('Metallic')) {
      this.metallic = parent.metallic;
    }
    if (!this.isMaterialPropertyOverridden('Roughness')) {
      this.roughness = parent.roughness;
    }
    if (!this.isMaterialPropertyOverridden('SpecularFactor')) {
      this.specularFactor = parent.specularFactor;
    }
    if (!this.isMaterialPropertyOverridden('RectSpecularScale')) {
      this.rectSpecularScale = parent.rectSpecularScale;
    }
    if (!this.isMaterialPropertyOverridden('Reflection')) {
      this.setBlueprintInstanceReflectionMode(parent.reflectionMode, true);
    }
    if (!this.isMaterialPropertyOverridden('Anisotropy')) {
      this.anisotropy = parent.anisotropy;
    }
    if (!this.isMaterialPropertyOverridden('AnisotropyDirection')) {
      this.anisotropyDirection = parent.anisotropyDirection;
    }
    this.clearcoat = parent.clearcoat;
    this.clearcoatIntensity = parent.clearcoatIntensity;
    this.clearcoatRoughnessFactor = parent.clearcoatRoughnessFactor;
    this.clearcoatIntensityTexture = parent.clearcoatIntensityTexture;
    this.clearcoatIntensityTextureSampler = parent.clearcoatIntensityTextureSampler;
    this.clearcoatIntensityTexCoordMatrix = parent.clearcoatIntensityTexCoordMatrix;
    this.clearcoatIntensityTexCoordIndex = parent.clearcoatIntensityTexCoordIndex;
    this.clearcoatRoughnessTexture = parent.clearcoatRoughnessTexture;
    this.clearcoatRoughnessTextureSampler = parent.clearcoatRoughnessTextureSampler;
    this.clearcoatRoughnessTexCoordMatrix = parent.clearcoatRoughnessTexCoordMatrix;
    this.clearcoatRoughnessTexCoordIndex = parent.clearcoatRoughnessTexCoordIndex;
    this.clearcoatNormalTexture = parent.clearcoatNormalTexture;
    this.clearcoatNormalTextureSampler = parent.clearcoatNormalTextureSampler;
    this.clearcoatNormalTexCoordMatrix = parent.clearcoatNormalTexCoordMatrix;
    this.clearcoatNormalTexCoordIndex = parent.clearcoatNormalTexCoordIndex;
    this.syncInheritedSubsurfaceProfile(parent.subsurfaceProfile);
    if (!this.isMaterialPropertyOverridden('Transmission')) {
      this.transmission = parent.transmission;
    }
    if (!this.isMaterialPropertyOverridden('IOR')) {
      this.ior = parent.ior;
    }
    if (!this.isMaterialPropertyOverridden('TransmissionFactor')) {
      this.transmissionFactor = parent.transmissionFactor;
    }
    if (!this.isMaterialPropertyOverridden('ThicknessFactor')) {
      this.thicknessFactor = parent.thicknessFactor;
    }
    if (!this.isMaterialPropertyOverridden('AttenuationColor')) {
      this.attenuationColor = parent.attenuationColor;
    }
    if (!this.isMaterialPropertyOverridden('AttenuationDistance')) {
      this.attenuationDistance = parent.attenuationDistance;
    }
    if (!this.isMaterialPropertyOverridden('TransmissionTexture')) {
      this.transmissionTexture = parent.transmissionTexture;
    }
    if (
      !this.isMaterialPropertyOverridden('TransmissionTexCoordAddressU') &&
      !this.isMaterialPropertyOverridden('TransmissionTexCoordAddressV')
    ) {
      this.transmissionTextureSampler = parent.transmissionTextureSampler;
    }
    if (!this.isMaterialPropertyOverridden('TransmissionTexCoordScale')) {
      this.transmissionTexCoordMatrix = parent.transmissionTexCoordMatrix;
    }
    if (!this.isMaterialPropertyOverridden('TransmissionTexCoordIndex')) {
      this.transmissionTexCoordIndex = parent.transmissionTexCoordIndex;
    }
    if (!this.isMaterialPropertyOverridden('ThicknessTexture')) {
      this.thicknessTexture = parent.thicknessTexture;
    }
    if (
      !this.isMaterialPropertyOverridden('ThicknessTexCoordAddressU') &&
      !this.isMaterialPropertyOverridden('ThicknessTexCoordAddressV')
    ) {
      this.thicknessTextureSampler = parent.thicknessTextureSampler;
    }
    if (!this.isMaterialPropertyOverridden('ThicknessTexCoordScale')) {
      this.thicknessTexCoordMatrix = parent.thicknessTexCoordMatrix;
    }
    if (!this.isMaterialPropertyOverridden('ThicknessTexCoordIndex')) {
      this.thicknessTexCoordIndex = parent.thicknessTexCoordIndex;
    }
    if (!this.isMaterialPropertyOverridden('SubsurfaceTexture')) {
      this.subsurfaceTexture = parent.subsurfaceTexture;
    }
    if (
      !this.isMaterialPropertyOverridden('SubsurfaceTexCoordAddressU') &&
      !this.isMaterialPropertyOverridden('SubsurfaceTexCoordAddressV')
    ) {
      this.subsurfaceTextureSampler = parent.subsurfaceTextureSampler;
    }
    if (!this.isMaterialPropertyOverridden('SubsurfaceTexCoordScale')) {
      this.subsurfaceTexCoordMatrix = parent.subsurfaceTexCoordMatrix;
    }
    if (!this.isMaterialPropertyOverridden('SubsurfaceTexCoordIndex')) {
      this.subsurfaceTexCoordIndex = parent.subsurfaceTexCoordIndex;
    }
  }
}
