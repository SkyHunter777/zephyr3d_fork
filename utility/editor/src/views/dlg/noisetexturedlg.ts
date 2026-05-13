import { PathUtils, type VFS } from '@zephyr3d/base';
import { ImGui } from '@zephyr3d/imgui';
import { NoiseTextureCreator, type NoiseTextureFormat } from '../../components/noisetexture';
import { DialogRenderer } from '../../components/modal';
import { customTextInput } from '../../components/textinput';
import { DlgMessageBoxEx } from './messageexdlg';
import { DlgSaveFile } from './savefiledlg';

export type NoiseTextureDialogResult = {
  path: string;
  data: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function formatExtension(format: NoiseTextureFormat) {
  switch (format) {
    case 'jpeg':
      return '.jpg';
    case 'webp':
      return '.webp';
    default:
      return '.png';
  }
}

function formatFilter(format: NoiseTextureFormat) {
  switch (format) {
    case 'jpeg':
      return 'JPEG (*.jpg;*.jpeg)|*.jpg;*.jpeg';
    case 'webp':
      return 'WebP (*.webp)|*.webp';
    default:
      return 'PNG (*.png)|*.png';
  }
}

export class DlgNoiseTextureCreator extends DialogRenderer<NoiseTextureDialogResult | null> {
  private readonly _vfs: VFS;
  private readonly _creator: NoiseTextureCreator;
  private readonly _baseDir: string;
  private _path: string;
  private _lastFormat: NoiseTextureFormat;
  private _error = '';
  private _busy = false;

  static async createNoiseTexture(
    title: string,
    vfs: VFS,
    initialDirectory: string,
    width?: number,
    height?: number
  ) {
    return new DlgNoiseTextureCreator(title, vfs, initialDirectory, width, height).showModal();
  }

  constructor(id: string, vfs: VFS, initialDirectory: string, width = 920, height = 620) {
    super(id, width, height);
    this._vfs = vfs;
    this._baseDir = PathUtils.normalize(initialDirectory || '/assets');
    this._creator = new NoiseTextureCreator();
    this._lastFormat = this._creator.format;
    this._path = this.normalizePathForFormat(PathUtils.join(this._baseDir, 'noise-texture'));
  }

  close(result: NoiseTextureDialogResult | null) {
    this._creator.dispose();
    super.close(result);
  }

  doRender(): void {
    this.syncPathWithFormat();

    const path = [this._path] as [string];
    if (customTextInput('##FilePath', path, '/assets/noise-texture')) {
      this._path = path[0];
      this._error = '';
    }
    ImGui.SameLine();
    if (ImGui.Button('Browse...') && !this._busy) {
      this.selectPath();
    }
    ImGui.TextDisabled('Output file must stay under /assets');

    const bodyHeight = Math.max(
      180,
      ImGui.GetContentRegionAvail().y - ImGui.GetFrameHeightWithSpacing() * 2 - 16
    );
    if (ImGui.BeginChild('##NoiseTextureBody', new ImGui.ImVec2(0, bodyHeight), false)) {
      this._creator.render();
    }
    ImGui.EndChild();

    if (this._error) {
      ImGui.TextColored(new ImGui.ImVec4(0.9, 0.25, 0.25, 1), this._error);
    }

    if (ImGui.Button('Randomize') && !this._busy) {
      this._creator.randomizeSeed();
      this._error = '';
    }
    ImGui.SameLine();
    if (ImGui.Button(this._busy ? 'Generating...' : 'Create') && !this._busy) {
      this.confirmAndClose();
    }
    ImGui.SameLine();
    if (ImGui.Button('Cancel') && !this._busy) {
      this.close(null);
    }
  }

  private syncPathWithFormat() {
    if (this._lastFormat === this._creator.format) {
      return;
    }
    this._path = this.normalizePathForFormat(this._path);
    this._lastFormat = this._creator.format;
  }

  private normalizePathForFormat(path: string) {
    path = (path || '').trim();
    if (!path) {
      return '';
    }
    const normalized = PathUtils.isAbsolute(path)
      ? PathUtils.normalize(path)
      : PathUtils.join(this._baseDir, path);
    const ext = PathUtils.extname(normalized).toLowerCase();
    const targetExt = formatExtension(this._creator.format);
    if (IMAGE_EXTENSIONS.has(ext)) {
      return `${normalized.slice(0, -ext.length)}${targetExt}`;
    }
    return `${normalized}${targetExt}`;
  }

  private async selectPath() {
    const path = await DlgSaveFile.saveFile(
      'Select Noise Texture Output',
      this._vfs,
      '/assets',
      formatFilter(this._creator.format),
      560,
      420
    );
    if (path) {
      this._path = this.normalizePathForFormat(path);
      this._error = '';
    }
  }

  private async confirmAndClose() {
    const normalizedPath = this.normalizePathForFormat(this._path);
    const validationError = await this.validatePath(normalizedPath);
    if (validationError) {
      this._error = validationError;
      return;
    }

    if (await this._vfs.exists(normalizedPath)) {
      const stat = await this._vfs.stat(normalizedPath);
      if (stat.isDirectory) {
        this._error = 'Selected output path is a directory';
        return;
      }
      const overwrite = await DlgMessageBoxEx.messageBoxEx(
        'Overwrite File',
        `'${PathUtils.basename(normalizedPath)}' already exists, do you want to overwrite it?`,
        ['Yes', 'No']
      );
      if (overwrite !== 'Yes') {
        return;
      }
    }

    this._busy = true;
    this._error = '';
    try {
      const result = await this._creator.encodeOutput();
      this.close({
        path: normalizedPath,
        data: result.data,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height
      });
    } catch (err) {
      this._busy = false;
      this._error = `Generate noise texture failed: ${err}`;
    }
  }

  private async validatePath(path: string) {
    if (!path) {
      return 'Please input a file path';
    }
    if (!PathUtils.isAbsolute(path)) {
      return 'File path must be absolute';
    }
    if (path !== '/assets' && !path.startsWith('/assets/')) {
      return 'File path must stay under /assets';
    }
    const filename = PathUtils.basename(path);
    if (!filename) {
      return 'Please select a valid file path';
    }
    if (PathUtils.sanitizeFilename(filename) !== filename) {
      return 'File name contains invalid characters';
    }
    const parent = PathUtils.dirname(path);
    if (!(await this._vfs.exists(parent))) {
      return 'Target directory does not exist';
    }
    const stat = await this._vfs.stat(parent);
    if (!stat.isDirectory) {
      return 'Target directory is invalid';
    }
    return '';
  }
}
