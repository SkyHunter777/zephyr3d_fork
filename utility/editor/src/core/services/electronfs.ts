import type {
  FileMetadata,
  FileStat,
  ListOptions,
  MoveOptions,
  ReadOptions,
  WriteOptions
} from '@zephyr3d/base';
import { VFS, VFSError } from '@zephyr3d/base';
import {
  getDesktopAPI,
  type DesktopFSChangeEvent,
  type DesktopFileMetadata,
  type DesktopFileStat,
  type DesktopFSScope
} from './desktop';

export class ElectronFS extends VFS {
  private readonly scope: DesktopFSScope;
  private _watchId: string | null;
  private _watchStart: Promise<void> | null;
  private _disposeFsChangeListener: (() => void) | null;

  constructor(scope: DesktopFSScope, readonly = false) {
    super(readonly);
    this.scope = scope;
    this._watchId = null;
    this._watchStart = null;
    this._disposeFsChangeListener = null;
    this.startWatchingExternalChanges();
  }

  protected async _makeDirectory(path: string, recursive: boolean) {
    await this.api().makeDirectory(this.scope, path, recursive);
  }

  async revealPath(path: string) {
    await this.api().revealPath(this.scope, path);
  }

  protected async _readDirectory(path: string, options?: ListOptions) {
    const entries = await this.api().readDirectory(this.scope, path, {
      recursive: !!options?.recursive
    });
    return entries
      .map((entry) => this.toFileMetadata(entry))
      .filter((entry) => this.matchesFilter(entry, options));
  }

  protected async _deleteDirectory(path: string, recursive: boolean) {
    await this.api().deleteDirectory(this.scope, path, recursive);
  }

  protected async _readFile(path: string, options?: ReadOptions) {
    return await this.api().readFile(this.scope, path, options);
  }

  protected async _writeFile(path: string, data: ArrayBuffer | string, options?: WriteOptions) {
    await this.api().writeFile(this.scope, path, data, options);
  }

  protected async _deleteFile(path: string) {
    await this.api().deleteFile(this.scope, path);
  }

  protected async _exists(path: string) {
    return await this.api().exists(this.scope, path);
  }

  protected async _stat(path: string) {
    return this.toFileStat(await this.api().stat(this.scope, path));
  }

  protected async _deleteFileSystem() {
    await this.api().deleteScope(this.scope);
  }

  protected async _wipe() {
    await this._deleteFileSystem();
  }

  protected async _move(sourcePath: string, targetPath: string, options?: MoveOptions) {
    await this.api().move(this.scope, sourcePath, targetPath, options);
  }

  protected async onClose() {
    await this.stopWatchingExternalChanges();
  }

  private api() {
    const api = getDesktopAPI()?.fs;
    if (!api) {
      throw new VFSError('Electron filesystem bridge is not available', 'ENOSYS');
    }
    return api;
  }

  private toFileMetadata(entry: DesktopFileMetadata): FileMetadata {
    return {
      ...entry,
      created: new Date(entry.created),
      modified: new Date(entry.modified)
    };
  }

  private toFileStat(stat: DesktopFileStat): FileStat {
    return {
      ...stat,
      created: new Date(stat.created),
      modified: new Date(stat.modified),
      accessed: stat.accessed ? new Date(stat.accessed) : undefined
    };
  }

  private matchesFilter(metadata: FileMetadata, options?: ListOptions) {
    if (!options) {
      return true;
    }
    if (!options.includeHidden && metadata.name.startsWith('.')) {
      return false;
    }
    if (options.pattern) {
      const relativePath = metadata.path.startsWith('/') ? metadata.path.slice(1) : metadata.path;
      if (typeof options.pattern === 'string') {
        const pattern = this.globToRegExp(options.pattern);
        return pattern.test(metadata.name) || pattern.test(relativePath);
      }
      return options.pattern.test(metadata.name) || options.pattern.test(relativePath);
    }
    return true;
  }

  private globToRegExp(pattern: string): RegExp {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0');
    return new RegExp(`^${source.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`);
  }

  private startWatchingExternalChanges() {
    const api = getDesktopAPI()?.fs;
    if (!api?.watch || !api?.onChange) {
      return;
    }
    this._disposeFsChangeListener = api.onChange((event) => {
      this.handleExternalChange(event);
    });
    this._watchStart = api
      .watch(this.scope, '/')
      .then((watchId) => {
        this._watchId = watchId;
      })
      .catch((err) => {
        console.warn(`Start filesystem watch failed for ${this.scope}: ${err}`);
        this._disposeFsChangeListener?.();
        this._disposeFsChangeListener = null;
      });
  }

  private async stopWatchingExternalChanges() {
    const api = getDesktopAPI()?.fs;
    const watchStart = this._watchStart;
    this._watchStart = null;
    if (watchStart) {
      await watchStart.catch(() => undefined);
    }
    if (this._disposeFsChangeListener) {
      this._disposeFsChangeListener();
      this._disposeFsChangeListener = null;
    }
    const watchId = this._watchId;
    this._watchId = null;
    if (watchId && api?.unwatch) {
      await api.unwatch(watchId).catch((err) => {
        console.warn(`Stop filesystem watch failed for ${this.scope}: ${err}`);
      });
    }
  }

  private handleExternalChange(event: DesktopFSChangeEvent) {
    if (!this._watchId || !event || event.watchId !== this._watchId || event.scope !== this.scope) {
      return;
    }
    this.onChange(event.type, this.normalizePath(event.path), event.itemType);
  }
}

export function createElectronProjectFS(id: string) {
  return new ElectronFS(`project:${id}`);
}
