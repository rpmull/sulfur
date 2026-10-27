import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverURL, meshProvider, meshInfo } from './mesh.js';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Files, localMachine } from './files.js';
import { Collaboration } from './collab.js';
import { Terminals, git, toolchains, taskStart } from './processes.js';
import { LanguageHost, lspMessage } from './languages.js';
import { sqlite, closeSQLite } from './sqlite.js';
import { markdownResponse } from './markdown.js';
import { searchExtensions, convertExtension } from './registry.js';
import { Updates } from './updates.js';
import { configHome, readJSON, atomicJSON, bodyJSON, json, fail, safePath } from './util.js';
import { startExtension } from './extensions.js';
import { decodeExtensionMessage } from '../web/src/sulfur/extension-wire.js';
import pkg from '../package.json';
export { serverURL } from './mesh.js';
export const localCookie = (s) =>
  s
    .replace(/;\s*(secure|domain=[^;]*|partitioned)\s*/gi, '')
    .replace(/samesite=none/gi, 'SameSite=Lax');
export async function createService({
  hostname = '127.0.0.1',
  port = 47615,
  configFile = path.join(configHome(), 'Sulfur/sulfur.json'),
  dist = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url))),
  version = pkg.version,
  machine: providedMachine,
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname))
    throw fail('-addr must be a loopback address and port');
  const machine = providedMachine || (await localMachine()),
    files = new Files(machine),
    collab = new Collaboration(files),
    terms = new Terminals(),
    languages = new LanguageHost(),
    updates = new Updates(version);
  let cfg = { mode: 'local', servers: [], ...(await readJSON(configFile, {})) };
  cfg.mode = 'local';
  if (cfg.server) cfg.server = serverURL(cfg.server);
  let origin = '';
  const sockets = new Set();
  const error = (ws, e) => {
    try {
      ws.send(
        JSON.stringify(
          ws.data.route === 'languages'
            ? { _sulfur: 'error', error: e.message }
            : { type: 'error', error: e.message },
        ),
      );
      ws.close(1000);
    } catch {}
  };
  const service = Bun.serve({
    hostname,
    port,
    idleTimeout: 60,
    maxRequestBodySize: 64 << 20,
    development: false,
    async fetch(req, server) {
      try {
        const url = new URL(req.url),
          p = url.pathname;
        if (req.headers.get('host') !== new URL(origin).host)
          return new Response('not this server', { status: 421 });
        const upgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
        if (
          (upgrade || !['GET', 'HEAD'].includes(req.method)) &&
          req.headers.get('origin') !== origin
        )
          return new Response("not from Sulfur's page", { status: 403 });
        if (p.startsWith('/api/mesh/')) {
          if (!cfg.server) throw fail('no mesh to reach: connect to one once', 404);
          const target = new URL(p.slice('/api/mesh'.length) + url.search, cfg.server);
          if (upgrade) {
            const headers = Object.fromEntries(req.headers);
            for (const k of [
              'host',
              'connection',
              'upgrade',
              'sec-websocket-key',
              'sec-websocket-version',
              'sec-websocket-extensions',
            ])
              delete headers[k];
            headers.origin = target.origin;
            if (
              server.upgrade(req, {
                data: {
                  route: 'mesh',
                  target: target.href,
                  headers,
                  queue: [],
                  abort: new AbortController(),
                },
              })
            )
              return;
            throw fail('upgrade failed');
          }
          const headers = new Headers(req.headers);
          headers.set('Host', target.host);
          if (headers.has('origin')) headers.set('origin', target.origin);
          const referer = headers.get('referer');
          if (referer?.startsWith(origin))
            headers.set('referer', target.origin + referer.slice(origin.length));
          const upstream = await fetch(target, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
            redirect: 'manual',
            signal: req.signal,
            duplex: 'half',
            decompress: false,
          });
          const h = new Headers(upstream.headers);
          h.delete('set-cookie');
          for (const cookie of upstream.headers.getSetCookie())
            h.append('set-cookie', localCookie(cookie));
          const location = h.get('location');
          if (location?.startsWith(cfg.server))
            h.set('location', location.slice(cfg.server.length));
          return new Response(upstream.body, { status: upstream.status, headers: h });
        }
        if (p === '/api/sidecar/info')
          return json({
            app: 'sulfur',
            version,
            mode: 'local',
            server: cfg.server || '',
            servers: cfg.servers || [],
            user: machine.user,
            host: machine.host,
            platform: machine.platform,
            shell: machine.shell,
            info: machine.info,
            nodeExtensions: true,
            ...(cfg.server ? { mesh: meshInfo(cfg) } : {}),
          });
        if (p === '/api/sidecar/mode' && req.method === 'POST') {
          const b = await bodyJSON(req, 64 << 10);
          if (!b.mode || b.mode === 'local') return json({ mode: 'local' });
          if (!['link', 'mesh'].includes(b.mode)) throw fail('unknown mesh kind');
          const provider = meshProvider(b.kind || 'phosphorus'),
            remote = provider.normalize(b.server);
          await provider.reach(remote);
          const next = {
            ...cfg,
            mode: 'local',
            server: remote,
            kind: provider.kind,
            servers: [remote, ...(cfg.servers || []).filter((s) => s !== remote)].slice(0, 8),
          };
          await atomicJSON(configFile, next);
          cfg = next;
          return json({ mode: 'local', server: remote, mesh: meshInfo(next) });
        }
        if (p === '/api/sidecar/forget' && req.method === 'POST') {
          const b = await bodyJSON(req, 64 << 10),
            next = { ...cfg, servers: (cfg.servers || []).filter((s) => s !== b.server) };
          if (next.server === b.server) {
            next.server = '';
            next.kind = '';
          }
          await atomicJSON(configFile, next);
          cfg = next;
          return json({ servers: cfg.servers });
        }
        if (p === '/api/sidecar/update') {
          if (req.method === 'GET') return json(await updates.info());
          if (req.method === 'POST') {
            if (process.env.SULFUR_NATIVE === '1') {
              const release = await updates.check();
              if (!release) throw fail(`Sulfur ${version} is the latest`, 409);
              return json({ ok: true, version: release.version, file: 'tauri-updater' });
            }
            return json(await updates.install());
          }
          throw fail('method not allowed', 405);
        }
        if (p === '/api/sidecar/reveal' && req.method === 'POST') {
          const { path: file } = await bodyJSON(req, 64 << 10);
          if (!path.isAbsolute(file || '')) throw fail('a full path');
          const args =
            process.platform === 'win32'
              ? ['explorer.exe', `/select,${file}`]
              : process.platform === 'darwin'
                ? ['open', '-R', file]
                : ['xdg-open', path.dirname(file)];
          spawn(args[0], args.slice(1), {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
          return json({ ok: true });
        }
        const local = p.startsWith('/api/local/') ? p.slice('/api/local'.length) : p;
        if (upgrade) {
          let data = { abort: new AbortController(), queue: [], route: '' };
          let m;
          if ((m = /^\/api\/code\/([a-z0-9-]+)$/.exec(local))) {
            if (m[1] !== machine.host) throw fail('not this computer', 404);
            data = {
              ...data,
              route: 'collab',
              share: url.searchParams.get('share') || '0',
              path: url.searchParams.get('path') || '',
            };
          } else if ((m = /^\/api\/term\/([a-z0-9-]+)$/.exec(local))) {
            if (m[1] !== machine.host) throw fail('not this computer', 404);
            const sid = url.searchParams.get('sid');
            if (!sid || sid.length > 64) throw fail('invalid session');
            data = {
              ...data,
              route: 'terminal',
              sid,
              since: Number(url.searchParams.get('since')) || 0,
              auto: url.searchParams.has('auto'),
            };
          } else if (local === '/api/sulfur/languages') data.route = 'languages';
          else if (local === '/api/sulfur/run') data.route = 'task';
          else if (local === '/api/sulfur/extensions/host') data.route = 'extension';
          else if (local === '/api/state') data.route = 'state';
          else throw fail('no such socket', 404);
          if (server.upgrade(req, { data })) return;
          throw fail('upgrade failed');
        }
        if (local === '/api/me')
          return json({ user: machine.user, admin: true, boot: false, local: true });
        if (local === '/api/model/v1/models') return json({ data: [] });
        if (local === '/api/md' && req.method === 'POST')
          return json(markdownResponse(await bodyJSON(req, 8 << 20)));
        if (local === '/api/sulfur/toolchains')
          return json(await toolchains(machine.host, url.searchParams.has('fresh')));
        if (local === '/api/sulfur/git' && req.method === 'POST')
          return json(await git(await bodyJSON(req, 1 << 20)));
        if (local === '/api/sulfur/sqlite' && req.method === 'POST')
          return json(await sqlite(await bodyJSON(req, (1 << 20) + 4096), { signal: req.signal }));
        if (local === '/api/sulfur/vsx/search')
          return json(await searchExtensions(url.searchParams, req.signal));
        if (local === '/api/sulfur/vsx/convert' && req.method === 'POST')
          return json(await convertExtension(await bodyJSON(req, 1 << 20), req.signal));
        const file =
          /^\/api\/files\/([a-z0-9-]+)\/(info|list|tree|search|read|download|upload|save|mkdir|rename|delete)$/.exec(
            local,
          );
        if (file) {
          if (file[1] !== machine.host)
            throw fail(
              `${file[1]} isn't this computer: use the linked mesh API for its machines`,
              404,
            );
          const op = file[2],
            q = url.searchParams,
            share = q.get('share') || '0',
            rel = q.get('path') || '';
          if (op === 'info') return json(machine.info.files);
          if (req.method === 'GET') {
            try {
              if (op === 'list') return json(await files.list(share, rel));
              if (op === 'tree') return json(await files.tree(share, rel, Object.fromEntries(q)));
              if (op === 'search')
                return json(
                  await files.search(share, rel, {
                    ...Object.fromEntries(q),
                    content: q.get('content') === 'true',
                  }),
                );
              if (op === 'read') return json(await files.read(share, rel));
              if (op === 'download') {
                const location = await files.resolve(share, rel);
                return new Response(Bun.file(location), {
                  headers: q.has('inline')
                    ? {}
                    : {
                        'Content-Disposition': `attachment; filename="${path.basename(location).replaceAll('"', '')}"`,
                      },
                });
              }
            } catch (e) {
              if (q.has('quiet') && (e.code === 'ENOENT' || e.status === 404))
                return json({ missing: true, error: 'no such file or folder' });
              throw e;
            }
          } else if (req.method === 'POST') {
            if (op === 'upload') return json(await files.upload(share, rel, req, q));
            const b = await bodyJSON(req);
            return json(
              op === 'save'
                ? await collab.write(share, b.path, b)
                : await files.mutate(share, op, b),
            );
          }
          throw fail('method not allowed', 405);
        }
        if (local.startsWith('/api/')) throw fail(`This computer has no ${local}`, 404);
        if (p === '/') return Response.redirect(`${origin}/sulfur/`, 302);
        const relative = p === '/sulfur' || p === '/sulfur/' ? 'sulfur/index.html' : p.slice(1);
        const asset = await safePath(dist, decodeURIComponent(relative));
        const resource = Bun.file(asset);
        if (!(await resource.exists())) throw fail('no such file', 404);
        const compressed =
          req.headers.get('accept-encoding')?.includes('gzip') &&
          (await Bun.file(asset + '.gz').exists());
        const headers = {
          'Cache-Control': /[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(relative)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Type': resource.type,
          Vary: 'Accept-Encoding',
        };
        return new Response(compressed ? Bun.file(asset + '.gz') : resource, {
          headers: { ...headers, ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) },
        });
      } catch (e) {
        return json(
          { error: e.code === 'ENOENT' ? 'no such file or folder' : e.message },
          e.status || (e.code === 'ENOENT' ? 404 : 500),
        );
      }
    },
    websocket: {
      maxPayloadLength: 32 << 20,
      backpressureLimit: 32 << 20,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        sockets.add(ws);
        ws.data.chain = Promise.resolve();
        if (ws.data.route === 'mesh') {
          const upstream = new WebSocket(ws.data.target, { headers: ws.data.headers });
          ws.data.upstream = upstream;
          upstream.on('open', () => {
            for (const [value, binary] of ws.data.queue) upstream.send(value, { binary });
            ws.data.queue = [];
          });
          upstream.on('message', (value, binary) => ws.send(binary ? value : value.toString()));
          upstream.on('close', (code) => ws.close([1005, 1006, 1015].includes(code) ? 1011 : code));
          upstream.on('error', (e) => error(ws, e));
        } else if (ws.data.route === 'collab')
          ws.data.chain = collab.attach(ws, ws.data.share, ws.data.path).catch((e) => error(ws, e));
        else if (ws.data.route === 'terminal') terms.attach(ws, ws.data.sid, ws.data.since);
        else if (ws.data.route === 'state')
          ws.send(
            JSON.stringify({
              self: { host: machine.host },
              peers: [{ name: machine.host, online: true }],
              hosts: { [machine.host]: machine.info },
            }),
          );
      },
      message(ws, data) {
        const binary = typeof data !== 'string';
        ws.data.chain = ws.data.chain
          .then(async () => {
            if (ws.data.route === 'mesh') {
              const u = ws.data.upstream;
              if (u.readyState === WebSocket.OPEN) {
                if (u.bufferedAmount > 32 << 20) throw fail('mesh socket backpressure limit');
                u.send(data, { binary });
              } else {
                if (ws.data.queue.reduce((n, [x]) => n + x.length, 0) + data.length > 1 << 20)
                  throw fail('mesh socket is not ready');
                ws.data.queue.push([data, binary]);
              }
              return;
            }
            if (ws.data.route === 'terminal') return terms.message(ws, data, binary);
            if (ws.data.route === 'task' && binary) {
              ws.data.task?.input(data);
              return;
            }
            const value =
              ws.data.route === 'extension'
                ? decodeExtensionMessage(Buffer.from(data).toString())
                : JSON.parse(Buffer.from(data).toString());
            if (ws.data.route === 'collab') return collab.message(ws, value);
            if (ws.data.route === 'languages') {
              if (ws.data.lsp) return lspMessage(ws, value);
              return languages.serve(ws, value);
            }
            if (ws.data.route === 'task') {
              if (!ws.data.task) return taskStart(ws, value.task);
              if (value.type === 'resize') ws.data.task.resize(value.cols, value.rows);
              if (value.type === 'kill') ws.data.task.stop();
            }
            if (ws.data.route === 'extension') {
              if (!ws.data.extension) return startExtension(ws, value, files, machine);
              ws.data.extension.send(value);
            }
          })
          .catch((e) => error(ws, e));
      },
      close(ws) {
        sockets.delete(ws);
        ws.data.abort?.abort();
        ws.data.upstream?.terminate();
        if (ws.data.route === 'collab') collab.close(ws);
        if (ws.data.route === 'terminal') terms.close(ws);
        ws.data.task?.stop();
        ws.data.lsp?.proc.kill();
        ws.data.extension?.stop();
      },
    },
  });
  origin = service.url.origin;
  return {
    server: service,
    origin,
    machine,
    files,
    collab,
    terms,
    async stop() {
      for (const ws of sockets) ws.close(1001);
      collab.dispose();
      terms.dispose();
      await files.dispose();
      await closeSQLite();
      await service.stop(true);
    },
  };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  if (args[0] === '--extension-host') {
    const { extensionProcess } = await import('./extensions.js');
    await extensionProcess();
  } else if (args[0] === '--sqlite-worker') {
    const { sqliteProcess } = await import('./sqlite-worker.js');
    await sqliteProcess();
  } else if (args[0] === 'sulfur-sqlite') {
    const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
    try {
      console.log(JSON.stringify(await sqlite(input)));
    } catch (e) {
      console.log(JSON.stringify({ columns: [], rows: [], error: e.message }));
    } finally {
      await closeSQLite();
    }
  } else if (args[0] === 'sulfur-language') {
    const { languageCLI } = await import('./extensions.js');
    await languageCLI(args[1]);
  } else {
    const address = arg('--addr', arg('-addr', '127.0.0.1:47615')),
      i = address.lastIndexOf(':'),
      app = await createService({
        hostname: address.slice(0, i).replace(/^\[|\]$/g, ''),
        port: +address.slice(i + 1),
        configFile: arg('--config', arg('-config', undefined)) || undefined,
        dist: arg('--dist', undefined),
      });
    console.log(JSON.stringify({ type: 'ready', url: app.origin, version: pkg.version }));
    for (const sig of ['SIGINT', 'SIGTERM'])
      process.on(sig, () => app.stop().then(() => process.exit()));
    if (process.env.SULFUR_NATIVE === '1') {
      // The native owner keeps stdin open. An explicit shutdown or its death
      // closes this pipe, including when the OS forcibly ends the window.
      (async () => {
        for await (const chunk of Bun.stdin.stream()) {
          if (Buffer.from(chunk).includes(Buffer.from('shutdown'))) break;
        }
      })().finally(() => app.stop().then(() => process.exit()));
    }
  }
}
