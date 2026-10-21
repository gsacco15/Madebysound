import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples } from '../js/analysis.js';
import { makeDNA, describe, pitchHue, hueName, fingerprint } from '../js/dna.js';
import { SR, clickTrack, chordSequence, noise, mix } from './synth.mjs';

const Am = [57, 60, 64];
const Dm = [50, 53, 57];
const E = [52, 56, 59];

const songA = () => mix(clickTrack(124, 10), chordSequence([Am, Dm, E, Am, Am, Dm, E, Am], 124));
const songB = () => mix(noise(10, 'brown'), clickTrack(84, 10, 3));

test('the same song always makes the same note', async () => {
  const a = makeDNA(await analyzeSamples(songA(), SR));
  const b = makeDNA(await analyzeSamples(songA(), SR));
  assert.deepEqual(a, b);
  assert.match(a.id, /^[0-9A-F]{8}$/);
});

test('different songs make different notes', async () => {
  const fa = await analyzeSamples(songA(), SR);
  const fb = await analyzeSamples(songB(), SR);
  const a = makeDNA(fa);
  const b = makeDNA(fb);
  assert.notEqual(a.id, b.id);
  assert.notEqual(fingerprint(fa), fingerprint(fb));
  assert.ok(b.headSize > a.headSize, 'the bassier song has heavier heads');
});

test('saved features rebuild the identical note', async () => {
  const features = await analyzeSamples(songA(), SR);
  const restored = JSON.parse(JSON.stringify(features));
  assert.deepEqual(makeDNA(restored), makeDNA(features));
});

test('dna stays inside the ranges the shader expects', async () => {
  for (const signal of [songA(), songB(), new Float32Array(SR * 3)]) {
    const d = makeDNA(await analyzeSamples(signal, SR));
    assert.ok(d.headSize >= 0.29 && d.headSize <= 0.4);
    assert.ok(d.stemHeight >= 1.3 && d.stemHeight <= 1.7);
    assert.ok([1, 2].includes(d.beams));
    assert.ok(d.liquidity >= 0.06 && d.liquidity <= 0.28);
    assert.ok(d.hue >= 0 && d.hue < 1);
    assert.equal(d.envelope.length, 32);
    assert.ok(Number.isFinite(d.pulse) && d.pulse > 0);
  }
});

test('keys a fifth apart sit next to each other in hue', () => {
  const step = (a, b) => {
    const d = Math.abs(pitchHue(a) - pitchHue(b));
    return Math.min(d, 1 - d);
  };
  assert.ok(Math.abs(step(0, 7) - 1 / 12) < 1e-9);
  assert.ok(step(0, 6) > 0.49);
  assert.equal(typeof hueName(pitchHue(9)), 'string');
});

test('describe explains every mapping', async () => {
  const f = await analyzeSamples(songA(), SR);
  const rows = describe(f, makeDNA(f));
  assert.deepEqual(rows.map((r) => r.label), ['Key', 'Tempo', 'Low end', 'Attack', 'Brightness', 'Dynamics']);
  for (const r of rows) assert.ok(r.value && r.effect);
});
