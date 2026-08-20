import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, 'dist');
const manifestPath = path.join(projectRoot, 'manifest.json');

await mkdir(outputDir, { recursive: true });
await mkdir(path.join(outputDir, 'src'), { recursive: true });
await mkdir(path.join(outputDir, 'icons'), { recursive: true });
await cp(manifestPath, path.join(outputDir, 'manifest.json'));
await cp(path.join(projectRoot, 'src'), path.join(outputDir, 'src'), { recursive: true });
await cp(path.join(projectRoot, 'icons'), path.join(outputDir, 'icons'), { recursive: true });

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const references = new Set();

if (manifest.background?.service_worker) references.add(manifest.background.service_worker);
if (manifest.action?.default_popup) references.add(manifest.action.default_popup);
for (const file of Object.values(manifest.action?.default_icon || {})) references.add(file);
for (const file of Object.values(manifest.icons || {})) references.add(file);
if (manifest.options_page) references.add(manifest.options_page);
for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) references.add(file);
  for (const file of script.css || []) references.add(file);
}
for (const entry of manifest.web_accessible_resources || []) {
  for (const file of entry.resources || []) references.add(file);
}

for (const reference of references) {
  const target = path.join(outputDir, reference);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Manifest reference is not a file: ${reference}`);
}

console.log(`Built TransLens ${manifest.version} in ${path.relative(projectRoot, outputDir)}/`);
