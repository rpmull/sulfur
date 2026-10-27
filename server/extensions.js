import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extensionHostMain } from '../web/src/sulfur/extension-host.js';
import { vscodeShim } from '../web/src/sulfur/vscode-shim.js';
import {
  encodeExtensionMessage,
  decodeExtensionMessage,
} from '../web/src/sulfur/extension-wire.js';
import { LanguageHost, lspMessage } from './languages.js';
import { inside, readJSON, fail, safePath } from './util.js';
export function selfCommand(...args) {
  return typeof __SULFUR_COMPILED__ !== 'undefined' && __SULFUR_COMPILED__
    ? [process.execPath, ...args]
    : [process.execPath, fileURLToPath(new URL('./main.js', import.meta.url)), ...args];
}
export async function startExtension(socket, message, files, machine) {
  if (message.t !== 'init' || !message.context?.extensionPath)
    throw fail('invalid extension initialization');
  const context = message.context,
    root = await files.resolve('home', context.extensionPath),
    allowed = path.join(os.homedir(), '.sulfur/extensions');
  const real = await realpath(root);
  if (!inside(await realpath(allowed), real))
    throw fail('extension is not installed in the local extension directory');
  const manifest = await readJSON(path.join(real, 'package.json'));
  if (manifest?.sulfur?.vscode?.runtime !== 'bun')
    throw fail('this extension does not use the Bun runtime');
  const main = await safePath(real, manifest.main);
  const loc = context.workspaceLocation;
  if (loc?.host && loc.host !== '*' && loc.host !== machine.host)
    throw fail('A native workspace extension needs a JS host on the project machine');
  const workspace = await files.resolve(loc?.share || 'home', context.workspace || '');
  const shimDir = await safePath(
    real,
    path.posix.join(manifest.sulfur.vscode.root, 'node_modules/vscode'),
    true,
  );
  await mkdir(shimDir, { recursive: true });
  await writeFile(path.join(shimDir, 'index.js'), 'module.exports = globalThis.__sulfurVSCode;\n');
  await writeFile(
    path.join(shimDir, 'package.json'),
    JSON.stringify({ name: 'vscode', version: '1.95.0', type: 'commonjs', main: 'index.js' }),
  );
  const proc = Bun.spawn(selfCommand('--extension-host'), {
    cwd: workspace,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
    windowsHide: true,
  });
  let ended = false;
  const send = (value) => {
    if (ended) return;
    proc.stdin.write(encodeExtensionMessage(value) + '\n');
    proc.stdin.flush();
  };
  socket.data.extension = {
    send,
    stop() {
      if (ended) return;
      ended = true;
      proc.kill();
    },
  };
  send({
    ...message,
    context: {
      ...context,
      nativeHomeRoot: files.share('home').root,
      nativeEntry: main,
      nativeExtensionRoot: real,
    },
  });
  (async () => {
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    for await (const chunk of proc.stdout) {
      buffered += decoder.write(Buffer.from(chunk));
      if (buffered.length > 32 << 20) throw fail('extension host output exceeds limit');
      let i;
      while ((i = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        if (line) socket.send(line);
      }
    }
  })().catch((e) => {
    socket.send(JSON.stringify({ t: 'fail', e: e.message }));
    proc.kill();
  });
  (async () => {
    for await (const chunk of proc.stderr)
      socket.send(
        JSON.stringify({
          t: 'call',
          id: -1,
          m: 'output.append',
          a: ['Runtime', Buffer.from(chunk).toString()],
        }),
      );
  })();
  proc.exited.then((code) => {
    ended = true;
    if (code) socket.send(JSON.stringify({ t: 'fail', e: `Extension host exited (${code})` }));
    socket.close(1000);
  });
}
export async function extensionProcess() {
  const handlers = new Map();
  globalThis.addEventListener = (name, fn) => {
    (handlers.get(name) || handlers.set(name, new Set()).get(name)).add(fn);
  };
  globalThis.removeEventListener = (name, fn) => handlers.get(name)?.delete(fn);
  const send = (m) => process.stdout.write(encodeExtensionMessage(m) + '\n');
  // extensionHostMain forwards each log to its extension output channel once.
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};
  process.on('unhandledRejection', (reason) =>
    send({ t: 'fail', e: String(reason?.stack || reason) }),
  );
  extensionHostMain(vscodeShim, () => ({ dispose() {} }), {
    async load(d, vscode) {
      globalThis.__sulfurVSCode = vscode;
      const entry = d.context.nativeEntry;
      try {
        return createRequire(entry)(entry);
      } catch (error) {
        if (error.code === 'ERR_REQUIRE_ESM') return import(pathToFileURL(entry).href);
        throw error;
      }
    },
  });
  let port = null,
    buffered = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.write(Buffer.from(chunk));
    if (buffered.length > 32 << 20) throw fail('extension message exceeds limit');
    let i;
    while ((i = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      if (!line) continue;
      const data = decodeExtensionMessage(line);
      if (!port) {
        port = { onmessage: null, postMessage: send };
        for (const fn of handlers.get('message') || []) fn({ data, ports: [port] });
      } else await port.onmessage?.({ data });
      if (data.t === 'deactivate') {
        setTimeout(() => process.exit(0), 100).unref();
      }
    }
  }
}
export async function languageCLI(arg) {
  let active;
  try {
    const request = JSON.parse(Buffer.from(arg, 'base64').toString()),
      host = new LanguageHost(),
      socket = {
        data: { abort: new AbortController() },
        send(s) {
          process.stdout.write(s + '\n');
        },
        close() {
          socket.closed = true;
        },
      };
    await host.serve(socket, request);
    active = socket.data.lsp?.proc;
    if (!socket.data.lsp) return;
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    for await (const chunk of Bun.stdin.stream()) {
      buffered += decoder.write(Buffer.from(chunk));
      let i;
      while ((i = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        if (line) await lspMessage(socket, JSON.parse(line));
      }
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ _sulfur: 'error', error: error.message }) + '\n');
    process.exitCode = 1;
  } finally {
    active?.kill('SIGKILL');
  }
}
