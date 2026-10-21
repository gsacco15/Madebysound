import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeShare, decodeShare } from '../js/share.js';
import { paletteFromPixels } from '../js/palette.js';
import { makeDNA } from '../js/dna.js';
import { DEMO_FEATURES } from '../js/demo-features.js';

test('a share link rebuilds the identical note', () => {
  for (const features of Object.values(DEMO_FEATURES)) {
    const token = encodeShare(features, 'Night Drive — demo ✨');
    assert.match(token, /^n1[A-Za-z0-9_-]+$/, 'fragment uses only URL-safe characters');
    assert.ok(token.length < 260);
    const back = decodeShare(token);
    assert.equal(back.title, 'Night Drive — demo ✨');
    assert.deepEqual(back.features, features);
    assert.deepEqual(makeDNA(back.features), makeDNA(features));
  }
});

test('bad share links are ignored', () => {
  assert.equal(decodeShare(''), null);
  assert.equal(decodeShare('settings'), null);
  assert.equal(decodeShare('n1!!!'), null);
  assert.equal(decodeShare('n1AAAA'), null);
});

function image(colors) {
  const px = [];
  for (const [rgb, count] of colors) for (let i = 0; i < count; i++) px.push(...rgb, 255);
  return Uint8ClampedArray.from(px);
}

test('album art palette finds the dominant and a contrasting hue', () => {
  const p = paletteFromPixels(image([[[220, 40, 40], 600], [[40, 90, 220], 250], [[20, 20, 20], 300]]));
  assert.ok(p.hue < 0.03 || p.hue > 0.97, `red expected, got ${p.hue}`);
  assert.ok(Math.abs(p.hue2 - 0.62) < 0.05, `blue expected, got ${p.hue2}`);
  assert.ok(p.saturation >= 0.4 && p.saturation <= 0.9);
});

test('grey artwork gives no palette', () => {
  assert.equal(paletteFromPixels(image([[[128, 128, 128], 500], [[250, 250, 250], 500]])), null);
});
