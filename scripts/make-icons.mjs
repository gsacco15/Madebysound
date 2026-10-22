// Renders the app icons and the link-preview card from the Tile view itself (Glass Lullaby's note, oil
// bath, clear glass). Needs Playwright and the app served on port 5173 (`npm start`):
//   node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.APP_URL || 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto(new URL('manifest.webmanifest', url).href);
const images = await page.evaluate(async () => {
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400&family=Geist:wght@400&family=Instrument+Serif:ital@0;1&display=block';
  document.head.append(fonts);
  await new Promise((resolve) => (fonts.onload = resolve));
  await Promise.all(['96px "Instrument Serif"', 'italic 96px "Instrument Serif"', '32px Geist', '21px "Geist Mono"'].map((f) => document.fonts.load(f)));

  const { NoteRenderer } = await import('./js/renderer.js');
  const { makeDNA } = await import('./js/dna.js');
  const { DEMO_FEATURES } = await import('./js/demo-features.js');
  const renderer = new NoteRenderer(document.createElement('canvas'));
  renderer.setDNA(makeDNA(DEMO_FEATURES['glass-lullaby']), { instant: true });
  Object.assign(renderer.live, { bass: 0.2, mid: 0, high: 0, beat: 0, level: 0.3 });
  const png = (canvas) => canvas.toDataURL('image/png');
  const jpeg = (canvas) => canvas.toDataURL('image/jpeg', 0.9);
  const out = {};

  // The icon: the glass tile nearly filling the square, a sliver of oil around it.
  renderer.camera.zoom = 1.22;
  const big = renderer.snapshot(2.0, 1024);
  for (const size of [512, 192, 180]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(big, 0, 0, size, size);
    out[`icon-${size}`] = png(c);
  }

  // The link preview: the tile on the left, the wordmark and tagline on the right.
  const W = 1200;
  const H = 630;
  renderer.camera.zoom = 1.12;
  const card = document.createElement('canvas');
  card.width = W;
  card.height = H;
  const g = card.getContext('2d');
  g.drawImage(renderer.snapshot(2.0, W, H, [-0.42, 0]), 0, 0);
  const shade = g.createLinearGradient(560, 0, W, 0);
  shade.addColorStop(0, 'rgba(7, 8, 11, 0)');
  shade.addColorStop(0.35, 'rgba(7, 8, 11, 0.7)');
  shade.addColorStop(1, 'rgba(7, 8, 11, 0.85)');
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
  const x = 636;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#eef1f7';
  g.font = '96px "Instrument Serif"';
  g.fillText('made', x, 278);
  let cx = x + g.measureText('made').width;
  g.font = 'italic 96px "Instrument Serif"';
  g.fillStyle = 'hsl(175 72% 70%)';
  g.fillText('by', cx, 278);
  cx += g.measureText('by').width + 3;
  g.font = '96px "Instrument Serif"';
  g.fillStyle = '#eef1f7';
  g.fillText('sound', cx, 278);
  g.font = '32px Geist';
  g.fillStyle = '#c3c8d4';
  g.fillText('Every song sculpts its own', x + 3, 340);
  g.fillText('liquid-glass music note.', x + 3, 384);
  g.font = '21px "Geist Mono"';
  g.fillStyle = '#7d8495';
  g.fillText('madebysound.vercel.app', x + 3, 456);
  out.og = jpeg(card);
  return out;
});
await browser.close();
const files = Object.entries(images).map(([name, data]) => [`icons/${name}.${data.startsWith('data:image/jpeg') ? 'jpg' : 'png'}`, data]);
for (const [file, data] of files) writeFileSync(new URL(`../${file}`, import.meta.url), Buffer.from(data.split(',')[1], 'base64'));
console.log('Wrote', files.map(([file]) => file).join(', '));
