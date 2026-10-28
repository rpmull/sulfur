// the page alone, for a mesh host to serve at /sulfur/: dist/ as one tarball, signed with the
// update key, and a feed entry naming it, its hash and signature
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const version = process.env.VERSION,
  repo = process.env.GITHUB_REPOSITORY;
if (!version || !repo) throw new Error('VERSION and GITHUB_REPOSITORY are required');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim())
  throw new Error('Signing the web build requires UPDATE_SIGNING_KEY');
const name = 'sulfur-web.tar.gz';
await mkdir('out/feed', { recursive: true });
const file = path.join('out', name);
await rm(file, { force: true });
// paths as a Phosphorus host serves them: sulfur/ under its mount, the rest at the site root;
// the extension host is the native app's alone. Sorted and unowned, so one commit tars the same
const tar = Bun.spawn(
  [
    'tar',
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mtime=@0',
    '--exclude=./sulfur-extension-host.mjs',
    '-czf',
    file,
    '-C',
    'dist',
    '.',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
if (await tar.exited) throw new Error('tar failed');
// the same signer the installers use; the key and its password from the environment
const sign = Bun.spawn(['bun', 'tauri', 'signer', 'sign', file], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (await sign.exited) throw new Error('signing failed');
const data = await readFile(file);
const signature = (await readFile(file + '.sig', 'utf8')).trim();
await writeFile(file + '.sig', signature + '\n');
const feed = {
  version,
  url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
  sha256: createHash('sha256').update(data).digest('hex'),
  signature,
};
await writeFile('out/feed/sulfur-web.json', JSON.stringify(feed) + '\n');
console.log(`${name}: ${data.length} bytes, sha256 ${feed.sha256}`);
