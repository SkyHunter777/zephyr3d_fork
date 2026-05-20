import type { SceneNode, Scene } from '@zephyr3d/scene';
import { getEngine } from '@zephyr3d/scene';
import { SharedModel } from './model';
import type { VFS } from '@zephyr3d/base';

/**
 * Generic model importer interface
 * @public
 */
export abstract class AbstractModelImporter {
  abstract import(data: Blob, model: SharedModel): void | Promise<void>;
  async loadModelToScene(scene: Scene, path: string, instancing?: boolean, vfs?: VFS): Promise<SceneNode> {
    if (!vfs) {
      vfs = getEngine().VFS;
    }
    const mimeType = vfs.guessMIMEType(path);
    const data = (await vfs.readFile(path, { encoding: 'binary' })) as ArrayBuffer;
    const blob = new Blob([data], { type: mimeType });
    const model = new SharedModel(vfs, path);
    await this.import(blob, model);
    return model.createSceneNode(getEngine().resourceManager, scene, instancing ?? false, true, true, true);
  }
}
