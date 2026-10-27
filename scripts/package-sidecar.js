import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  process.argv[2] ||
  {
    win32: process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc',
    darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
    linux: process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
  }[process.platform];
if (!target) throw new Error('Pass a target triple');
await mkdir('src-tauri/binaries', { recursive: true });
const outfile = path.resolve(
  `src-tauri/binaries/sulfur-service-${target}${target.includes('windows') ? '.exe' : ''}`,
);
const result = await Bun.build({
  entrypoints: ['server/main.js'],
  target: 'bun',
  compile: {
    outfile,
    execArgv: ['--no-install'],
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  minify: true,
  bytecode: true,
  define: {
    __SULFUR_COMPILED__: 'true',
    __SULFUR_UPDATE_FEED__: JSON.stringify(process.env.SULFUR_UPDATE_FEED || ''),
    __SULFUR_UPDATE_PUBKEY__: JSON.stringify(process.env.SULFUR_UPDATE_PUBKEY || ''),
  },
});
if (!result.success) throw new AggregateError(result.logs, 'service build failed');
await mkdir('src-tauri/resources', { recursive: true });
await cp('dist', 'src-tauri/resources/dist', { recursive: true });
await cp('server/lsp-ipc.cjs', 'src-tauri/resources/lsp-ipc.cjs');
console.log(`Built ${outfile}`);
