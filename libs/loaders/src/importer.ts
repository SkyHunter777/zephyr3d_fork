import type { SceneNode, Scene } from '@zephyr3d/scene';
import { getEngine, SharedModel } from '@zephyr3d/scene';
import { PathUtils, type VFS } from '@zephyr3d/base';

/**
 * Generic model importer interface
 * @public
 */
export abstract class AbstractModelImporter {
  abstract import(data: Blob, model: SharedModel, basePath: string, vfs?: VFS): void | Promise<void>;
  async loadModel(path: string, vfs?: VFS): Promise<SharedModel> {
    if (!vfs) {
      vfs = getEngine().VFS;
    }
    const mimeType = vfs.guessMIMEType(path);
    const data = (await vfs.readFile(path, { encoding: 'binary' })) as ArrayBuffer;
    const blob = new Blob([data], { type: mimeType });
    const model = new SharedModel();
    await this.import(blob, model, PathUtils.dirname(path), vfs);
    return model;
  }
  async loadModelToScene(scene: Scene, path: string, instancing?: boolean, vfs?: VFS): Promise<SceneNode> {
    const model = await this.loadModel(path, vfs);
    return model.createSceneNode(
      getEngine().resourceManager,
      scene,
      instancing ?? false,
      true,
      true,
      true,
      true,
      vfs ?? getEngine().VFS
    );
  }
}
