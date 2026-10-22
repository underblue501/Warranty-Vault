import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const INDEX = path.join(root, 'index.html');

/* Chrome derives an unpacked extension's id from the absolute path: sha256,
   first 32 hex digits, each mapped 0-f -> a-p. */
function unpackedId(absPath){
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...hash].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

test('the build emits everything the manifest references', () => {
  const { dist, manifest, files } = build({ writeZip: false });
  assert.equal(manifest.manifest_version, 3);

  for(const name of ['manifest.json', 'index.html', 'app.css', 'app.js', 'launch.html', 'launch.js']){
    assert.ok(files.includes(name), `${name} is in the package`);
    assert.ok(fs.existsSync(path.join(dist, name)), `${name} exists on disk`);
  }
  // Every icon the manifest names must actually ship.
  for(const rel of Object.values(manifest.icons)){
    assert.ok(fs.existsSync(path.join(dist, rel)), `${rel} exists`);
  }
  for(const rel of Object.values(manifest.action.default_icon)){
    assert.ok(fs.existsSync(path.join(dist, rel)), `action ${rel} exists`);
  }
  assert.ok(fs.existsSync(path.join(dist, manifest.action.default_popup)));
});

test('nothing inline survives, because extension CSP would block it', () => {
  const { dist } = build({ writeZip: false });
  for(const name of ['index.html', 'launch.html']){
    const html = fs.readFileSync(path.join(dist, name), 'utf8');
    assert.doesNotMatch(html, /<style[^>]*>/, `${name} has no inline <style>`);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, `${name} has no inline <script>`);
    assert.doesNotMatch(html, /\son\w+\s*=/, `${name} has no inline event handler`);
  }
});

test('the extracted code is the app, unaltered', () => {
  const { dist } = build({ writeZip: false });
  const source = fs.readFileSync(INDEX, 'utf8');
  const js = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(dist, 'app.css'), 'utf8');

  assert.equal(js, source.match(/<script>([\s\S]*?)<\/script>/)[1].trim() + '\n');
  assert.equal(css, source.match(/<style>([\s\S]*?)<\/style>/)[1].trim() + '\n');
  // Spot-check that real behaviour came across rather than an empty file.
  for(const marker of ['parseLocalDate', 'buildIcs', 'normaliseImported', 'extStorage']){
    assert.match(js, new RegExp(marker), `app.js contains ${marker}`);
  }
});

test('host access is requested only when a scan backend is configured', () => {
  const original = fs.readFileSync(INDEX, 'utf8');
  try{
    assert.equal(build({ writeZip: false }).manifest.host_permissions, undefined,
      'no backend configured means no host permission');

    fs.writeFileSync(INDEX, original.replace(
      '<meta name="scan-endpoint" content="">',
      '<meta name="scan-endpoint" content="https://scan.example.workers.dev/scan">'));
    assert.deepEqual(build({ writeZip: false }).manifest.host_permissions,
      ['https://scan.example.workers.dev/*'],
      'the configured origin is requested, not the whole web');

    fs.writeFileSync(INDEX, original.replace(
      '<meta name="scan-endpoint" content="">',
      '<meta name="scan-endpoint" content="not a url">'));
    assert.throws(() => build({ writeZip: false }), /not a valid URL/,
      'a malformed endpoint fails the build rather than shipping broken');
  } finally {
    fs.writeFileSync(INDEX, original);
  }
});

test('the zip is a readable archive with intact contents', () => {
  const { zipPath, dist } = build({ writeZip: true });
  const buf = fs.readFileSync(zipPath);

  // Walk the local headers, inflate each entry, check its CRC and bytes.
  let offset = 0, seen = 0;
  while(buf.readUInt32LE(offset) === 0x04034b50){
    const method = buf.readUInt16LE(offset + 8);
    const crc = buf.readUInt32LE(offset + 14);
    const csize = buf.readUInt32LE(offset + 18);
    const usize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const start = offset + 30 + nameLen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;

    assert.equal(data.length, usize, `${name} length`);
    assert.equal(zlib.crc32(data), crc, `${name} checksum`);
    assert.deepEqual(data, fs.readFileSync(path.join(dist, name)), `${name} matches dist`);
    offset = start + csize;
    seen++;
  }
  assert.equal(seen, 12, 'every file is in the archive');
  assert.equal(buf.readUInt32LE(offset), 0x02014b50, 'central directory follows the entries');
});

test('the packaged extension loads and runs in a real browser', async () => {
  const { dist } = build({ writeZip: false });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-ext-'));
  const context = await chromium.launchPersistentContext(profile, {
    // The default headless shell cannot load extensions; the full Chromium
    // build can, and `playwright install chromium` provides it.
    channel: 'chromium',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`]
  });
  try{
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });

    await page.goto(`chrome-extension://${unpackedId(dist)}/index.html`);
    await page.waitForSelector('#addBtn', { timeout: 10000 });

    // If CSP had blocked app.js, none of this would be defined.
    assert.equal(await page.evaluate(() => typeof parseLocalDate), 'function',
      'the external app.js executed under extension CSP');
    assert.equal(await page.evaluate(() => extStorage !== null), true,
      'the extension storage tier is active, not the localStorage fallback');

    await page.fill('#fName', 'Bosch dishwasher');
    await page.fill('#fDate', '2026-01-31');
    await page.selectOption('#fMonths', '24');
    await page.click('#addBtn');
    await page.waitForSelector('.receipt');

    const stored = await page.evaluate(async () => {
      const api = globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local;
      const r = await api.get('vault-items');
      return r['vault-items'];
    });
    assert.ok(stored, 'the item went to chrome.storage.local');
    const parsed = JSON.parse(stored);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'Bosch dishwasher');

    await page.reload();
    await page.waitForSelector('.receipt');
    assert.deepEqual(await page.locator('.rc-name').allTextContents(), ['Bosch dishwasher'],
      'it survives a reload from extension storage');
    assert.match(await page.textContent('.rc-meta'), /Jan 31, 2028/, 'dates still correct');
    assert.deepEqual(errors, [], 'no CSP violations or page errors');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
