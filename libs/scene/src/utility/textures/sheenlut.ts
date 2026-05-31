import type { Texture2D } from '@zephyr3d/device';
import { float2half } from '@zephyr3d/base';
import { getDevice } from '../../app/api';

const charlieLuts: Map<number, Texture2D> = new Map();
const sheenELuts: Map<number, Texture2D> = new Map();
const SAMPLE_COUNT = 512;
const TWO_PI = Math.PI * 2;
const SHEEN_E_MIN_ALPHA_G = 0.07;

export function getCharlieLUT(size: number): Texture2D {
  let lut = charlieLuts.get(size);
  if (!lut) {
    lut = createCharlieLUT(size);
    charlieLuts.set(size, lut);
  }
  return lut;
}

export function getSheenELUT(size: number): Texture2D {
  let lut = sheenELuts.get(size);
  if (!lut) {
    lut = createSheenELUT(size);
    sheenELuts.set(size, lut);
  }
  return lut;
}

function createCharlieLUT(size: number) {
  const tex = getDevice().createTexture2D('rgba16f', size, size, { mipmapping: false })!;
  const image = new Uint16Array(size * size * 4);
  const one = float2half(1);
  let p = 0;
  for (let y = size - 1; y >= 0; y--) {
    const roughness = clamp01((y + 0.5) / size);
    for (let x = 0; x < size; x++) {
      const NoV = clamp01((x + 0.5) / size);
      const brdf = integrateCharlieBRDF(NoV, roughness);
      image[p++] = 0;
      image[p++] = 0;
      image[p++] = toHalf(brdf);
      image[p++] = one;
    }
  }
  tex.update(image, 0, 0, size, size);
  tex.name = 'CharlieLUT';
  return tex;
}

function createSheenELUT(size: number) {
  const tex = getDevice().createTexture2D('rgba16f', size, size, { mipmapping: false })!;
  const image = new Uint16Array(size * size * 4);
  const one = float2half(1);
  let p = 0;
  for (let y = size - 1; y >= 0; y--) {
    const roughness = clamp01((y + 0.5) / size);
    const alphaG = Math.max(roughness * roughness, SHEEN_E_MIN_ALPHA_G);
    for (let x = 0; x < size; x++) {
      const NoV = clamp01((x + 0.5) / size);
      const e = integrateSheenAlbedo(NoV, alphaG);
      image[p++] = toHalf(e);
      image[p++] = 0;
      image[p++] = 0;
      image[p++] = one;
    }
  }
  tex.update(image, 0, 0, size, size);
  tex.name = 'SheenELUT';
  return tex;
}

function integrateCharlieBRDF(NoV: number, roughness: number) {
  let sum = 0;
  const Vx = Math.sqrt(Math.max(0, 1 - NoV * NoV));
  const Vz = NoV;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const u = hammersley(i, SAMPLE_COUNT);
    const phi = TWO_PI * u[0];
    const cosTheta = 1 - u[1];
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const Hx = sinTheta * Math.cos(phi);
    const Hz = cosTheta;
    const VoH = Math.max(Vx * Hx + Vz * Hz, 0);
    const Lz = 2 * VoH * Hz - Vz;
    const NoL = Math.max(Lz, 0);
    if (NoL > 0 && VoH > 0) {
      sum += visibilitySheen(NoL, NoV, roughness) * distributionCharlie(Hz, roughness) * NoL * VoH;
    }
  }
  return sum * ((4 * TWO_PI) / SAMPLE_COUNT);
}

function integrateSheenAlbedo(NoV: number, alphaG: number) {
  let sum = 0;
  const Vx = Math.sqrt(Math.max(0, 1 - NoV * NoV));
  const Vz = NoV;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const u = hammersley(i, SAMPLE_COUNT);
    const phi = TWO_PI * u[0];
    const NoL = 1 - u[1];
    const sinTheta = Math.sqrt(Math.max(0, 1 - NoL * NoL));
    const Lx = sinTheta * Math.cos(phi);
    const Ly = sinTheta * Math.sin(phi);
    const Lz = NoL;
    const Hx = Lx + Vx;
    const Hy = Ly;
    const Hz = Lz + Vz;
    const invLenH = 1 / Math.max(Math.sqrt(Hx * Hx + Hy * Hy + Hz * Hz), 1e-6);
    const NoH = Math.max(Hz * invLenH, 0);
    sum += distributionCharlieAlphaG(NoH, alphaG) * visibilitySheenAlphaG(NoL, NoV, alphaG) * NoL;
  }
  return clamp01(sum * (TWO_PI / SAMPLE_COUNT));
}

function distributionCharlie(NoH: number, sheenRoughness: number) {
  const roughness = Math.max(sheenRoughness, 1e-6);
  return distributionCharlieAlphaG(NoH, roughness * roughness);
}

function distributionCharlieAlphaG(NoH: number, alphaG: number) {
  alphaG = Math.max(alphaG, 1e-6);
  const invR = 1 / alphaG;
  const sin2h = Math.max(1 - NoH * NoH, 0);
  return ((2 + invR) * Math.pow(sin2h, invR * 0.5)) / TWO_PI;
}

function visibilitySheen(NoL: number, NoV: number, sheenRoughness: number) {
  const roughness = Math.max(sheenRoughness, 1e-6);
  return visibilitySheenAlphaG(NoL, NoV, roughness * roughness);
}

function visibilitySheenAlphaG(NoL: number, NoV: number, alphaG: number) {
  alphaG = Math.max(alphaG, 1e-6);
  const denom = (1 + lambdaSheen(NoV, alphaG) + lambdaSheen(NoL, alphaG)) * (4 * NoV * NoL);
  return denom > 0 ? clamp01(1 / denom) : 0;
}

function lambdaSheen(cosTheta: number, alphaG: number) {
  const c = Math.abs(cosTheta);
  return c < 0.5
    ? Math.exp(lambdaSheenNumericHelper(c, alphaG))
    : Math.exp(2 * lambdaSheenNumericHelper(0.5, alphaG) - lambdaSheenNumericHelper(1 - c, alphaG));
}

function lambdaSheenNumericHelper(x: number, alphaG: number) {
  const oneMinusAlphaSq = (1 - alphaG) * (1 - alphaG);
  const a = mix(21.5473, 25.3245, oneMinusAlphaSq);
  const b = mix(3.82987, 3.32435, oneMinusAlphaSq);
  const c = mix(0.19823, 0.16801, oneMinusAlphaSq);
  const d = mix(-1.9776, -1.27393, oneMinusAlphaSq);
  const e = mix(-4.32054, -4.85967, oneMinusAlphaSq);
  return a / (1 + b * Math.pow(x, c)) + d * x + e;
}

function hammersley(i: number, sampleCount: number) {
  return [i / sampleCount, radicalInverseVdC(i)] as const;
}

function radicalInverseVdC(bits: number) {
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

function mix(x: number, y: number, a: number) {
  return x * (1 - a) + y * a;
}

function clamp01(v: number) {
  return Math.min(Math.max(v, 0), 1);
}

function toHalf(v: number) {
  return float2half(Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 65504));
}
