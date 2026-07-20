// Packages the plugin for distribution: produces release/<id>-<version>.zip
// with manifest.json at the root, the built dist/ and the static ui/. Run
// `npm run package` (it builds first, then zips). Cross-platform via adm-zip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error('manifest.json not found in', root);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const { id, version } = manifest;
if (!id || !version) {
  console.error('manifest.json must define "id" and "version".');
  process.exit(1);
}

const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const zip = new AdmZip();
zip.addLocalFile(manifestPath); // manifest.json at the archive root
zip.addLocalFolder(distDir, 'dist'); // built code.js
const uiDir = path.join(root, 'ui');
if (fs.existsSync(uiDir)) zip.addLocalFolder(uiDir, 'ui'); // static panel
for (const extra of ['README.md', 'LICENSE']) {
  const p = path.join(root, extra);
  if (fs.existsSync(p)) zip.addLocalFile(p);
}

const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${id}-${version}.zip`);
zip.writeZip(outFile);
console.log(`Packaged ${path.relative(root, outFile)}`);
