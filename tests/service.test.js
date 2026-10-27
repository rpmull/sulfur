import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Files, globRE } from '../server/files.js';
import { Collaboration, diskDiff } from '../server/collab.js';
import { opApply } from '../web/src/text-operations.js';
import { sqlite } from '../server/sqlite-worker.js';
import { sqlite as pooledSQLite, closeSQLite, SQLitePool } from '../server/sqlite.js';
import { LSPFramer, frameLSP, lspMessage } from '../server/languages.js';
import { markdown, markdownResponse } from '../server/markdown.js';
import { verifyMinisign, newer } from '../server/updates.js';
import { createService } from '../server/main.js';
import { spawnTerminal, git } from '../server/processes.js';
import { selfCommand } from '../server/extensions.js';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sulfur-js-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const machine = {
    user: 'me',
    host: 'test-machine',
    platform: 'windows',
    shell: 'sh',
    shares: [{ id: '0', root, perms: 'rwd' }],
    info: { files: { shares: [{ id: '0', label: root, perms: 'rwd' }] } },
  };
  return { root, machine, files: new Files(machine) };
}
const settled = async (file) => {
  const when = new Date(Date.now() - 1000);
  await utimes(file, when, when);
};
const socket = () => ({
  data: {},
  messages: [],
  send(s) {
    this.messages.push(JSON.parse(s));
  },
});

test('files preserve list, breadth-first tree, search, text and chunk-upload contracts', async () => {
  const { root, files } = await fixture();
  await mkdir(path.join(root, 'dir/empty'), { recursive: true });
  await writeFile(path.join(root, 'dir/a.js'), 'Hello\r\nhello\nother');
  await writeFile(path.join(root, 'binary'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(root, '.phosphorus-upload-hidden'), 'pending');
  expect((await files.list('0')).entries.map((e) => e.name)).toEqual(['dir', 'binary']);
  const entries = (await files.list('0', 'dir')).entries;
  expect(entries[0]).toMatchObject({
    name: 'empty',
    dir: true,
    empty: true,
    link: false,
    size: null,
  });
  expect(entries[1]).toMatchObject({ name: 'a.js', dir: false, link: false, size: 18 });
  expect((await files.tree('0', '', { depth: 1 })).entries.map((e) => e.path)).toEqual([
    'binary',
    'dir/',
  ]);
  expect(
    (await files.tree('0', '', { depth: 8, match: '*.JS' })).entries.map((e) => e.path),
  ).toEqual(['dir/a.js']);
  expect((await files.tree('0', '', { depth: 8, skip: 'dir' })).entries.map((e) => e.path)).toEqual(
    ['binary'],
  );
  expect((await files.search('0', '', { query: 'hello', content: true })).results).toEqual([
    {
      path: 'dir/a.js',
      matches: [
        { line: 1, text: 'Hello' },
        { line: 2, text: 'hello' },
      ],
    },
  ]);
  expect((await files.read('0', 'binary')).binary).toBe(true);
  expect((await files.read('0', 'dir/a.js')).text).toBe('Hello\r\nhello\nother');
  await files.save('0', 'dir/a.js', { old: 'other', new: 'world' });
  await expect(files.save('0', 'dir/a.js', { old: 'missing', new: 'x' })).rejects.toThrow(
    'old text not found',
  );
  const upload = (offset, body) =>
    files.upload(
      '0',
      'out.bin',
      new Request('http://local', { method: 'POST', body }),
      new URLSearchParams({ id: 'fixture', total: '5', offset: String(offset) }),
    );
  expect(await upload(0, 'abc')).toEqual({ ok: true, next: 3 });
  await expect(upload(1, 'xy')).rejects.toThrow('offset');
  expect(await upload(3, 'de')).toEqual({ ok: true, path: 'out.bin' });
  expect(await readFile(path.join(root, 'out.bin'), 'utf8')).toBe('abcde');
  expect(globRE('[a].*').test('[A].js')).toBe(true);
  expect(globRE('[a].*').test('a.js')).toBe(false);
});

test('share paths reject traversal and existing-parent symlink escapes', async () => {
  const { root, files } = await fixture();
  await expect(files.resolve('0', '../escape', true)).rejects.toThrow('invalid path');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sulfur-outside-'));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await symlink(
    outside,
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(files.resolve('0', 'link/new/file.txt', true)).rejects.toThrow('leaves its share');
});

test('concurrent clients share one session and rebase edits in UTF-16', async () => {
  const { root, files } = await fixture();
  await writeFile(path.join(root, 'a'), 'a😀b');
  await settled(path.join(root, 'a'));
  const collab = new Collaboration(files);
  cleanups.push(() => collab.dispose());
  const left = socket(),
    right = socket();
  await Promise.all([collab.attach(left, '0', 'a'), collab.attach(right, '0', 'a')]);
  expect(left.data.collab.s).toBe(right.data.collab.s);
  expect(left.messages[0]).toMatchObject({ type: 'init', text: 'a😀b', you: 1, perms: 'rwd' });
  await Promise.all([
    collab.message(left, { type: 'op', base: 0, id: 'l', ops: [1, 'X', 3] }),
    collab.message(right, { type: 'op', base: 0, id: 'r', ops: [4, 'Y'] }),
  ]);
  expect(left.data.collab.s.text).toBe('aX😀bY');
  await collab.save(left.data.collab.s);
  expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('aX😀bY');
  for (const [a, b] of [
    ['a😀b', 'a😃b'],
    ['😀', 'x😀'],
    ['😀x', '😃x'],
  ])
    expect(opApply(a, diskDiff(a, b))).toBe(b);
});

test('external edits animate with an agent and a dirty editor never overwrites disk silently', async () => {
  const { root, files } = await fixture(),
    file = path.join(root, 'a');
  await writeFile(file, 'abc');
  await settled(file);
  const collab = new Collaboration(files);
  cleanups.push(() => collab.dispose());
  const ws = socket();
  const s = await collab.attach(ws, '0', 'a');
  expect((await collab.write('0', 'a', { old: 'b', new: 'XYZ', by: { name: 'Agent' } })).live).toBe(
    true,
  );
  expect(s.text).toBe('aXYZc');
  expect(ws.messages.some((m) => m.type === 'op' && m.agent && m.by === 'Agent')).toBe(true);
  await collab.message(ws, { type: 'op', base: s.v, id: 'edit', ops: [s.text.length, '!'] });
  await writeFile(file, 'external');
  await settled(file);
  await expect(collab.save(s)).rejects.toThrow('conflict');
  expect(await readFile(file, 'utf8')).toBe('external');
  expect(s.text).toBe('aXYZc!');
  const revision = s.revision;
  await collab.message(ws, { type: 'resolveDisk', choice: 'reload', revision: revision - 1 });
  expect(s.text).toBe('aXYZc!');
  await collab.message(ws, { type: 'resolveDisk', choice: 'reload', revision });
  expect(s.text).toBe('external');
});

test('SQLite batches are atomic, triggers work, rows stream and authorization cannot be bypassed', async () => {
  const { root } = await fixture(),
    file = path.join(root, 'a.db');
  const request = (op, sql, limit) => sqlite({ path: file, op, sql, limit });
  await request('create');
  await expect(request('create')).rejects.toThrow();
  await request(
    'execute',
    'CREATE TABLE t(n); CREATE TABLE log(n); CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.n); INSERT INTO log VALUES(new.n+1); END; INSERT INTO t VALUES(1);',
  );
  expect((await request('query', 'SELECT n,n as n FROM log')).rows).toEqual([
    [1, 1],
    [2, 2],
  ]);
  await expect(
    request('execute', 'INSERT INTO t VALUES(9); INSERT INTO missing VALUES(1)'),
  ).rejects.toThrow();
  expect((await request('query', 'SELECT count(*) FROM t')).rows).toEqual([[1]]);
  await expect(
    request('execute', 'INSERT INTO t VALUES(8); COMMIT; INSERT INTO t VALUES(9)'),
  ).rejects.toThrow();
  expect((await request('query', 'SELECT count(*) FROM t')).rows).toEqual([[1]]);
  await expect(request('execute', "ATTACH DATABASE ':memory:' AS other")).rejects.toThrow();
  await expect(request('query', "SELECT load_extension('bad')")).rejects.toThrow();
  expect((await request('query', 'SELECT 1 AS "attach", \'load_extension\' AS text')).rows).toEqual(
    [[1, 'load_extension']],
  );
  expect(
    await request(
      'query',
      'WITH RECURSIVE r(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM r) SELECT x FROM r',
      3,
    ),
  ).toMatchObject({ rows: [[1], [2], [3]], truncated: true });
  expect((await request('query', "SELECT 9223372036854775807, x'0102'")).rows).toEqual([
    ['9223372036854775807', 'BLOB (2 bytes): 0102'],
  ]);
  expect((await request('schema')).rows.length).toBe(2);
  cleanups.push(closeSQLite);
  expect((await pooledSQLite({ path: file, op: 'query', sql: 'SELECT 42' })).rows).toEqual([[42]]);
});

test('LSP frames split at any byte; project boundaries include nonexisting children and virtual read permissions', async () => {
  const value = { jsonrpc: '2.0', method: 'x', params: { text: '😀𝌆' } },
    packet = frameLSP(value),
    got = [];
  const parser = new LSPFramer((m) => got.push(m));
  for (const byte of packet) parser.push(Uint8Array.of(byte));
  expect(got).toEqual([value]);
  expect(() =>
    new LSPFramer(() => {}).push(Buffer.from('Content-Length: 999999999\r\n\r\n')),
  ).toThrow();
  const { root } = await fixture(),
    lsp = {
      root,
      virtual: new Set(['csharp:/a']),
      manifest: {},
      proc: { stdin: { write() {}, async flush() {} } },
    };
  const ws = { data: { lsp } };
  await lspMessage(ws, {
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: pathToFileURL(path.join(root, 'new.txt')).href } },
  });
  await expect(
    lspMessage(ws, {
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: pathToFileURL(path.join(root, '../x')).href } },
    }),
  ).rejects.toThrow('outside');
  await lspMessage(ws, {
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'csharp:/a' } },
  });
  await expect(
    lspMessage(ws, {
      method: 'textDocument/didChange',
      params: { textDocument: { uri: 'csharp:/a' } },
    }),
  ).rejects.toThrow('outside');
});

test('legacy markdown features, source blocks and minisign update signatures survive migration', async () => {
  const html = markdown(
    '**hi** $x^2$ and `$y$`\n```go\nfunc main() {}\n```\n\n[a](javascript:x) [b](https://x.y) <script>alert(1)</script>',
  );
  for (const want of [
    '<strong>hi</strong>',
    'data-tex="x^2"',
    '<code>$y$</code>',
    'hljs-keyword',
    'target="_blank"',
  ])
    expect(html).toContain(want);
  expect(html).not.toContain('<script');
  expect(html).not.toContain('javascript:');
  expect(markdown('- [x] done')).toContain('class="task"');
  expect(markdown('costs $5 and $6')).not.toContain('data-tex');
  const text =
    '# T\n\npara one\nstill\n\n```js\nx\n```\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const { blocks } = markdownResponse({ text, blocks: true });
  expect(blocks.length).toBe(5);
  expect(blocks.map((b) => b.raw).join('')).toBe(text);
  for (const b of blocks) expect(text.slice(b.from, b.from + b.raw.length)).toBe(b.raw);
  const data = await Bun.file('tests/fixtures/data.bin').bytes(),
    sig = await Bun.file('tests/fixtures/data.e.sig').text(),
    key = await Bun.file('tests/fixtures/e.pub').text();
  expect(verifyMinisign(data, sig, key)).toBe(true);
  expect(() => verifyMinisign(Buffer.concat([data, Buffer.from('x')]), sig, key)).toThrow(
    'signature',
  );
  expect(newer('1.108.0', '1.107')).toBe(true);
  expect(newer('1.107', '1.107.0')).toBe(false);
});

test('mesh proxy preserves shared-files paths, cookies, bodies and WebSocket framing', async () => {
  const remote = Bun.serve({
    port: 0,
    fetch(req, server) {
      const u = new URL(req.url);
      if (u.pathname === '/api/state') {
        if (req.headers.get('origin') !== remote.url.origin)
          return new Response('bad origin', { status: 403 });
        server.upgrade(req);
        return;
      }
      if (u.pathname === '/api/compressed')
        return new Response(Bun.gzipSync(JSON.stringify({ compressed: true })), {
          headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
        });
      return Response.json(
        {
          path: u.pathname,
          query: u.search,
          cookie: req.headers.get('cookie'),
          origin: req.headers.get('origin'),
        },
        {
          headers: { 'Set-Cookie': 'phosphorus=session; Secure; Domain=mesh.test; SameSite=None' },
        },
      );
    },
    websocket: {
      message(ws, msg) {
        ws.send(msg);
      },
    },
  });
  cleanups.push(() => remote.stop(true));
  const { root, machine } = await fixture();
  const configFile = path.join(root, 'sulfur.json');
  await writeFile(
    configFile,
    JSON.stringify({ server: remote.url.origin, servers: [remote.url.origin] }),
  );
  const service = await createService({ port: 0, configFile, machine });
  cleanups.push(() => service.stop());
  const info = await (await fetch(service.origin + '/api/sidecar/info')).json();
  expect(info.mesh.caps).toContain('home');
  expect(info.nodeExtensions).toBe(true);
  const proxied = await fetch(
    service.origin + '/api/mesh/api/files/mesh/list?share=home&path=shared',
    { headers: { Cookie: 'phosphorus=session' } },
  );
  expect(await proxied.json()).toMatchObject({
    path: '/api/files/mesh/list',
    query: '?share=home&path=shared',
    cookie: 'phosphorus=session',
  });
  expect(proxied.headers.get('set-cookie')).toBe('phosphorus=session; SameSite=Lax');
  expect(await (await fetch(service.origin + '/api/mesh/api/compressed')).json()).toEqual({
    compressed: true,
  });
  expect(
    (await fetch(service.origin + '/api/sidecar/mode', { method: 'POST', body: '{}' })).status,
  ).toBe(403);
  const ws = new WebSocket(service.origin.replace('http:', 'ws:') + '/api/mesh/api/state', {
    headers: { Origin: service.origin },
  });
  await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('mesh-shared-home');
    ws.onerror = reject;
    ws.onmessage = (e) => {
      expect(e.data).toBe('mesh-shared-home');
      ws.close();
      resolve();
    };
  });
});

test('native PTY streams actual process output', async () => {
  let out = '';
  const proc = spawnTerminal(
    { cmd: process.platform === 'win32' ? 'echo sulfur-pty' : 'printf sulfur-pty' },
    (b) => {
      out += b.toString();
    },
  );
  expect(await proc.exited).toBe(0);
  expect(out).toContain('sulfur-pty');
});

test('Git staging, commits and diffs retain exit/output semantics and reject execution options', async () => {
  const { root } = await fixture();
  expect((await git({ dir: root, args: ['init'] })).code).toBe(0);
  await writeFile(
    path.join(root, '.git/config'),
    '[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\nhooksPath = .git/no-hooks\n[commit]\ngpgsign = false\n[user]\nname = Fixture\nemail = fixture@example.invalid\n',
  );
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  expect((await git({ dir: root, args: ['status', '--porcelain'] })).out).toContain('?? a.txt');
  expect((await git({ dir: root, args: ['add', '--', 'a.txt'] })).code).toBe(0);
  expect((await git({ dir: root, args: ['commit', '-m', 'fixture'] })).code).toBe(0);
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  expect((await git({ dir: root, args: ['diff', '--', 'a.txt'] })).out).toContain('+two');
  expect((await git({ dir: root, args: ['rev-parse', '--verify', 'unknown-ref'] })).code).not.toBe(
    0,
  );
  await expect(git({ dir: root, args: ['status', '-c', 'x=y'] })).rejects.toThrow('option');
  await expect(git({ dir: root, args: ['fetch', '--upload-pack=evil'] })).rejects.toThrow('option');
});

test('SQLite deadlines kill native work and the next query gets a healthy process', async () => {
  const { root } = await fixture(),
    file = path.join(root, 'deadline.db');
  await sqlite({ path: file, op: 'create' });
  const pool = new SQLitePool();
  cleanups.push(() => pool.close());
  await pool.run({ path: file, op: 'query', sql: 'SELECT 1' });
  const child = pool.slots[0].proc;
  pool.timeout = 100;
  await expect(
    pool.run({
      path: file,
      op: 'query',
      sql: 'WITH RECURSIVE r(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM r) SELECT sum(x) FROM r',
    }),
  ).rejects.toThrow('timed out');
  await child.exited;
  expect(child.exitCode).not.toBe(0);
  pool.timeout = 10000;
  expect((await pool.run({ path: file, op: 'query', sql: 'SELECT 7' })).rows).toEqual([[7]]);
}, 20000);

test('legacy executable helpers preserve SQLite error replies and language status framing', async () => {
  const { root } = await fixture(),
    file = path.join(root, 'helper.db');
  await sqlite({ path: file, op: 'create' });
  const proc = Bun.spawn(selfCommand('sulfur-sqlite'), {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify({ path: file, op: 'query', sql: 'SELECT * FROM missing' }));
  proc.stdin.end();
  const result = await new Response(proc.stdout).json();
  expect(await proc.exited).toBe(0);
  expect(result.error).toContain('no such table');
  const language = Bun.spawn(
    selfCommand(
      'sulfur-language',
      Buffer.from(JSON.stringify({ op: 'status' })).toString('base64'),
    ),
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, SULFUR_LANGUAGE_HOME: path.join(root, 'languages') },
    },
  );
  const status = await new Response(language.stdout).json();
  expect(await language.exited).toBe(0);
  expect(status._sulfur).toBe('status');
  expect(status.extensions.length).toBe(10);
});
