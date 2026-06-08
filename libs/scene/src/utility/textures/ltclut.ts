import type { Texture2D } from '@zephyr3d/device';
import { getDevice } from '../../app/api';
import { LTC_AMP_LUT_BASE64, LTC_LUT_SIZE, LTC_MAT_LUT_BASE64 } from './ltcdata';

const LUT_SIZE = LTC_LUT_SIZE;
let ltcMatLut: Texture2D | null = null;
let ltcAmpLut: Texture2D | null = null;

function decodeBase64(base64: string) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const out: number[] = [];
  let i = 0;
  while (i < clean.length) {
    const enc1 = chars.indexOf(clean.charAt(i++));
    const enc2 = chars.indexOf(clean.charAt(i++));
    const enc3 = chars.indexOf(clean.charAt(i++));
    const enc4 = chars.indexOf(clean.charAt(i++));
    const chr1 = (enc1 << 2) | (enc2 >> 4);
    const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    const chr3 = ((enc3 & 3) << 6) | enc4;
    out.push(chr1);
    if (enc3 !== 64) {
      out.push(chr2);
    }
    if (enc4 !== 64) {
      out.push(chr3);
    }
  }
  return new Uint8Array(out);
}

function createTexture(base64: string, name: string) {
  const data = decodeBase64(base64);
  if (data.byteLength !== LUT_SIZE * LUT_SIZE * 4) {
    throw new Error(`createTexture(): invalid LTC LUT size for ${name}`);
  }
  const device = getDevice();
  const tex = device.createTexture2D('rgba8unorm', LUT_SIZE, LUT_SIZE, { mipmapping: false })!;
  tex.update(data, 0, 0, LUT_SIZE, LUT_SIZE);
  tex.name = name;
  return tex;
}

function createLTCTextures() {
  ltcMatLut = createTexture(LTC_MAT_LUT_BASE64, 'LTC_Mat');
  ltcAmpLut = createTexture(LTC_AMP_LUT_BASE64, 'LTC_Amp');
}

export function getLTCMatLUT() {
  if (!ltcMatLut) {
    createLTCTextures();
  }
  return ltcMatLut!;
}

export function getLTCAmpLUT() {
  if (!ltcAmpLut) {
    createLTCTextures();
  }
  return ltcAmpLut!;
}
