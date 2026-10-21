// Full-track analysis: turns a song's samples into a compact, deterministic feature set.
// Pure JS with no browser APIs, so it runs the same in the app and in Node tests.

import { fft, hann } from './fft.js';

export const ANALYSIS_VERSION = 1;
export const ANALYSIS_SAMPLE_RATE = 22050;
const N = 2048;
const HOP = 512;
const MAX_SECONDS = 480;
const ENVELOPE_POINTS = 32;
const SILENCE = 1e-4;

export const BANDS = [
  ['sub', 20, 60],
  ['bass', 60, 250],
  ['lowMid', 250, 500],
  ['mid', 500, 2000],
  ['highMid', 2000, 6000],
  ['air', 6000, 11000],
];

// Krumhansl–Kessler key profiles, index 0 = tonic.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round = (v, d) => {
  const m = 10 ** d;
  return Math.round(v * m) / m;
};
const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

// Box-filter decimation to roughly 22.05 kHz. Plenty for the features we extract.
export function decimate(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / ANALYSIS_SAMPLE_RATE));
  if (factor === 1) return { samples, sampleRate };
  const n = Math.floor(samples.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * factor;
    for (let j = 0; j < factor; j++) s += samples[o + j];
    out[i] = s / factor;
  }
  return { samples: out, sampleRate: sampleRate / factor };
}

export async function analyzeSamples(input, inputRate, { onProgress, signal } = {}) {
  const { samples, sampleRate: sr } = decimate(input, inputRate);
  const len = Math.min(samples.length, Math.floor(MAX_SECONDS * sr));
  const frames = Math.max(1, Math.floor(Math.max(0, len - N) / HOP) + 1);
  const half = N / 2;
  const binHz = sr / N;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  const binBand = new Int8Array(half + 1).fill(-1);
  BANDS.forEach(([, lo, hi], b) => {
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k <= Math.min(half, Math.floor(hi / binHz)); k++) binBand[k] = b;
  });
  // Below ~180 Hz neighbouring semitones share a bin at this resolution, so pitch is read above it.
  const binPc = new Int8Array(half + 1).fill(-1);
  for (let k = 1; k <= half; k++) {
    const f = k * binHz;
    if (f >= 180 && f <= 4200) binPc[k] = (((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12);
  }
  const mag = new Float64Array(half + 2);
  const prevPeak = new Float64Array(half + 1);

  const rms = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const prevLog = new Float64Array(half + 1);
  const bandSum = new Float64Array(BANDS.length);
  const chroma = new Float64Array(12);
  let centroidSum = 0;
  let flatSum = 0;
  let weightSum = 0;

  for (let f = 0; f < frames; f++) {
    if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
    const start = f * HOP;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const v = idx < len ? samples[idx] : 0;
      sq += v * v;
      re[i] = v * win[i];
      im[i] = 0;
    }
    const r = Math.sqrt(sq / N);
    rms[f] = r;
    fft(re, im);

    const voiced = r > SILENCE;
    let fl = 0;
    let magSum = 0;
    let weighted = 0;
    let logPow = 0;
    let pow = 0;
    for (let k = 1; k <= half; k++) {
      // Scaled so a full-scale sine peaks near 1.
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 4);
      const lg = Math.log1p(100 * m);
      const d = lg - prevLog[k];
      if (d > 0) fl += d;
      prevLog[k] = lg;
      magSum += m;
      weighted += m * k * binHz;
      const p = m * m + 1e-12;
      logPow += Math.log(p);
      pow += p;
      const b = binBand[k];
      if (b >= 0) bandSum[b] += m;
      mag[k] = m;
    }
    // Pitch comes from spectral peaks that hold across two frames, so drums and noise barely count.
    for (let k = 2; k < half; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      const peak = Math.max(0, mag[k] - 0.5 * (mag[k - 2] + mag[k + 2]));
      if (voiced) chroma[pc] += Math.min(peak, prevPeak[k]);
      prevPeak[k] = peak;
    }
    flux[f] = f === 0 ? 0 : fl;
    if (voiced && magSum > 0) {
      centroidSum += (weighted / magSum) * r;
      flatSum += (Math.exp(logPow / half) / (pow / half)) * r;
      weightSum += r;
    }

    if (f % 512 === 511) {
      onProgress?.(f / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(1);

  const duration = len / sr;
  const fps = sr / HOP;

  const density = BANDS.map(([, lo, hi], b) => bandSum[b] / frames / Math.log2(hi / lo));
  const densityTotal = density.reduce((a, b) => a + b, 0) || 1;
  const bands = Object.fromEntries(BANDS.map(([name], b) => [name, round(density[b] / densityTotal, 4)]));

  const centroidHz = weightSum ? centroidSum / weightSum : 0;
  const brightness = clamp01((Math.log2(Math.max(centroidHz, 1)) - Math.log2(250)) / Math.log2(5000 / 250));
  const flatness = weightSum ? flatSum / weightSum : 0;

  const active = Array.from(rms).filter((v) => v > SILENCE).sort((a, b) => a - b);
  const pct = (p) => active[Math.min(active.length - 1, Math.floor(p * active.length))];
  const loudness = active.length ? toDb(active.reduce((a, b) => a + b, 0) / active.length) : -90;
  const dynamicRange = active.length ? toDb(pct(0.95)) - toDb(pct(0.1)) : 0;

  const { onsets, novelty } = detectOnsets(flux, fps);
  const tempo = estimateTempo(novelty, fps);
  const key = estimateKey(chroma);
  const chromaMax = Math.max(...chroma) || 1;

  return {
    version: ANALYSIS_VERSION,
    duration: round(duration, 2),
    bands,
    centroidHz: round(centroidHz, 1),
    brightness: round(brightness, 4),
    flatness: round(flatness, 4),
    loudness: round(loudness, 2),
    dynamicRange: round(dynamicRange, 2),
    onsetRate: round(onsets.length / Math.max(duration, 1e-3), 3),
    tempo: round(tempo.bpm, 1),
    tempoConfidence: round(tempo.confidence, 3),
    key: { tonic: key.tonic, mode: key.mode, confidence: round(key.confidence, 3) },
    chroma: Array.from(chroma, (v) => round(v / chromaMax, 3)),
    envelope: summarizeEnvelope(rms, ENVELOPE_POINTS).map((v) => round(v, 3)),
  };
}

export function detectOnsets(flux, fps) {
  const n = flux.length;
  const w = Math.max(1, Math.round(0.15 * fps));
  const minGap = Math.max(1, Math.round(0.09 * fps));
  const prefix = new Float64Array(n + 1);
  let max = 0;
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + flux[i];
    if (flux[i] > max) max = flux[i];
  }
  const novelty = new Float32Array(n);
  const onsets = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const local = (prefix[b] - prefix[a]) / (b - a);
    const nv = Math.max(0, flux[i] - local);
    novelty[i] = nv;
    const threshold = 0.5 * local + 0.05 * max + 1;
    const isPeak = flux[i] >= (i > 0 ? flux[i - 1] : 0) && flux[i] >= (i < n - 1 ? flux[i + 1] : 0);
    if (nv > threshold && isPeak && i - last >= minGap) {
      onsets.push(i);
      last = i;
    }
  }
  return { onsets, novelty };
}

// Autocorrelation of the onset novelty curve, scored over the beat, two beats and the bar,
// and weighted toward common tempos.
export function estimateTempo(novelty, frameRate) {
  if (novelty.length < frameRate * 4) return { bpm: 0, confidence: 0 };
  // Upsample 2x and soften so a tempo that falls between two lags is not split across them.
  const fps = frameRate * 2;
  const n = novelty.length * 2 - 1;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = i >> 1;
    x[i] = i % 2 ? (novelty[j] + novelty[j + 1]) / 2 : novelty[j];
  }
  const soft = new Float64Array(n);
  for (let i = 0; i < n; i++) soft[i] = (x[Math.max(0, i - 1)] + 2 * x[i] + x[Math.min(n - 1, i + 1)]) / 4;

  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 50);
  const acf = new Float64Array(4 * maxLag + 2);
  for (let lag = 0; lag < acf.length && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += soft[i] * soft[i + lag];
    acf[lag] = s / (n - lag);
  }
  if (acf[0] <= 0) return { bpm: 0, confidence: 0 };
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = (acf[lag] + 0.5 * acf[2 * lag] + 0.25 * acf[4 * lag]) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // When the half tempo pulses clearly harder, the faster pulse is a subdivision.
  const slower = best * 2;
  if ((60 * fps) / slower >= 70 && acf[slower] > acf[best] * 1.15) best = slower;

  const a = acf[best - 1];
  const b = acf[best];
  const c = acf[best + 1];
  const denom = a - 2 * b + c;
  const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return { bpm: (60 * fps) / (best + offset), confidence: clamp01(b / acf[0]) };
}

export function estimateKey(chroma) {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (total <= 0) return { tonic: 0, mode: 'major', confidence: 0 };
  let best = { tonic: 0, mode: 'major', confidence: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const c = pearson(rotated, profile);
      if (c > best.confidence) best = { tonic, mode, confidence: c };
    }
  }
  return { ...best, confidence: clamp01(best.confidence) };
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Loudness over the song's length, in 0..1 where 0 is 24 dB below the loudest stretch.
export function summarizeEnvelope(rms, points) {
  const out = new Array(points).fill(0);
  if (!rms.length) return out;
  const means = out.map((_, i) => {
    const a = Math.floor((i * rms.length) / points);
    const b = Math.max(a + 1, Math.floor(((i + 1) * rms.length) / points));
    let s = 0;
    for (let j = a; j < b && j < rms.length; j++) s += rms[j];
    return s / (b - a);
  });
  const max = Math.max(...means);
  if (max <= SILENCE) return out;
  return means.map((v) => clamp01(1 + toDb(v / max) / 24));
}

export async function analyzeAudioBuffer(buffer, options) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return analyzeSamples(mixToMono(channels), buffer.sampleRate, options);
}
