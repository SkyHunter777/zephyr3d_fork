import { ASSERT, type VFS } from '@zephyr3d/base';
import type { AbstractModelImporter } from '@zephyr3d/loaders';
import { GLTFImporter, SharedModel } from '@zephyr3d/loaders';
import { type SceneNode, type ResourceManager, Scene } from '@zephyr3d/scene';

export type SaveOptions = {
  importMeshes: boolean;
  importSkeletons: boolean;
  importAnimations: boolean;
};

export class ResourceService {
  static async importModel(srcVFS: VFS, path: string): Promise<SharedModel> {
    const mimeType = srcVFS.guessMIMEType(path);
    let loader: AbstractModelImporter = null;
    if (mimeType === 'model/gltf+json' || mimeType === 'model/gltf-binary') {
      console.info(`Start importing model ${path} - ${mimeType}`);
      loader = new GLTFImporter();
    } else {
      throw new Error(`No valid loader found`);
    }
    ASSERT(!!loader, `Unsupported model type: ${mimeType}`);
    const data = (await srcVFS.readFile(path, { encoding: 'binary' })) as ArrayBuffer;
    const blob = new Blob([data], { type: mimeType });
    const model = new SharedModel(srcVFS, path);
    await loader.import(blob, model);
    return model;
  }
  static async savePrefabNode(
    node: SceneNode,
    manager: ResourceManager,
    path: string,
    name: string
  ): Promise<void> {
    const prefabId = node.prefabId;
    const position = node.position.clone();
    const rotation = node.rotation.clone();
    const scale = node.scale.clone();
    node.position.setXYZ(0, 0, 0);
    node.rotation.identity();
    node.scale.setXYZ(1, 1, 1);
    node.prefabId = '';
    const data = await manager.serializeObject(node);
    node.prefabId = prefabId;
    node.position.set(position);
    node.rotation.set(rotation);
    node.scale.set(scale);
    const content = JSON.stringify({ type: 'SceneNode', data }, null, 2);
    const fn = name.endsWith('.zprefab') ? name : `${name}.zprefab`;
    await manager.VFS.writeFile(manager.VFS.join(path, fn), content, {
      encoding: 'utf8',
      create: true
    });
  }
  static async savePrefab(
    model: SharedModel,
    manager: ResourceManager,
    path: string,
    saveOptions?: SaveOptions
  ) {
    await model.preprocess(manager, path);
    const saveMeshes = saveOptions?.importMeshes ?? true;
    const saveSkeletons = saveOptions?.importSkeletons ?? true;
    const saveAnimations = saveOptions?.importAnimations ?? true;
    const tmpScene = new Scene();
    const node = await model.createSceneNode(
      manager,
      tmpScene,
      false,
      saveMeshes,
      saveSkeletons,
      saveAnimations
    );
    const numSkeletons = node.animationSet?.skeletons?.length ?? 0;
    const numAnimations = node.animationSet?.getAnimationNames().length ?? 0;
    await ResourceService.saveNodeToPrefab(node, manager, path, model.name);
    tmpScene.dispose();
    console.info(
      `Successfully created prefab with ${numSkeletons} skeletons and ${numAnimations} animations: ${path}`
    );
  }
  static async saveNodeToPrefab(
    node: SceneNode,
    manager: ResourceManager,
    path: string,
    name: string
  ): Promise<void> {
    const prefabId = node.prefabId;
    const position = node.position.clone();
    const rotation = node.rotation.clone();
    const scale = node.scale.clone();
    node.position.setXYZ(0, 0, 0);
    node.rotation.identity();
    node.scale.setXYZ(1, 1, 1);
    node.prefabId = '';
    const data = await manager.serializeObject(node);
    node.prefabId = prefabId;
    node.position.set(position);
    node.rotation.set(rotation);
    node.scale.set(scale);
    const content = JSON.stringify({ type: 'SceneNode', data }, null, 2);
    const fn = name.endsWith('.zprefab') ? name : `${name}.zprefab`;
    await manager.VFS.writeFile(manager.VFS.join(path, fn), content, {
      encoding: 'utf8',
      create: true
    });
  }
}
