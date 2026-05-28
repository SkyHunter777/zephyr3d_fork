import { ImGui } from '@zephyr3d/imgui';
import type { SharedModel } from '@zephyr3d/scene';
import { DialogRenderer } from '../../components/modal';
import type { VFS } from '@zephyr3d/base';
import { DlgSkeletonEditor } from './skeletoneditor';
import type { SaveOptions } from '../../core/services/resource';

export class DlgImportOptions extends DialogRenderer<SaveOptions[]> {
  protected _vfs: VFS;
  protected _models: SharedModel[];
  protected _current: number;
  protected _modelNames: string[];
  protected _options: SaveOptions[];
  public static promptImportOptions(
    title: string,
    vfs: VFS,
    models: SharedModel[],
    names: string[],
    width?: number,
    height?: number
  ) {
    return new DlgImportOptions(`${title}##Dialog`, vfs, models, names, width, height).showModal();
  }
  constructor(id: string, vfs: VFS, models: SharedModel[], names: string[], width?: number, height?: number) {
    super(id ?? 'MessageBox', width ?? 300, height ?? 0);
    this._vfs = vfs;
    this._models = models;
    this._current = 0;
    this._modelNames = names;
    this._options = models.map((model) => ({
      importMeshes: model.primitives.length > 0,
      importSkeletons: model.skeletons.length > 0,
      importAnimations: model.animations.length > 0,
      importJointDynamics: model.jointDynamicsSpringBones.length > 0
    }));
  }
  doRender(): void {
    const selected = [this._current] as [number];
    if (ImGui.Combo('Select Model', selected, this._modelNames)) {
      this._current = selected[0];
    }
    ImGui.Separator();

    // Mesh option
    const hasMeshes = this._models[this._current].primitives.length > 0;
    if (!hasMeshes) {
      ImGui.PushStyleVar(ImGui.StyleVar.Alpha, ImGui.GetStyle().Alpha * 0.5);
    }
    const importMeshes = [this._options[this._current].importMeshes] as [boolean];
    if (ImGui.Checkbox('Import Meshes', importMeshes)) {
      if (hasMeshes) {
        this._options[this._current].importMeshes = importMeshes[0];
      }
    }
    if (!hasMeshes) {
      ImGui.PopStyleVar();
    }

    // Skeleton option
    const hasSkeletons = this._models[this._current].skeletons.length > 0;
    if (!hasSkeletons) {
      ImGui.PushStyleVar(ImGui.StyleVar.Alpha, ImGui.GetStyle().Alpha * 0.5);
    }
    const importSkeletons = [hasSkeletons && this._options[this._current].importSkeletons] as [boolean];
    if (ImGui.Checkbox('Import Skeletons', importSkeletons)) {
      if (hasSkeletons) {
        this._options[this._current].importSkeletons = importSkeletons[0];
      }
    }
    if (!hasSkeletons) {
      ImGui.PopStyleVar();
    }
    if (this._options[this._current].importSkeletons) {
      ImGui.SameLine();
      if (ImGui.Button('Settings...')) {
        DlgSkeletonEditor.editSkeleton('SkeletonEditor', this._models[this._current].skeletons, 500, 500);
      }
    }

    // Animation option
    const hasAnimations = hasSkeletons && this._models[this._current].animations.length > 0;
    if (!hasAnimations) {
      ImGui.PushStyleVar(ImGui.StyleVar.Alpha, ImGui.GetStyle().Alpha * 0.5);
    }
    const importAnimations = [hasAnimations && this._options[this._current].importAnimations] as [boolean];
    if (ImGui.Checkbox('Import Animations', importAnimations)) {
      if (hasAnimations) {
        this._options[this._current].importAnimations = importAnimations[0];
      }
    }
    if (!hasAnimations) {
      ImGui.PopStyleVar();
    }

    // Joint dynamics option
    const hasJointDynamics = hasSkeletons && this._models[this._current].jointDynamicsSpringBones.length > 0;
    if (!hasJointDynamics) {
      ImGui.PushStyleVar(ImGui.StyleVar.Alpha, ImGui.GetStyle().Alpha * 0.5);
    }
    const importJointDynamics = [hasJointDynamics && this._options[this._current].importJointDynamics] as [
      boolean
    ];
    if (ImGui.Checkbox('Import Joint Dynamics', importJointDynamics)) {
      if (hasJointDynamics) {
        this._options[this._current].importJointDynamics = importJointDynamics[0];
      }
    }
    if (!hasJointDynamics) {
      ImGui.PopStyleVar();
    }

    ImGui.Separator();
    if (ImGui.Button('OK')) {
      this.close(this._options);
    }
    ImGui.SameLine();
    if (ImGui.Button('Cancel')) {
      this.close(null);
    }
  }
}
