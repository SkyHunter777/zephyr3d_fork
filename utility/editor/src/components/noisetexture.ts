import { Disposable } from '@zephyr3d/base';
import type { Texture2D } from '@zephyr3d/device';
import { ImGui } from '@zephyr3d/imgui';
import { getDevice } from '@zephyr3d/scene';

export type NoiseTextureFormat = 'png' | 'jpeg' | 'webp';
export type NoiseTextureImageType = 'grayscale' | 'rgb';
export type NoiseTextureType = 'perlin' | 'worley' | 'blue-noise';

export type NoiseTextureSettings = {
  width: number;
  height: number;
  format: NoiseTextureFormat;
  imageType: NoiseTextureImageType;
  noiseType: NoiseTextureType;
  tileable: boolean;
  quality: number;
  perlin: {
    seed: number;
    scale: number;
    octaves: number;
    persistence: number;
    lacunarity: number;
  };
  worley: {
    seed: number;
    cells: number;
    jitter: number;
    invert: boolean;
  };
  blueNoise: {
    seed: number;
    radius: number;
    iterations: number;
  };
};

export type NoiseTextureOutput = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
};

const PREVIEW_MAX_SIZE = 256;
const MAX_TEXTURE_SIZE = 4096;
const FORMAT_LABELS = ['PNG', 'JPEG', 'WebP'];
const IMAGE_TYPE_LABELS = ['Grayscale', 'RGB'];
const NOISE_TYPE_LABELS = ['Perlin Noise', 'Worley Noise', 'Blue Noise'];
const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function wrapIndex(value: number, size: number) {
  const r = value % size;
  return r < 0 ? r + size : r;
}

function fade(value: number) {
  return value * value * (3 - 2 * value);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function normalizedToByte(value: number) {
  return Math.round(clamp(value, 0, 1) * 255);
}

function mixSeed(seed: number, salt: number) {
  let x = (seed | 0) ^ Math.imul((salt | 0) + 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash3(x: number, y: number, seed: number) {
  let h = mixSeed(seed, x);
  h = mixSeed(h, y);
  return h >>> 0;
}

function hash01(x: number, y: number, seed: number) {
  return hash3(x, y, seed) / 0xffffffff;
}

function gradient2D(x: number, y: number, seed: number) {
  const angle = hash01(x, y, seed) * TAU;
  return [Math.cos(angle), Math.sin(angle)] as const;
}

function perlinBase(x: number, y: number, seed: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const sx = x - x0;
  const sy = y - y0;
  const u = fade(sx);
  const v = fade(sy);

  const g00 = gradient2D(x0, y0, seed);
  const g10 = gradient2D(x1, y0, seed);
  const g01 = gradient2D(x0, y1, seed);
  const g11 = gradient2D(x1, y1, seed);

  const n00 = g00[0] * sx + g00[1] * sy;
  const n10 = g10[0] * (sx - 1) + g10[1] * sy;
  const n01 = g01[0] * sx + g01[1] * (sy - 1);
  const n11 = g11[0] * (sx - 1) + g11[1] * (sy - 1);

  const nx0 = lerp(n00, n10, u);
  const nx1 = lerp(n01, n11, u);
  return lerp(nx0, nx1, v);
}

function perlinFBM(
  x: number,
  y: number,
  seed: number,
  scale: number,
  octaves: number,
  persistence: number,
  lacunarity: number
) {
  let amplitude = 1;
  let frequency = Math.max(scale, 0.0001);
  let total = 0;
  let weight = 0;
  for (let i = 0; i < octaves; i++) {
    total += perlinBase(x * frequency, y * frequency, seed + i * 1619) * amplitude;
    weight += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  const normalized = weight > 0 ? total / weight : 0;
  return clamp(normalized * 0.7 + 0.5, 0, 1);
}

function worley2D(x: number, y: number, seed: number, cells: number, jitter: number, invert: boolean) {
  const px = x * cells;
  const py = y * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const safeJitter = clamp(jitter, 0, 1);
  let minDistSq = Number.POSITIVE_INFINITY;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const rx = hash01(cx, cy, seed) - 0.5;
      const ry = hash01(cx, cy, seed ^ 0x68bc21eb) - 0.5;
      const fx = cx + 0.5 + rx * safeJitter;
      const fy = cy + 0.5 + ry * safeJitter;
      const dx = px - fx;
      const dy = py - fy;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDistSq) {
        minDistSq = distSq;
      }
    }
  }
  let value = 1 - clamp(Math.sqrt(minDistSq) / Math.SQRT2, 0, 1);
  if (invert) {
    value = 1 - value;
  }
  return value;
}

function boxBlurToroidal(src: Float32Array, width: number, height: number, radius: number) {
  if (radius <= 0) {
    return src.slice();
  }
  const size = radius * 2 + 1;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += src[rowOffset + wrapIndex(k, width)];
    }
    for (let x = 0; x < width; x++) {
      tmp[rowOffset + x] = sum / size;
      sum += src[rowOffset + wrapIndex(x + radius + 1, width)];
      sum -= src[rowOffset + wrapIndex(x - radius, width)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += tmp[wrapIndex(k, height) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += tmp[wrapIndex(y + radius + 1, height) * width + x];
      sum -= tmp[wrapIndex(y - radius, height) * width + x];
    }
  }
  return out;
}

function equalizeApprox(values: Float32Array, bins = 2048) {
  const count = values.length;
  if (count <= 1) {
    return values.slice();
  }
  const safeBins = Math.max(32, bins | 0);
  const histogram = new Uint32Array(safeBins);
  const offsets = new Uint32Array(safeBins);
  const seen = new Uint32Array(safeBins);
  for (let i = 0; i < count; i++) {
    const bin = clamp((values[i] * (safeBins - 1)) | 0, 0, safeBins - 1);
    histogram[bin]++;
  }
  let acc = 0;
  for (let i = 0; i < safeBins; i++) {
    offsets[i] = acc;
    acc += histogram[i];
  }
  const out = new Float32Array(count);
  const inv = 1 / Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const bin = clamp((values[i] * (safeBins - 1)) | 0, 0, safeBins - 1);
    const rank = offsets[bin] + seen[bin]++;
    out[i] = rank * inv;
  }
  return out;
}

function boxBlurClamp(src: Float32Array, width: number, height: number, radius: number) {
  if (radius <= 0) {
    return src.slice();
  }
  const size = radius * 2 + 1;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += src[rowOffset + clamp(k, 0, width - 1)];
    }
    for (let x = 0; x < width; x++) {
      tmp[rowOffset + x] = sum / size;
      sum += src[rowOffset + clamp(x + radius + 1, 0, width - 1)];
      sum -= src[rowOffset + clamp(x - radius, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += tmp[clamp(k, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += tmp[clamp(y + radius + 1, 0, height - 1) * width + x];
      sum -= tmp[clamp(y - radius, 0, height - 1) * width + x];
    }
  }
  return out;
}

function createBlueNoise(
  width: number,
  height: number,
  seed: number,
  radius: number,
  iterations: number,
  tileable: boolean
) {
  const count = width * height;
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    values[i] = hash01(x, y, seed);
  }
  let current = equalizeApprox(values);
  const safeRadius = clamp(radius | 0, 1, 16);
  const safeIterations = clamp(iterations | 0, 1, 32);
  for (let iter = 0; iter < safeIterations; iter++) {
    const blurred = tileable
      ? boxBlurToroidal(current, width, height, safeRadius)
      : boxBlurClamp(current, width, height, safeRadius);
    for (let i = 0; i < count; i++) {
      current[i] = clamp(0.5 + (current[i] - blurred[i]) * 2.2, 0, 1);
    }
    current = equalizeApprox(current);
  }
  return current;
}

function encodeMimeType(format: NoiseTextureFormat) {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function createRandomSeed() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] & 0x7fffffff;
  }
  return (Math.random() * 0x7fffffff) | 0;
}

export class NoiseTextureCreator extends Disposable {
  private readonly _settings: NoiseTextureSettings;
  private _previewTexture: Texture2D = null;
  private _previewDirty = true;
  private _previewWidth = 0;
  private _previewHeight = 0;
  private _previewTiling = false;
  private _previewRepeat = 3;

  constructor(settings?: Partial<NoiseTextureSettings>) {
    super();
    this._settings = {
      width: 512,
      height: 512,
      format: 'png',
      imageType: 'grayscale',
      noiseType: 'perlin',
      tileable: false,
      quality: 92,
      perlin: {
        seed: 1,
        scale: 8,
        octaves: 4,
        persistence: 0.5,
        lacunarity: 2
      },
      worley: {
        seed: 1,
        cells: 8,
        jitter: 1,
        invert: false
      },
      blueNoise: {
        seed: 1,
        radius: 3,
        iterations: 8
      }
    };
    Object.assign(this._settings, settings);
    if (settings?.perlin) {
      Object.assign(this._settings.perlin, settings.perlin);
    }
    if (settings?.worley) {
      Object.assign(this._settings.worley, settings.worley);
    }
    if (settings?.blueNoise) {
      Object.assign(this._settings.blueNoise, settings.blueNoise);
    }
    this.clampSettings();
  }

  get settings() {
    return this._settings;
  }

  get format() {
    return this._settings.format;
  }

  set format(value: NoiseTextureFormat) {
    if (this._settings.format !== value) {
      this._settings.format = value;
      this.markDirty();
    }
  }

  randomizeSeed() {
    const seed = createRandomSeed();
    switch (this._settings.noiseType) {
      case 'perlin':
        this._settings.perlin.seed = seed;
        break;
      case 'worley':
        this._settings.worley.seed = seed;
        break;
      case 'blue-noise':
        this._settings.blueNoise.seed = seed;
        break;
    }
    this.markDirty();
  }

  render() {
    this.clampSettings();
    if (
      ImGui.BeginChild(
        '##NoiseTextureSettings',
        new ImGui.ImVec2(300, 0),
        true,
        ImGui.WindowFlags.NoScrollbar
      )
    ) {
      this.renderSettings();
    }
    ImGui.EndChild();
    ImGui.SameLine();
    if (ImGui.BeginChild('##NoiseTexturePreview', new ImGui.ImVec2(0, 0), true)) {
      this.renderPreview();
    }
    ImGui.EndChild();
  }

  async encodeOutput() {
    const output = this.generateOutput(this._settings.width, this._settings.height);
    const canvas = document.createElement('canvas');
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context is unavailable');
    }
    const imageData = new ImageData(output.rgba, output.width, output.height);
    ctx.putImageData(imageData, 0, 0);
    const mimeType = encodeMimeType(this._settings.format);
    const quality = this._settings.format === 'png' ? undefined : this._settings.quality / 100;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (value) {
            resolve(value);
          } else {
            reject(new Error('Image encoding failed'));
          }
        },
        mimeType,
        quality
      );
    });
    return {
      width: output.width,
      height: output.height,
      mimeType,
      data: await blob.arrayBuffer()
    };
  }

  protected onDispose() {
    super.onDispose();
    this._previewTexture?.dispose();
    this._previewTexture = null;
  }

  private renderSettings() {
    const formatIndex = [this.getFormatIndex()] as [number];
    if (ImGui.Combo('File Type', formatIndex, FORMAT_LABELS)) {
      this._settings.format = ['png', 'jpeg', 'webp'][formatIndex[0]] as NoiseTextureFormat;
    }

    if (this._settings.format !== 'png') {
      const quality = [this._settings.quality] as [number];
      if (ImGui.SliderInt('Quality', quality, 1, 100)) {
        this._settings.quality = quality[0];
      }
    }

    const imageTypeIndex = [this._settings.imageType === 'rgb' ? 1 : 0] as [number];
    if (ImGui.Combo('Image Type', imageTypeIndex, IMAGE_TYPE_LABELS)) {
      this._settings.imageType = imageTypeIndex[0] === 0 ? 'grayscale' : 'rgb';
      this.markDirty();
    }

    const tileable = [this._settings.tileable] as [boolean];
    if (ImGui.Checkbox('Tileable', tileable)) {
      this._settings.tileable = tileable[0];
      this.markDirty();
    }

    const width = [this._settings.width] as [number];
    if (ImGui.InputInt('Width', width, 16, 128)) {
      this._settings.width = width[0];
      this.markDirty();
    }
    const height = [this._settings.height] as [number];
    if (ImGui.InputInt('Height', height, 16, 128)) {
      this._settings.height = height[0];
      this.markDirty();
    }

    ImGui.Separator();

    const noiseTypeIndex = [this.getNoiseTypeIndex()] as [number];
    if (ImGui.Combo('Noise Type', noiseTypeIndex, NOISE_TYPE_LABELS)) {
      this._settings.noiseType = ['perlin', 'worley', 'blue-noise'][noiseTypeIndex[0]] as NoiseTextureType;
      this.markDirty();
    }

    switch (this._settings.noiseType) {
      case 'perlin':
        this.renderPerlinSettings();
        break;
      case 'worley':
        this.renderWorleySettings();
        break;
      case 'blue-noise':
        this.renderBlueNoiseSettings();
        break;
    }
  }

  private renderPerlinSettings() {
    ImGui.TextDisabled('Perlin Settings');

    const seed = [this._settings.perlin.seed] as [number];
    if (ImGui.InputInt('Seed', seed, 1, 16)) {
      this._settings.perlin.seed = seed[0];
      this.markDirty();
    }

    const scale = [this._settings.perlin.scale] as [number];
    if (ImGui.InputFloat('Scale', scale, 0.5, 2)) {
      this._settings.perlin.scale = scale[0];
      this.markDirty();
    }

    const octaves = [this._settings.perlin.octaves] as [number];
    if (ImGui.InputInt('Octaves', octaves, 1, 2)) {
      this._settings.perlin.octaves = octaves[0];
      this.markDirty();
    }

    const persistence = [this._settings.perlin.persistence] as [number];
    if (ImGui.InputFloat('Persistence', persistence, 0.05, 0.2)) {
      this._settings.perlin.persistence = persistence[0];
      this.markDirty();
    }

    const lacunarity = [this._settings.perlin.lacunarity] as [number];
    if (ImGui.InputFloat('Lacunarity', lacunarity, 0.1, 0.5)) {
      this._settings.perlin.lacunarity = lacunarity[0];
      this.markDirty();
    }
  }

  private renderWorleySettings() {
    ImGui.TextDisabled('Worley Settings');

    const seed = [this._settings.worley.seed] as [number];
    if (ImGui.InputInt('Seed', seed, 1, 16)) {
      this._settings.worley.seed = seed[0];
      this.markDirty();
    }

    const cells = [this._settings.worley.cells] as [number];
    if (ImGui.InputInt('Cells', cells, 1, 4)) {
      this._settings.worley.cells = cells[0];
      this.markDirty();
    }

    const jitter = [this._settings.worley.jitter] as [number];
    if (ImGui.InputFloat('Jitter', jitter, 0.05, 0.2)) {
      this._settings.worley.jitter = jitter[0];
      this.markDirty();
    }

    const invert = [this._settings.worley.invert] as [boolean];
    if (ImGui.Checkbox('Invert', invert)) {
      this._settings.worley.invert = invert[0];
      this.markDirty();
    }
  }

  private renderBlueNoiseSettings() {
    ImGui.TextDisabled('Blue Noise Settings');

    const seed = [this._settings.blueNoise.seed] as [number];
    if (ImGui.InputInt('Seed', seed, 1, 16)) {
      this._settings.blueNoise.seed = seed[0];
      this.markDirty();
    }

    const radius = [this._settings.blueNoise.radius] as [number];
    if (ImGui.InputInt('Radius', radius, 1, 2)) {
      this._settings.blueNoise.radius = radius[0];
      this.markDirty();
    }

    const iterations = [this._settings.blueNoise.iterations] as [number];
    if (ImGui.InputInt('Iterations', iterations, 1, 4)) {
      this._settings.blueNoise.iterations = iterations[0];
      this.markDirty();
    }
  }

  private renderPreview() {
    ImGui.Text(
      `Preview (${Math.min(this._settings.width, PREVIEW_MAX_SIZE)} x ${Math.min(this._settings.height, PREVIEW_MAX_SIZE)})`
    );
    const previewTiling = [this._previewTiling] as [boolean];
    if (ImGui.Checkbox('Preview Tiling', previewTiling)) {
      this._previewTiling = previewTiling[0];
    }
    if (this._previewTiling) {
      ImGui.SameLine();
      const repeat = [this._previewRepeat] as [number];
      if (ImGui.SliderInt('Repeat', repeat, 2, 6)) {
        this._previewRepeat = repeat[0];
      }
    }
    ImGui.Separator();
    this.updatePreviewIfNeeded();
    if (!this._previewTexture) {
      ImGui.TextDisabled('Preview unavailable');
      return;
    }
    const avail = ImGui.GetContentRegionAvail();
    const aspect = this._previewHeight > 0 ? this._previewWidth / this._previewHeight : 1;
    let drawWidth = Math.max(1, avail.x);
    let drawHeight = drawWidth / aspect;
    if (drawHeight > avail.y) {
      drawHeight = Math.max(1, avail.y);
      drawWidth = drawHeight * aspect;
    }
    if (this._previewTiling) {
      this.renderTiledPreview(drawWidth, drawHeight, this._previewRepeat);
    } else {
      ImGui.Image(this._previewTexture, new ImGui.ImVec2(drawWidth, drawHeight));
    }
  }

  private updatePreviewIfNeeded() {
    if (!this._previewDirty) {
      return;
    }
    const previewWidth = Math.max(1, Math.min(this._settings.width, PREVIEW_MAX_SIZE));
    const previewHeight = Math.max(1, Math.min(this._settings.height, PREVIEW_MAX_SIZE));
    const output = this.generateOutput(previewWidth, previewHeight);
    if (
      !this._previewTexture ||
      this._previewWidth !== output.width ||
      this._previewHeight !== output.height
    ) {
      this._previewTexture?.dispose();
      this._previewTexture = getDevice().createTexture2D('rgba8unorm', output.width, output.height, {
        mipmapping: false
      });
      this._previewWidth = output.width;
      this._previewHeight = output.height;
    }
    this._previewTexture.update(output.rgba, 0, 0, output.width, output.height);
    this._previewDirty = false;
  }

  private generateOutput(width: number, height: number): NoiseTextureOutput {
    const rgba = new Uint8ClampedArray(width * height * 4) as Uint8ClampedArray<ArrayBuffer>;
    if (this._settings.noiseType === 'blue-noise') {
      this.fillBlueNoiseOutput(rgba, width, height);
      return {
        width,
        height,
        rgba
      };
    }
    const grayscale = this._settings.imageType === 'grayscale';
    const invWidth = width > 1 ? 1 / (width - 1) : 0;
    const invHeight = height > 1 ? 1 / (height - 1) : 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = x * invWidth;
        const v = y * invHeight;
        const pixelIndex = y * width + x;
        const valueR = this.sampleNoise(u, v, 0);
        const valueG = grayscale ? valueR : this.sampleNoise(u, v, 1);
        const valueB = grayscale ? valueR : this.sampleNoise(u, v, 2);
        const dst = pixelIndex * 4;
        rgba[dst] = normalizedToByte(valueR);
        rgba[dst + 1] = normalizedToByte(valueG);
        rgba[dst + 2] = normalizedToByte(valueB);
        rgba[dst + 3] = 255;
      }
    }
    return {
      width,
      height,
      rgba
    };
  }

  private getBlueNoiseChannel(width: number, height: number, channel: number) {
    return createBlueNoise(
      width,
      height,
      mixSeed(this._settings.blueNoise.seed, channel * 9719),
      this._settings.blueNoise.radius,
      this._settings.blueNoise.iterations,
      this._settings.tileable
    );
  }

  private sampleNoise(u: number, v: number, channel: number) {
    switch (this._settings.noiseType) {
      case 'perlin':
        return this._settings.tileable
          ? this.sampleTileablePerlin(u, v, channel)
          : this.samplePerlin(u, v, channel);
      case 'worley':
        return this._settings.tileable
          ? this.sampleTileableWorley(u, v, channel)
          : this.sampleWorley(u, v, channel);
      default:
        return 0;
    }
  }

  private samplePerlin(u: number, v: number, channel: number) {
    return perlinFBM(
      u,
      v,
      mixSeed(this._settings.perlin.seed, channel * 1103),
      this._settings.perlin.scale,
      this._settings.perlin.octaves,
      this._settings.perlin.persistence,
      this._settings.perlin.lacunarity
    );
  }

  private sampleWorley(u: number, v: number, channel: number) {
    return worley2D(
      u,
      v,
      mixSeed(this._settings.worley.seed, channel * 1823),
      this._settings.worley.cells,
      this._settings.worley.jitter,
      this._settings.worley.invert
    );
  }

  private sampleTileablePerlin(u: number, v: number, channel: number) {
    return this.sampleTileable2D(u, v, (uu, vv) => this.samplePerlin(uu, vv, channel));
  }

  private sampleTileableWorley(u: number, v: number, channel: number) {
    return this.sampleTileable2D(u, v, (uu, vv) => this.sampleWorley(uu, vv, channel));
  }

  private sampleTileable2D(u: number, v: number, sampler: (u: number, v: number) => number) {
    const tx = fade(clamp(u, 0, 1));
    const ty = fade(clamp(v, 0, 1));
    const c00 = sampler(u, v);
    const c10 = sampler(u - 1, v);
    const c01 = sampler(u, v - 1);
    const c11 = sampler(u - 1, v - 1);
    return lerp(lerp(c00, c10, tx), lerp(c01, c11, tx), ty);
  }

  private fillBlueNoiseOutput(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
    const grayscale = this._settings.imageType === 'grayscale';
    const firstChannel = this.getBlueNoiseChannel(width, height, 0);
    this.copyChannelToRGBA(rgba, firstChannel, 0);
    this.copyChannelToRGBA(rgba, firstChannel, 1);
    this.copyChannelToRGBA(rgba, firstChannel, 2);
    if (!grayscale) {
      this.copyChannelToRGBA(rgba, this.getBlueNoiseChannel(width, height, 1), 1);
      this.copyChannelToRGBA(rgba, this.getBlueNoiseChannel(width, height, 2), 2);
    }
    for (let i = 3; i < rgba.length; i += 4) {
      rgba[i] = 255;
    }
  }

  private copyChannelToRGBA(
    rgba: Uint8ClampedArray<ArrayBuffer>,
    values: Float32Array,
    channelIndex: 0 | 1 | 2
  ) {
    let dst = channelIndex;
    for (let i = 0; i < values.length; i++, dst += 4) {
      rgba[dst] = normalizedToByte(values[i]);
    }
  }

  private renderTiledPreview(drawWidth: number, drawHeight: number, repeat: number) {
    const safeRepeat = clamp(repeat | 0, 2, 6);
    const size = new ImGui.ImVec2(drawWidth, drawHeight);
    const pos = ImGui.GetCursorScreenPos();
    ImGui.InvisibleButton('##NoiseTextureTiledPreview', size, 0);
    const drawList = ImGui.GetWindowDrawList();
    const min = pos;
    const max = new ImGui.ImVec2(pos.x + drawWidth, pos.y + drawHeight);
    const backgroundColor = ImGui.GetColorU32(new ImGui.ImVec4(0.12, 0.12, 0.12, 1));
    const borderColor = ImGui.GetColorU32(new ImGui.ImVec4(0.3, 0.3, 0.3, 1));
    drawList.AddRectFilled(min, max, backgroundColor, 4);

    const tileWidth = drawWidth / safeRepeat;
    const tileHeight = drawHeight / safeRepeat;
    for (let y = 0; y < safeRepeat; y++) {
      for (let x = 0; x < safeRepeat; x++) {
        const tileMin = new ImGui.ImVec2(pos.x + x * tileWidth, pos.y + y * tileHeight);
        const tileMax = new ImGui.ImVec2(tileMin.x + tileWidth, tileMin.y + tileHeight);
        drawList.AddImage(this._previewTexture, tileMin, tileMax);
      }
    }
    drawList.AddRect(min, max, borderColor, 4, ImGui.DrawCornerFlags.None, 1);
  }

  private clampSettings() {
    this._settings.width = clamp(this._settings.width | 0, 1, MAX_TEXTURE_SIZE);
    this._settings.height = clamp(this._settings.height | 0, 1, MAX_TEXTURE_SIZE);
    this._settings.tileable = !!this._settings.tileable;
    this._settings.quality = clamp(this._settings.quality | 0, 1, 100);
    this._settings.perlin.seed |= 0;
    this._settings.perlin.scale = clamp(
      Number.isFinite(this._settings.perlin.scale) ? this._settings.perlin.scale : 8,
      0.01,
      256
    );
    this._settings.perlin.octaves = clamp(this._settings.perlin.octaves | 0, 1, 8);
    this._settings.perlin.persistence = clamp(
      Number.isFinite(this._settings.perlin.persistence) ? this._settings.perlin.persistence : 0.5,
      0.05,
      1
    );
    this._settings.perlin.lacunarity = clamp(
      Number.isFinite(this._settings.perlin.lacunarity) ? this._settings.perlin.lacunarity : 2,
      1,
      6
    );
    this._settings.worley.seed |= 0;
    this._settings.worley.cells = clamp(this._settings.worley.cells | 0, 1, 128);
    this._settings.worley.jitter = clamp(
      Number.isFinite(this._settings.worley.jitter) ? this._settings.worley.jitter : 1,
      0,
      1
    );
    this._settings.worley.invert = !!this._settings.worley.invert;
    this._settings.blueNoise.seed |= 0;
    this._settings.blueNoise.radius = clamp(this._settings.blueNoise.radius | 0, 1, 16);
    this._settings.blueNoise.iterations = clamp(this._settings.blueNoise.iterations | 0, 1, 32);
  }

  private getFormatIndex() {
    switch (this._settings.format) {
      case 'jpeg':
        return 1;
      case 'webp':
        return 2;
      default:
        return 0;
    }
  }

  private getNoiseTypeIndex() {
    switch (this._settings.noiseType) {
      case 'worley':
        return 1;
      case 'blue-noise':
        return 2;
      default:
        return 0;
    }
  }

  private markDirty() {
    this.clampSettings();
    this._previewDirty = true;
  }
}
