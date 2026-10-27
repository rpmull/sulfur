import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const version = process.argv[2] || process.env.VERSION;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Pass a three-part release version');
const publicKey = process.env.SULFUR_UPDATE_PUBKEY?.trim();
if (!publicKey || !process.env.TAURI_SIGNING_PRIVATE_KEY)
  throw new Error('Release signing requires the existing Sulfur public and private update keys');
const keyBytes = Buffer.from(publicKey, 'base64');
const normalizedKey = publicKey.startsWith('untrusted comment:')
  ? Buffer.from(publicKey).toString('base64')
  : keyBytes.length === 42
    ? Buffer.from(`untrusted comment: Sulfur update key\n${publicKey}\n`).toString('base64')
    : publicKey;
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.version = version;
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
config.version = version;
await writeFile('src-tauri/tauri.conf.json', JSON.stringify(config, null, 2) + '\n');
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
await writeFile(
  'src-tauri/Cargo.toml',
  cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`),
);
const lock = await readFile('src-tauri/Cargo.lock', 'utf8');
await writeFile(
  'src-tauri/Cargo.lock',
  lock.replace(/(\[\[package\]\]\nname = "sulfur"\nversion = ")[^"]+/, `$1${version}`),
);
const release = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey: normalizedKey } },
};
if (process.platform === 'win32')
  release.bundle.windows = {
    signCommand: {
      cmd: 'bash',
      args: [path.resolve('packaging/winsign.sh').replaceAll('\\', '/'), '%1'],
    },
  };
await writeFile('src-tauri/tauri.release.conf.json', JSON.stringify(release, null, 2) + '\n');
console.log(version);
