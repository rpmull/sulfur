import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Metadata/downloads only. Never compiles dependencies or executes package scripts.
const supplied = process.argv.find((arg) => arg.startsWith('--metadata='))?.slice(11);
let metadata;
if (supplied) metadata = JSON.parse(await readFile(supplied, 'utf8'));
else {
  const cargo = Bun.spawn(
    [
      'cargo',
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--manifest-path',
      'src-tauri/Cargo.toml',
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const text = await new Response(cargo.stdout).text();
  if (await cargo.exited) throw new Error('cargo metadata failed');
  metadata = JSON.parse(text);
}
const licenseFile = /^(licen[sc]e|copying|notice|unlicense)([-._].*)?$/i,
  parts = [];
async function textsAt(folder, extra) {
  const names = (await readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isFile() && licenseFile.test(e.name))
    .map((e) => e.name);
  if (extra && !names.includes(extra)) names.push(extra);
  const out = [];
  for (const name of names.sort())
    try {
      out.push(await readFile(path.join(folder, name), 'utf8'));
    } catch {}
  return out;
}
for (const pkg of metadata.packages) {
  if (!pkg.source) continue;
  parts.push({
    name: `Rust: ${pkg.name}@${pkg.version}`,
    source: pkg.repository || `https://crates.io/crates/${pkg.name}/${pkg.version}`,
    license: pkg.license || '',
    texts: await textsAt(path.dirname(pkg.manifest_path), pkg.license_file),
  });
}
const seen = new Set();
async function npmPackages(folder) {
  for (const dir of await readdir(folder, { withFileTypes: true })) {
    if (dir.name.startsWith('.')) continue;
    const full = path.join(folder, dir.name);
    if (dir.name.startsWith('@')) {
      await npmPackages(full);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path.join(full, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // CLI binaries/types are build tools, not bundled application dependencies.
    if (
      !pkg.name.startsWith('@tauri-apps/cli') &&
      !pkg.name.startsWith('@types/') &&
      !['bun-types', 'prettier'].includes(pkg.name)
    )
      parts.push({
        name: `npm: ${id}`,
        source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
        license: pkg.license || '',
        texts: await textsAt(full),
      });
    await npmPackages(path.join(full, 'node_modules')).catch(() => {});
  }
}
await npmPackages('node_modules');
const bunVersion = JSON.parse(await readFile('package.json', 'utf8'))
  .packageManager.split('@')
  .at(-1);
await mkdir('.tools', { recursive: true });
const bunLicenseFile = `.tools/bun-${bunVersion}-LICENSE.md`;
let bunLicense;
try {
  bunLicense = await readFile(bunLicenseFile, 'utf8');
} catch {
  const response = await fetch(
    `https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`,
  );
  if (!response.ok) throw new Error('Cannot fetch pinned Bun license');
  bunLicense = await response.text();
  await writeFile(bunLicenseFile, bunLicense);
}
parts.push({
  name: `Runtime: Bun@${bunVersion}`,
  source: `https://github.com/oven-sh/bun/tree/bun-v${bunVersion}`,
  license: 'MIT and bundled component licenses',
  texts: [bunLicense],
});
const bodies = new Map();
let text =
  'Sulfur third-party notices\n\nGenerated from bun.lock, Cargo.lock and the pinned Bun runtime.\nSystem WebView implementations keep their system distributions and licenses.\nBun relinking/source instructions: docs/tauri-js.md.\n\n';
for (const part of parts.sort((a, b) => a.name.localeCompare(b.name))) {
  text += `${part.name}\n${part.source}\nLicense: ${part.license}\n`;
  if (!part.texts.length)
    text += 'License expression as published in the package metadata above.\n';
  for (const body of part.texts) {
    const key = createHash('sha256').update(body.trim()).digest('hex');
    if (bodies.has(key)) text += `Full text: see ${bodies.get(key)} below.\n`;
    else {
      bodies.set(key, part.name);
      text += `\n${body.trim()}\n`;
    }
  }
  text += '\n----------------------------------------------------------------\n\n';
}
await writeFile(
  'THIRD_PARTY_LICENSES.txt',
  text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd() + '\n',
);
console.log(`Recorded ${parts.length} dependencies and ${bodies.size} distinct license texts.`);
