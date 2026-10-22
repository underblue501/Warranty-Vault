/* Regenerates extension/icons/*.png from one SVG. Dev-only: run it when the
   mark changes. The build just copies the committed PNGs, so packaging needs
   no browser.
   Usage: node extension/tools/make-icons.mjs   (needs the root devDependency) */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const INK = '#1B2A4A', PAPER = '#FAFAF7', STAMP = '#C8102E', LINE = '#9FB0CE';

/* The receipt stub with its notched bottom edge is the app's own motif. At
   16px the notches and rules disappear, so the shapes are sized to stay
   legible as a silhouette rather than to be detailed. */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="26" fill="${INK}"/>
  <path d="M26 24h76v74l-6.3 6-6.4-6-6.3 6-6.4-6-6.3 6-6.4-6-6.3 6-6.4-6-6.3 6-6.4-6-6.5 6z" fill="${PAPER}"/>
  <rect x="38" y="40" width="52" height="8" rx="4" fill="${INK}"/>
  <rect x="38" y="56" width="34" height="7" rx="3.5" fill="${LINE}"/>
  <rect x="38" y="70" width="44" height="7" rx="3.5" fill="${LINE}"/>
  <circle cx="96" cy="34" r="15" fill="${STAMP}" stroke="${PAPER}" stroke-width="5"/>
</svg>`;

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);

const browser = await chromium.launch();
for (const size of [16, 32, 48, 96, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(outDir, `icon-${size}.png`), omitBackground: true });
  await page.close();
  console.log(`icon-${size}.png`);
}
await browser.close();
