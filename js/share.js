// Share links: a note's features (and its title) packed into the URL fragment, so anyone can open the
// same glass without the audio. Values are stored at the precision analysis.js rounds to, so the
// rebuilt note is identical. Base64url keeps the fragment to letters, digits, "-" and "_".

const VERSION = 1;
const BANDS = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air'];
export const SHARE_PREFIX = 'n1';

function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function encodeShare(features, title = '') {
  const name = new TextEncoder().encode(title).slice(0, 80);
  const buf = new ArrayBuffer(160 + name.length);
  const v = new DataView(buf);
  let p = 0;
  const u8 = (x) => v.setUint8(p++, x);
  const u16 = (x) => {
    v.setUint16(p, x);
    p += 2;
  };
  const i16 = (x) => {
    v.setInt16(p, x);
    p += 2;
  };
  const u32 = (x) => {
    v.setUint32(p, x);
    p += 4;
  };
  const r = Math.round;
  u8(VERSION);
  u8(features.version);
  u32(r(features.duration * 100));
  for (const b of BANDS) u16(r(features.bands[b] * 10000));
  u32(r(features.centroidHz * 10));
  u16(r(features.brightness * 10000));
  u16(r(features.flatness * 10000));
  i16(r(features.loudness * 100));
  u16(r(features.dynamicRange * 100));
  u32(r(features.onsetRate * 1000));
  u16(r(features.tempo * 10));
  u16(r(features.tempoConfidence * 1000));
  u8(features.key.tonic);
  u8(features.key.mode === 'minor' ? 1 : 0);
  u16(r(features.key.confidence * 1000));
  for (const c of features.chroma) u16(r(c * 1000));
  for (const e of features.envelope) u16(r(e * 1000));
  u8(name.length);
  new Uint8Array(buf, p, name.length).set(name);
  p += name.length;
  return SHARE_PREFIX + toBase64Url(new Uint8Array(buf, 0, p));
}

export function decodeShare(token) {
  if (!token || !token.startsWith(SHARE_PREFIX)) return null;
  try {
    const bytes = fromBase64Url(token.slice(SHARE_PREFIX.length));
    const v = new DataView(bytes.buffer);
    let p = 0;
    const u8 = () => v.getUint8(p++);
    const u16 = () => {
      p += 2;
      return v.getUint16(p - 2);
    };
    const i16 = () => {
      p += 2;
      return v.getInt16(p - 2);
    };
    const u32 = () => {
      p += 4;
      return v.getUint32(p - 4);
    };
    if (u8() !== VERSION) return null;
    const features = { version: u8(), duration: u32() / 100, bands: {} };
    for (const b of BANDS) features.bands[b] = u16() / 10000;
    features.centroidHz = u32() / 10;
    features.brightness = u16() / 10000;
    features.flatness = u16() / 10000;
    features.loudness = i16() / 100;
    features.dynamicRange = u16() / 100;
    features.onsetRate = u32() / 1000;
    features.tempo = u16() / 10;
    features.tempoConfidence = u16() / 1000;
    const tonic = u8();
    const mode = u8() ? 'minor' : 'major';
    features.key = { tonic, mode, confidence: u16() / 1000 };
    features.chroma = Array.from({ length: 12 }, () => u16() / 1000);
    features.envelope = Array.from({ length: 32 }, () => u16() / 1000);
    const len = u8();
    const title = new TextDecoder().decode(bytes.subarray(p, p + len));
    if (tonic > 11 || features.envelope.some((e) => e > 1)) return null;
    return { features, title };
  } catch {
    return null;
  }
}
