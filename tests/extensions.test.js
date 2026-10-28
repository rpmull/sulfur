import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  encodeExtensionMessage,
  decodeExtensionMessage,
} from '../web/src/sulfur/extension-wire.js';

// the process the Rust service starts for a Node extension, on the Node.js the app finds
const hostCommand = () => [Bun.which('node') || process.execPath, path.resolve('server/extension-host.js')];

test('native extension process executes Node APIs, CommonJS dependencies, ESM imports and VS Code commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sulfur-native-ext-')),
    ext = path.join(root, 'me/.sulfur/extensions/test/vscode'),
    workspace = path.join(root, 'me/project');
  await mkdir(path.join(ext, 'node_modules/vscode'), { recursive: true });
  await mkdir(path.join(ext, 'node_modules/helper'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(ext, 'node_modules/vscode/index.js'),
    'module.exports=globalThis.__sulfurVSCode',
  );
  await writeFile(path.join(ext, 'node_modules/helper/index.js'), 'module.exports=(x)=>x*2');
  await writeFile(path.join(ext, 'value.mjs'), 'export const value="ESM😀"');
  await writeFile(path.join(ext, 'payload.txt'), 'native fs');
  const entry = path.join(ext, 'main.cjs');
  await writeFile(
    entry,
    `const vscode=require('vscode'),fs=require('node:fs'),helper=require('helper');exports.activate=async(ctx)=>{const esm=await import('./value.mjs');ctx.subscriptions.push(vscode.commands.registerCommand('native.test',async()=>({payload:fs.readFileSync(ctx.asAbsolutePath('payload.txt'),'utf8'),value:helper(3),esm:esm.value,extensionPath:ctx.extensionPath,workspace:vscode.workspace.rootPath,bridge:await vscode.workspace.fs.readFile(vscode.Uri.file('/me/project/bin.dat'))})));};`,
  );
  const proc = Bun.spawn(hostCommand(), {
      cwd: workspace,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    messages = [];
  const send = (value) => {
    proc.stdin.write(encodeExtensionMessage(value) + '\n');
    proc.stdin.flush();
  };
  const timeout = setTimeout(() => proc.kill(), 10000);
  try {
    send({
      t: 'init',
      context: {
        id: 'test',
        user: 'me',
        extensionPath: 'me/.sulfur/extensions/test',
        workspace: 'me/project',
        nativeHomeRoot: root,
        nativeEntry: entry,
        vscode: { root: 'vscode', id: 'test', defaults: {} },
      },
    });
    let buffer = '',
      returned;
    for await (const chunk of proc.stdout) {
      buffer += Buffer.from(chunk).toString();
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const m = decodeExtensionMessage(line);
        messages.push(m);
        if (m.t === 'fail') throw new Error(m.e);
        if (m.t === 'call')
          send({
            t: 'ret',
            id: m.id,
            v: m.m === 'workspace.readBytes' ? Uint8Array.of(0, 255, 1) : null,
          });
        if (m.t === 'ready') send({ t: 'cmd', id: 900, cmd: 'native.test', args: [] });
        if (m.t === 'ret' && m.id === 900) {
          returned = m.v;
          send({ t: 'deactivate' });
        }
      }
    }
    expect(await proc.exited).toBe(0);
    expect(returned).toMatchObject({
      payload: 'native fs',
      value: 6,
      esm: 'ESM😀',
      extensionPath: ext,
      workspace,
    });
    expect(messages.some((m) => m.t === 'ready')).toBe(true);
    expect(returned.bridge).toEqual(Uint8Array.of(0, 255, 1));
  } finally {
    clearTimeout(timeout);
    proc.kill();
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test('native extension messages preserve structured binary values and escape user objects', () => {
  const value = {
    bytes: new Uint8Array([0, 255]),
    words: new Uint16Array([255, 65535]),
    buffer: new Uint8Array([3, 4]).buffer,
    view: new DataView(new Uint8Array([8, 9]).buffer),
    map: new Map([[3, 4n]]),
    set: new Set(['x']),
    date: new Date('2026-10-27T00:00:00Z'),
    escaped: { '$sulfur-wire-v1': 'bigint', value: 'an ordinary string' },
    inf: Infinity,
  };
  const out = decodeExtensionMessage(encodeExtensionMessage(value));
  expect(out).toEqual(value);
  expect(out.bytes).toBeInstanceOf(Uint8Array);
  expect(out.words).toBeInstanceOf(Uint16Array);
  expect(out.view).toBeInstanceOf(DataView);
});
