// Builds the page body for publishing madebysound as a claude.ai artifact: the host supplies the
// document skeleton, so this emits the head bits, inlined CSS and app markup. The JS modules are
// published alongside it unchanged.
//   node scripts/build-artifact.mjs [out-file]   (default: dist/artifact/index.html)
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = resolve(process.argv[2] || `${root}dist/artifact/index.html`);
const html = readFileSync(`${root}index.html`, 'utf8');
const css = readFileSync(`${root}css/app.css`, 'utf8');

function between(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`Missing ${start} / ${end} markers in index.html`);
  return html.slice(a + start.length, b).trim();
}

const page = [
  between('<!-- APP:HEAD -->', '<!-- APP:END-HEAD -->'),
  '<meta name="claude:viewport-fit-sides" content="cover">',
  `<style>\n${css}</style>`,
  between('<!-- APP:BODY -->', '<!-- APP:END-BODY -->'),
  '<script type="module" src="js/main.js"></script>',
  '',
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
const modules = readdirSync(`${root}js`).filter((f) => f.endsWith('.js'));
console.log(`Wrote ${out} (${page.length} bytes). Publish with these files alongside it:`);
for (const m of modules) console.log(`  js/${m}`);
