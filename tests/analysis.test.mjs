import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples, estimateKey } from '../js/analysis.js';
import { fft } from '../js/fft.js';
import { SR, clickTrack, chordSequence, noise, mix } from './synth.mjs';

// Voiced around middle C: pitch is read above ~180 Hz, where semitones resolve.
const Am = [57, 60, 64, 69];
const Dm = [62, 65, 69];
const E = [64, 68, 71];
const C = [60, 64, 67];
const F = [65, 69, 72];
const G = [62, 67, 71];

test('fft puts a sine in the right bin', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
  fft(re, im);
  const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
  assert.equal(mags.indexOf(Math.max(...mags)), 37);
  assert.ok(Math.abs(mags[37] - n / 2) < 1e-6);
});

for (const bpm of [90, 120, 150]) {
  test(`finds ${bpm} BPM in a click track`, async () => {
    const f = await analyzeSamples(clickTrack(bpm, 12), SR);
    assert.ok(Math.abs(f.tempo - bpm) < 2, `got ${f.tempo}`);
    assert.ok(Math.abs(f.onsetRate - bpm / 60) < 0.25, `onset rate ${f.onsetRate}`);
  });
}

test('names the key of a chord progression', async () => {
  const minor = await analyzeSamples(chordSequence([Am, Am, Dm, E, Am, Dm, E, Am], 100), SR);
  assert.deepEqual([minor.key.tonic, minor.key.mode], [9, 'minor']);
  const major = await analyzeSamples(chordSequence([C, F, G, C, C, F, G, C], 100), SR);
  assert.deepEqual([major.key.tonic, major.key.mode], [0, 'major']);
});

test('separates dark and bright sounds', async () => {
  const dark = await analyzeSamples(noise(6, 'brown'), SR);
  const bright = await analyzeSamples(noise(6, 'hiss'), SR);
  assert.ok(bright.brightness > dark.brightness);
  assert.ok(dark.bands.bass > bright.bands.bass);
  assert.ok(bright.bands.air > dark.bands.air);
});

test('is deterministic and returns a compact shape', async () => {
  const signal = mix(clickTrack(128, 10), chordSequence([Am, Dm, E, Am, Am, Dm, E, Am], 128));
  const a = await analyzeSamples(signal, SR);
  const b = await analyzeSamples(signal.slice(), SR);
  assert.deepEqual(a, b);
  assert.equal(a.envelope.length, 32);
  assert.equal(a.chroma.length, 12);
  assert.ok(Math.abs(Object.values(a.bands).reduce((s, v) => s + v, 0) - 1) < 0.01);
  assert.ok(JSON.stringify(a).length < 1200);
});

test('survives silence and very short input', async () => {
  const quiet = await analyzeSamples(new Float32Array(SR * 2), SR);
  assert.equal(quiet.tempo, 0);
  assert.equal(quiet.onsetRate, 0);
  assert.ok(quiet.envelope.every((v) => v === 0));
  const tiny = await analyzeSamples(new Float32Array(300).fill(0.1), SR);
  assert.equal(tiny.envelope.length, 32);
});

test('key estimate of empty chroma falls back to C major', () => {
  assert.deepEqual(estimateKey(new Array(12).fill(0)), { tonic: 0, mode: 'major', confidence: 0 });
});
