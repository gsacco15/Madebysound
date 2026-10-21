// Renders the app icons from the glass note itself (Glass Lullaby's DNA, oil bath, clear glass).
// Needs Playwright and the app served on port 5173 (`npm start`):  node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(url);
const icons = await page.evaluate(async () => {
  const { NoteRenderer } = await import('./js/renderer.js');
  const { makeDNA } = await import('./js/dna.js');
  const { DEMO_FEATURES } = await import('./js/demo-features.js');
  const canvas = document.createElement('canvas');
  const renderer = new NoteRenderer(canvas);
  renderer.setDNA(makeDNA(DEMO_FEATURES['glass-lullaby']), { instant: true });
  Object.assign(renderer.camera, { yaw: -0.18, pitch: 0.16, zoom: 1.08 });
  Object.assign(renderer.live, { bass: 0.25, mid: 0.1, high: 0.05, beat: 0, level: 0.3 });
  const big = renderer.snapshot(2.0, 512);
  const out = {};
  for (const size of [512, 192, 180]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(big, 0, 0, size, size);
    out[size] = c.toDataURL('image/png');
  }
  return out;
});
await browser.close();
for (const [size, data] of Object.entries(icons)) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), Buffer.from(data.split(',')[1], 'base64'));
}
console.log('Wrote icons', Object.keys(icons).join(', '));
