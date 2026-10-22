/* Packages index.html as a WebExtension.
 *
 * The app ships as one HTML file with an inline <style> and <script>, which
 * extension CSP forbids ("script-src 'self'"), so the build lifts both into
 * sibling files. Nothing else about the app changes, and index.html stays a
 * single standalone file for GitHub Pages.
 *
 *   node extension/build.mjs            -> extension/dist/ + the .zip
 *   node extension/build.mjs --no-zip   -> directory only
 *
 * No dependencies: Orion installs the directory directly, and the zip is for
 * the Chrome and Firefox stores.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');

const ICONS = ['16', '32', '48', '96', '128'];
const COPIED = ['launch.html', 'launch.css', 'launch.js'];

function splitSingleFileApp(html){
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if(!style) throw new Error('no inline <style> found in index.html');
  if(!script) throw new Error('no inline <script> found in index.html');

  const page = html
    .replace(style[0], '<link rel="stylesheet" href="app.css">')
    .replace(script[0], '<script src="app.js"></script>');

  // A second inline block would silently be left behind and blocked by CSP.
  if(/<style[^>]*>/.test(page)) throw new Error('index.html has more than one inline <style>');
  if(/<script(?![^>]*\ssrc=)[^>]*>/.test(page)) throw new Error('index.html has more than one inline <script>');

  return { page, css: style[1].trim() + '\n', js: script[1].trim() + '\n' };
}

/** The page only reaches the network if a scan backend is configured. */
function scanOrigin(html){
  const meta = html.match(/<meta\s+name="scan-endpoint"\s+content="([^"]*)"/);
  const value = meta && meta[1].trim();
  if(!value) return null;
  try { return new URL(value).origin + '/*'; }
  catch { throw new Error(`the scan-endpoint meta tag is not a valid URL: ${value}`); }
}

function buildManifest(html){
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
  const origin = scanOrigin(html);
  // Requested only when a backend is actually configured - an extension that
  // asks for host access it never uses is a worse review and a worse install
  // prompt.
  if(origin) manifest.host_permissions = [origin];
  return manifest;
}

/* ---- a minimal zip writer (store + deflate), so packaging needs no tools ---- */
function zip(files){
  const chunks = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = 0x21; // fixed stamp keeps builds reproducible

  for(const { name, data } of files){
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);          // external attributes
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

export function build({ writeZip = true } = {}){
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const { page, css, js } = splitSingleFileApp(html);
  const manifest = buildManifest(html);

  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });

  const files = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'index.html', data: Buffer.from(page) },
    { name: 'app.css', data: Buffer.from(css) },
    { name: 'app.js', data: Buffer.from(js) }
  ];
  for(const f of COPIED){
    files.push({ name: f, data: fs.readFileSync(path.join(here, f)) });
  }
  for(const size of ICONS){
    files.push({
      name: `icons/icon-${size}.png`,
      data: fs.readFileSync(path.join(here, 'icons', `icon-${size}.png`))
    });
  }

  for(const { name, data } of files){
    fs.writeFileSync(path.join(dist, name), data);
  }

  let zipPath = null;
  if(writeZip){
    zipPath = path.join(here, `warranty-vault-${manifest.version}.zip`);
    fs.writeFileSync(zipPath, zip(files));
  }
  return { dist, zipPath, manifest, files: files.map(f => f.name) };
}

if(import.meta.url === `file://${process.argv[1]}`){
  const result = build({ writeZip: !process.argv.includes('--no-zip') });
  console.log(`Warranty Vault ${result.manifest.version}`);
  console.log(`  ${result.files.length} files -> ${path.relative(root, result.dist)}/`);
  if(result.zipPath) console.log(`  zip        -> ${path.relative(root, result.zipPath)}`);
  if(result.manifest.host_permissions){
    console.log(`  host access -> ${result.manifest.host_permissions.join(', ')}`);
  } else {
    console.log('  host access -> none (no scan backend configured)');
  }
}
