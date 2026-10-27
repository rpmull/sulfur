import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const version = process.env.VERSION,
  repo = process.env.GITHUB_REPOSITORY;
if (!version || !repo) throw new Error('VERSION and GITHUB_REPOSITORY are required');
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64',
  os = process.platform === 'win32' ? 'windows' : process.platform;
await mkdir('out', { recursive: true });
await mkdir('out/feed', { recursive: true });
async function walk(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(file)));
    else out.push(file);
  }
  return out;
}
const bundle = await walk('src-tauri/target/release/bundle');
let updater;
for (const file of bundle) {
  if (!/\.(exe|dmg|deb|AppImage|app\.tar\.gz)$/.test(file)) continue;
  let name;
  if (file.endsWith('.exe')) name = `sulfur-windows-${arch}-setup.exe`;
  else if (file.endsWith('.app.tar.gz')) name = `sulfur-darwin-${arch}.app.tar.gz`;
  else if (file.endsWith('.dmg')) name = `sulfur-darwin-${arch}.dmg`;
  else if (file.endsWith('.deb'))
    name = `sulfur_${version}_${arch === 'x86_64' ? 'amd64' : 'arm64'}.deb`;
  else name = `sulfur-linux-${arch}.AppImage`;
  await copyFile(file, path.join('out', name));
  try {
    const signature = (await readFile(file + '.sig', 'utf8')).trim();
    await writeFile(path.join('out', name + '.sig'), signature + '\n');
    if (/\.(exe|app\.tar\.gz|AppImage)$/.test(file))
      updater = {
        version,
        url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
        signature,
      };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
if (!updater) throw new Error('No signed updater artifact was produced');
await writeFile(`out/feed/sulfur-${os}-${arch}.json`, JSON.stringify(updater) + '\n');
await copyFile('LICENSE', 'out/LICENSE');
await copyFile('THIRD_PARTY_LICENSES.txt', 'out/THIRD_PARTY_LICENSES.txt');
