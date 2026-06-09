import { configure, ZipWriter } from '@zip.js/zip.js';
import type { VFS } from '@zephyr3d/base';
import * as streamSaver from 'streamsaver';
import { getDesktopAPI } from '../core/services/desktop';
import { ElectronFS } from '../core/services/electronfs';
import { ProjectService } from '../core/services/project';

export class ZipDownloader {
  static readonly _hasNativeDeflateRawSupport = (function supportsDeflateRaw(): boolean {
    try {
      if (typeof CompressionStream === 'undefined') {
        return false;
      }
      new CompressionStream('deflate-raw');
      return true;
    } catch {
      return false;
    }
  })();
  private readonly _zipWriter: ZipWriter<any>;
  private readonly _downloadPromise: Promise<void>;
  private readonly _transformStream: TransformStream;
  constructor(filename: string) {
    const fileStream = streamSaver.createWriteStream(filename);
    this._transformStream = new TransformStream();
    this._downloadPromise = this._transformStream.readable.pipeTo(fileStream);
    configure({
      useWebWorkers: false,
      useCompressionStream: ZipDownloader._hasNativeDeflateRawSupport
    });
    this._zipWriter = new ZipWriter(this._transformStream.writable);
  }
  get zipWriter() {
    return this._zipWriter;
  }
  async add(filename: string, stream: ReadableStream) {
    await this._zipWriter.add(filename, stream);
  }
  async finish() {
    try {
      await this._zipWriter.close();
      await this._downloadPromise;
    } catch (err) {
      console.error('Download error:', err);
      await this._transformStream.writable.getWriter().close();
    }
  }
}

export async function exportFile(arrayBuffer: ArrayBuffer, filename: string) {
  const fileStream = streamSaver.createWriteStream(filename);
  const writer = fileStream.getWriter();

  const chunkSize = 64 * 1024;
  const uint8Array = new Uint8Array(arrayBuffer);

  for (let offset = 0; offset < uint8Array.length; offset += chunkSize) {
    const chunk = uint8Array.subarray(offset, offset + chunkSize);
    await writer.write(chunk);
  }
  await writer.close();
}

export async function exportMultipleFilesAsZip(
  files: string[],
  directories: string[],
  zipFilename: string,
  vfs: VFS = ProjectService.VFS,
  options?: {
    preserveProjectPaths?: boolean;
    onProgress?: (current: number, total: number) => void;
  }
) {
  const zipDownloader = new ZipDownloader(zipFilename);
  const zipWriter = zipDownloader.zipWriter;
  const { commonPrefix, directoryEntries, uniqueFiles } = await collectExportEntries(
    files,
    directories,
    vfs,
    options
  );
  const totalSteps = directoryEntries.length + uniqueFiles.length || 1;
  let currentStep = 0;
  options?.onProgress?.(currentStep, totalSteps);
  for (const dir of directoryEntries) {
    await zipWriter.add(`${dir}/`, new Blob([]).stream());
    options?.onProgress?.(++currentStep, totalSteps);
  }
  for (const f of uniqueFiles) {
    const content = (await vfs.readFile(f, { encoding: 'binary' })) as ArrayBuffer;
    await zipWriter.add(f.slice(commonPrefix.length), new Blob([content]).stream());
    options?.onProgress?.(++currentStep, totalSteps);
  }
  await zipDownloader.finish();
}

export async function exportMultipleFilesToDirectory(
  files: string[],
  directories: string[],
  vfs: VFS = ProjectService.VFS,
  options?: {
    preserveProjectPaths?: boolean;
    targetRoot?: string;
    resetPaths?: string[];
    onProgress?: (current: number, total: number) => void;
  }
) {
  const desktop = getDesktopAPI();
  if (!desktop?.fs.pickDirectory) {
    return false;
  }
  const targetRoot =
    options?.targetRoot ||
    (await desktop.fs.pickDirectory({
      title: 'Select Export Directory',
      buttonLabel: 'Export Here'
    }));
  if (!targetRoot) {
    return false;
  }
  const outputFS = new ElectronFS(`project:${targetRoot}`);
  const { commonPrefix, directoryEntries, uniqueFiles } = await collectExportEntries(
    files,
    directories,
    vfs,
    options
  );
  try {
    const totalSteps = directoryEntries.length + uniqueFiles.length || 1;
    let currentStep = 0;
    options?.onProgress?.(currentStep, totalSteps);
    for (const resetPath of options?.resetPaths ?? []) {
      if (await outputFS.exists(resetPath)) {
        await outputFS.deleteDirectory(resetPath, true);
      }
    }
    for (const dir of directoryEntries) {
      await outputFS.makeDirectory(`/${dir}`, true);
      options?.onProgress?.(++currentStep, totalSteps);
    }
    for (const f of uniqueFiles) {
      const relativePath = f.slice(commonPrefix.length);
      const targetPath = `/${relativePath}`;
      const parentDir = outputFS.dirname(targetPath);
      if (parentDir && parentDir !== '/') {
        await outputFS.makeDirectory(parentDir, true);
      }
      const content = (await vfs.readFile(f, { encoding: 'binary' })) as ArrayBuffer;
      await outputFS.writeFile(targetPath, content, {
        encoding: 'binary',
        create: true
      });
      options?.onProgress?.(++currentStep, totalSteps);
    }
    return true;
  } finally {
    await outputFS.close();
  }
}

async function collectExportEntries(
  files: string[],
  directories: string[],
  vfs: VFS,
  options?: {
    preserveProjectPaths?: boolean;
  }
) {
  const fileSet: Set<string> = new Set();
  const directorySet: Set<string> = new Set();
  const fileList = [...files];
  for (const dir of directories) {
    const path = vfs.normalizePath(dir);
    directorySet.add(path);
    const entries = await vfs.readDirectory(path, {
      includeHidden: true,
      recursive: true
    });
    for (const entry of entries) {
      if (entry.type === 'directory') {
        directorySet.add(vfs.normalizePath(entry.path));
      } else {
        fileList.push(entry.path);
      }
    }
  }
  for (const f of fileList) {
    const filename = vfs.normalizePath(f);
    fileSet.add(filename);
  }
  const uniqueFiles = Array.from(fileSet);
  const uniqueDirectories = Array.from(directorySet).filter((dir) => dir && dir !== '/');
  let commonPrefix = options?.preserveProjectPaths ? '/' : '';
  if (!commonPrefix) {
    const prefixSources = uniqueFiles.length > 0 ? uniqueFiles.map((f) => vfs.dirname(f)) : uniqueDirectories;
    commonPrefix = prefixSources[0] ?? '/';
    while (commonPrefix) {
      if (prefixSources.every((p) => p.startsWith(commonPrefix))) {
        break;
      }
      commonPrefix = vfs.dirname(commonPrefix);
    }
  }
  if (commonPrefix && !commonPrefix.endsWith('/')) {
    commonPrefix += '/';
  }
  const directoryEntries = uniqueDirectories
    .map((dir) => dir.slice(commonPrefix.length))
    .filter((dir) => !!dir)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return {
    commonPrefix,
    directoryEntries,
    uniqueFiles
  };
}
