import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safePath } from './util.js';

// Runs only when the user converts a web extension. Bundling resolves its local
// CommonJS/ESM dependencies while leaving vscode bound to the iframe's bridge.
// Package lifecycle scripts and extension code are never executed here.
export async function bundleBrowserExtension(result) {
  if (result.manifest.sulfur.vscode?.runtime !== 'browser') return;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sulfur-web-extension-'));
  try {
    for (const [name, text] of Object.entries(result.files)) {
      if (!name.startsWith('vscode/')) continue;
      const file = await safePath(temp, name, true);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    for (const [name, data] of Object.entries(result.binary || {})) {
      const file = await safePath(temp, name, true);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(data, 'base64'));
    }
    const built = await Bun.build({
      entrypoints: [path.join(temp, result.manifest.main)],
      target: 'browser',
      format: 'cjs',
      external: ['vscode'],
      minify: true,
      sourcemap: 'none',
      naming: '[name].js',
    });
    if (!built.success) throw new AggregateError(built.logs, built.logs.map(String).join('\n'));
    if (built.outputs.length !== 1 || !built.outputs[0].path.endsWith('.js'))
      throw new Error('This web extension needs asset loading beyond the browser bridge');
    const entry = 'vscode/sulfur-web.cjs';
    result.files[entry] = await built.outputs[0].text();
    result.manifest.main = entry;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
