import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { convertVSIX, parseData } from '../server/vsix.js';
import fixtures from './fixtures/legacy-vsix.json';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { selfCommand } from '../server/extensions.js';
import {
  encodeExtensionMessage,
  decodeExtensionMessage,
} from '../web/src/sulfur/extension-wire.js';

const zip = (files) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const convert = (fixture) =>
  convertVSIX(
    zip(fixture.files),
    {},
    { commands: ['editor.action.copyLinesDownAction', 'workbench.action.openRecent'] },
  );
const data = (result, entry) => JSON.parse(result.files[entry.path]);

test('legacy theme packages retain includes, plist themes, token colors, styles and safe colors', () => {
  const result = convert(fixtures[0]),
    themes = result.manifest.contributes.themes;
  expect(result.manifest.displayName).toBe('Night and Day');
  expect(themes.length).toBe(2);
  const night = data(result, themes[0]),
    day = data(result, themes[1]);
  expect(night.vars).toMatchObject({
    '--ide-bg': '#000000',
    '--ide-side': '#111111aa',
    '--ide-fg': '#eeeeee',
    '--hl-kw': '#ff00ff',
    '--hl-str': '#00ff00',
    '--hl-title': '#0000ff',
    '--hl-cmt': '#777777',
    '--hl-cmt-style': 'normal',
  });
  expect(night.vars['--ide-button']).toBeUndefined();
  expect(day.type).toBe('light');
  expect(day.vars['--ide-bg']).toBe('#ffffff');
  expect(day.vars['--hl-kw']).toBe('#aa0000');
  expect(result.report.filter((r) => r.kind === 'theme').map((r) => r.status)).toEqual([
    'converted',
    'converted',
    'skipped',
  ]);
});

test('legacy icon packages keep working when individual icons are missing', () => {
  const result = convert(fixtures[1]),
    theme = data(result, result.manifest.contributes.iconThemes[0]);
  expect(theme.defs._unused).toBeUndefined();
  expect(theme.defs._file.src).toStartWith('data:image/svg+xml;base64,');
  expect(theme.defs._ts).toMatchObject({ char: '\uE001', color: '#3178c6', font: 'glyphs' });
  expect(theme.fonts.glyphs.size).toBe('150%');
  expect(theme.fileExtensions.ts).toBe('_ts');
  expect(theme.languageExtensions.lua).toBe('_ts');
  expect(theme.light.fileNames.makefile).toBe('_folder');
});

test('legacy grammar/snippet packages preserve language configuration and TextMate syntax', () => {
  const result = convert(fixtures[2]),
    c = result.manifest.contributes,
    demo = c.languages.find((l) => l.id === 'demo');
  expect(demo).toMatchObject({
    extensions: ['demo', 'dm'],
    filenames: ['demofile'],
    comments: { lineComment: '--', blockComment: ['{-', '-}'] },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [['"', '"']],
  });
  const grammar = c.grammars.find((g) => g.language === 'demo');
  expect(data(result, grammar).patterns[0].match).toBe('\\b(let|in)\\b');
  const snippets = data(result, c.snippets[0]);
  expect(snippets.length).toBe(2);
  expect(snippets.find((s) => s.name === 'Let')).toMatchObject({
    body: 'let ${1:x} = $0\nin',
    prefix: ['let', 'lt'],
  });
  expect(c.snippets[1].extensions).toContain('js');
  expect(c.snippets[1].extensions).toContain('ts');
});

test('native language-server conversion remains separate from Node extension execution', () => {
  const result = convert(fixtures[4]),
    server = result.manifest.contributes.languageServers[0];
  expect(server).toMatchObject({
    entry: 'extension/dist/languageserver.js',
    runtime: 'node',
    transport: 'ipc',
    args: [],
    languages: ['demo', 'yaml'],
    settings: { demo: { format: { enable: true }, trace: { server: 'off' } } },
    initializationOptions: { icons: '${extensionPath}/media/icons' },
  });
  expect(result.manifest.sulfur.declarative).toBe(true);
  const native = convert(fixtures[5]).manifest.contributes.languageServers[0];
  expect(native).toMatchObject({
    entry: 'extension/server/bin/lua-language-server.exe',
    runtime: 'binary',
    args: [],
  });
});

test('Node-only extensions, dependencies and own commands can now be converted', () => {
  const result = convert(fixtures[3]);
  expect(result.manifest.sulfur.vscode.runtime).toBe('bun');
  expect(result.manifest.main).toBe('vscode/out/extension.js');
  expect(result.files['vscode/node_modules/vscode/index.js']).toContain('__sulfurVSCode');
  expect(result.manifest.contributes.keybindings.map((k) => k.command)).toEqual([
    'editor.action.copyLinesDownAction',
    '-workbench.action.openRecent',
    'ext.go',
  ]);
  expect(result.manifest.sulfur.vscode.defaults['ext.a']).toBe(1);
  const bad = convert(fixtures.at(-1));
  expect(bad.report.every((r) => r.status === 'skipped')).toBe(true);
  expect(() => convertVSIX(Buffer.from('bad'))).toThrow();
  expect(() => convert(fixtures.at(-2))).toThrow();
});

test('plist entities, booleans, arrays and numbers decode without external resource resolution', () => {
  const data = parseData(
    'grammar.plist',
    Buffer.from(
      '<?xml version="1.0"?><plist><dict><key>text</key><string>a &amp; b</string><key>on</key><true/><key>n</key><integer>3</integer><key>a</key><array><string>x</string></array></dict></plist>',
    ),
  );
  expect(data).toEqual({ text: 'a & b', on: true, n: 3, a: ['x'] });
});

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
  const proc = Bun.spawn(selfCommand('--extension-host'), {
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
