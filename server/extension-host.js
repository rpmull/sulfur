// A converted Node extension's own process, started by the Sulfur service with
// the Node.js (or Bun) found on PATH. Messages are lines of the extension wire
// format on stdin and stdout; the VS Code API is the page's bridge.
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { extensionHostMain } from '../web/src/sulfur/extension-host.js';
import { vscodeShim } from '../web/src/sulfur/vscode-shim.js';
import {
  encodeExtensionMessage,
  decodeExtensionMessage,
} from '../web/src/sulfur/extension-wire.js';

const handlers = new Map();
globalThis.addEventListener = (name, fn) => {
  (handlers.get(name) || handlers.set(name, new Set()).get(name)).add(fn);
};
globalThis.removeEventListener = (name, fn) => handlers.get(name)?.delete(fn);
const send = (m) => process.stdout.write(encodeExtensionMessage(m) + '\n');
// extensionHostMain forwards each log to its extension output channel once.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};
process.on('unhandledRejection', (reason) => send({ t: 'fail', e: String(reason?.stack || reason) }));
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
for await (const chunk of process.stdin) {
  buffered += decoder.write(chunk);
  if (buffered.length > 32 << 20) throw new Error('extension message exceeds limit');
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
    if (data.t === 'deactivate') setTimeout(() => process.exit(0), 100).unref();
  }
}
