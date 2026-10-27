import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rename,
  rm,
  lstat,
  chmod,
  stat,
  mkdtemp,
  realpath,
} from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { httpsGet, fetchVSIX, platform } from './registry.js';
import { atomicJSON, readJSON, command, exists, fail, inside, safePath } from './util.js';
const win = process.platform === 'win32',
  suffix = win ? '.exe' : '';
export const languageHome = () =>
  process.env.SULFUR_LANGUAGE_HOME || path.join(os.homedir(), '.sulfur/languages');
export const catalog = [
  {
    id: 'typescript',
    name: 'TypeScript',
    server: 'TypeScript Language Server',
    packages: ['typescript-language-server', 'typescript'],
    entry: 'typescript-language-server/lib/cli.mjs',
    prerequisites: 'Node.js 22+ and npm',
  },
  {
    id: 'python',
    name: 'Python',
    server: 'Pyright',
    packages: ['pyright'],
    entry: 'pyright/langserver.index.js',
    prerequisites:
      'Node.js 22+ and npm; select a project virtual environment in pyrightconfig.json',
  },
  {
    id: 'javascript',
    name: 'JavaScript',
    server: 'TypeScript Language Server',
    packages: ['typescript-language-server', 'typescript'],
    entry: 'typescript-language-server/lib/cli.mjs',
    prerequisites: 'Node.js 22+ and npm',
  },
  {
    id: 'java',
    name: 'Java',
    server: 'Eclipse JDT LS',
    prerequisites: 'JDK 21+ (JAVA_HOME or java on PATH)',
  },
  { id: 'csharp', name: 'C#', server: 'csharp-ls', prerequisites: '.NET 10 SDK' },
  {
    id: 'php',
    name: 'PHP',
    server: 'Intelephense',
    packages: ['intelephense'],
    entry: 'intelephense/lib/intelephense.js',
    prerequisites: 'Node.js 22+ and npm',
  },
  {
    id: 'shell',
    name: 'Shell (Bash)',
    server: 'Bash Language Server',
    packages: ['bash-language-server'],
    entry: 'bash-language-server/out/cli.js',
    prerequisites: 'Node.js 22+, npm and Bash',
  },
  {
    id: 'cpp',
    name: 'C / C++',
    server: 'clangd',
    prerequisites: 'C/C++ toolchain and compile_commands.json',
  },
  {
    id: 'hcl',
    name: 'HCL / Terraform',
    server: 'terraform-ls',
    prerequisites: 'Terraform CLI recommended',
  },
  {
    id: 'go',
    name: 'Go',
    server: 'gopls',
    prerequisites: 'current Go SDK; installation compiles gopls',
  },
];
export class LSPFramer {
  constructor(receive) {
    this.buffer = Buffer.alloc(0);
    this.receive = receive;
    this.size = null;
  }
  push(data) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
    for (;;) {
      if (this.size === null) {
        const i = this.buffer.indexOf('\r\n\r\n');
        if (i < 0) {
          if (this.buffer.length > 65536) throw fail('Invalid LSP Content-Length');
          return;
        }
        const m = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, i).toString());
        if (!m || +m[1] > 32 << 20) throw fail('Invalid LSP Content-Length');
        this.size = +m[1];
        this.buffer = this.buffer.subarray(i + 4);
      }
      if (this.buffer.length < this.size) return;
      const body = this.buffer.subarray(0, this.size);
      this.buffer = this.buffer.subarray(this.size);
      this.size = null;
      this.receive(JSON.parse(body.toString()));
    }
  }
}
export const frameLSP = (value) => {
  const data = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`), data]);
};
async function unpack(data, destination) {
  const files = new Map();
  if (data[0] === 0x50 && data[1] === 0x4b) {
    let total = 0;
    const content = unzipSync(data, {
      filter(f) {
        if (f.originalSize > 128 << 20 || (total += f.originalSize) > 512 << 20)
          throw fail('archive exceeds size limit');
        return !f.name.endsWith('/');
      },
    });
    for (const [p, b] of Object.entries(content)) files.set(p, b);
  } else {
    const tar = gunzipSync(data, { maxOutputLength: 512 << 20 });
    let pending = {},
      global = {},
      longName = '';
    const field = (header, start, size) =>
      header
        .subarray(start, start + size)
        .toString()
        .split('\0')[0];
    for (let at = 0; at + 512 <= tar.length; ) {
      const header = tar.subarray(at, at + 512),
        base = field(header, 0, 100),
        prefix = field(header, 345, 155);
      if (!base) break;
      const type = header[156],
        metadata = type === 120 || type === 103 || type === 76;
      const attrs = { ...global, ...pending },
        name = longName || attrs.path || (prefix ? `${prefix}/${base}` : base);
      const size = Number(
        !metadata && attrs.size !== undefined
          ? attrs.size
          : parseInt(field(header, 124, 12).trim(), 8) || 0,
      );
      if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
        throw fail('invalid tar entry size');
      const body = tar.subarray(at + 512, at + 512 + size);
      if (type === 120 || type === 103) {
        const attrs = {};
        for (let i = 0; i < body.length; ) {
          const space = body.indexOf(32, i),
            count = Number(body.subarray(i, space).toString());
          if (
            space < 0 ||
            !Number.isSafeInteger(count) ||
            count <= space - i ||
            i + count > body.length
          )
            throw fail('invalid PAX record');
          const text = body.subarray(space + 1, i + count - 1).toString(),
            eq = text.indexOf('=');
          if (eq > 0) attrs[text.slice(0, eq)] = text.slice(eq + 1);
          i += count;
        }
        if (type === 103) global = { ...global, ...attrs };
        else pending = attrs;
      } else if (type === 76) longName = body.toString().replace(/\0.*$/s, '').trimEnd();
      else {
        if (type === 0 || type === 48) files.set(name, body);
        else if (type !== 53) throw fail('archive links are not accepted');
        pending = {};
        longName = '';
      }
      at += 512 + Math.ceil(size / 512) * 512;
    }
  }
  for (const [name, data] of files) {
    const target = await safePath(destination, name, true);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o755 });
  }
}
export class LanguageHost {
  constructor(home = languageHome()) {
    this.home = home;
  }
  async load(id) {
    return readJSON(path.join(this.home, id, 'manifest.json'));
  }
  async status() {
    const out = [];
    for (const item of catalog) {
      const manifest = await this.load(item.id);
      out.push({ ...item, installed: !!manifest, enabled: manifest?.enabled === true, manifest });
    }
    for (const id of await readdir(this.home).catch(() => []))
      if (/^vsx\.[a-z0-9][a-z0-9._-]{0,120}$/.test(id)) {
        const m = await this.load(id);
        if (m?.custom)
          out.push({
            id,
            name: m.name,
            server: m.server,
            prerequisites: m.runtime === 'node' ? 'Node.js on PATH' : '',
            installed: true,
            enabled: !!m.enabled,
            manifest: m,
            custom: true,
            extensions: m.extensions,
            filenames: m.filenames,
            languageIds: m.languageIds,
          });
      }
    return out;
  }
  async serve(socket, request) {
    const emit = (kind, value = {}) => socket.send(JSON.stringify({ _sulfur: kind, ...value }));
    socket.data.languageEmit = emit;
    if (request.op === 'status') {
      emit('status', { extensions: await this.status(), platform: platform() });
      socket.close(1000);
      return;
    }
    if (
      !/^(?:typescript|javascript|python|java|csharp|php|shell|cpp|hcl|go|vsx\.[a-z0-9][a-z0-9._-]{0,120})$/.test(
        request.language || '',
      )
    )
      throw fail('Unknown language');
    const id = request.language,
      item = catalog.find((x) => x.id === id) || {
        id,
        name: request.server?.name,
        server: request.server?.name,
        custom: true,
      };
    if (request.op === 'launch') {
      await this.launch(socket, item, request, emit);
      return;
    }
    await mkdir(this.home, { recursive: true });
    const lock = path.join(this.home, `.lock-${id}`);
    await mkdir(lock).catch(() => {
      throw fail('Another operation is using this extension; retry when it finishes');
    });
    try {
      const target = path.join(this.home, id);
      if ((await lstat(target).catch(() => null))?.isSymbolicLink())
        throw fail('Refusing a symlink installation directory');
      if (request.op === 'install')
        await this.install(item, request.server, emit, socket.data.abort?.signal);
      else if (request.op === 'uninstall') await rm(target, { recursive: true, force: true });
      else if (['enable', 'disable'].includes(request.op)) {
        const m = await this.load(id);
        if (!m) throw fail('Install the extension first');
        m.enabled = request.op === 'enable';
        await atomicJSON(path.join(target, 'manifest.json'), m);
      } else throw fail('Unknown operation');
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
    emit('status', { extensions: await this.status(), platform: platform() });
    socket.close(1000);
  }
  async install(item, server, emit, signal) {
    const stage = await mkdtemp(path.join(this.home, '.install-')),
      target = path.join(this.home, item.id),
      backup = path.join(this.home, `.old-${item.id}-${crypto.randomUUID()}`),
      m = { enabled: true, server: item.server, platform: platform() };
    let moved = false;
    const run = async (args, env) => {
      emit('log', { text: `Installing ${item.server}` });
      const r = await command(args, { cwd: stage, env, timeout: 600000, signal });
      if (r.code) throw fail(r.err || r.out || 'installation failed');
    };
    const download = async (url) => {
      const data = await httpsGet(url, { signal, limit: 256 << 20 });
      (m.artifacts ||= []).push({ url, sha256: createHash('sha256').update(data).digest('hex') });
      await unpack(data, stage);
    };
    try {
      if (server) {
        const dl =
          server.downloads?.[platform()] || server.downloads?.universal || server.downloads?.web;
        if (!dl) throw fail('No server package for this platform');
        const { data, sum } = await fetchVSIX(dl, signal);
        await unpack(data, stage);
        Object.assign(m, server, {
          custom: true,
          name: server.name,
          server: server.name,
          sha256: sum,
        });
      } else if (item.packages) {
        await writeFile(path.join(stage, 'package.json'), '{"private":true}');
        const npm = Bun.which('npm');
        if (!npm) throw fail('npm is not on PATH');
        await run(
          win
            ? [
                'cmd.exe',
                '/d',
                '/s',
                '/c',
                `"${npm}" install --no-audit --no-fund ${item.packages.join(' ')}`,
              ]
            : [npm, 'install', '--no-audit', '--no-fund', ...item.packages],
        );
        m.entry = `node_modules/${item.entry}`;
        m.packages = {};
        for (const pkg of item.packages) {
          const meta = await readJSON(path.join(stage, 'node_modules', pkg, 'package.json'));
          m.packages[pkg] = meta?.version;
        }
      } else if (item.id === 'go') {
        await run(['go', 'install', 'golang.org/x/tools/gopls@latest'], { GOBIN: stage });
        m.entry = 'gopls' + suffix;
      } else if (item.id === 'csharp') {
        await run(['dotnet', 'tool', 'install', 'csharp-ls', '--tool-path', stage]);
        m.entry = 'csharp-ls' + suffix;
      } else if (item.id === 'cpp') {
        const existing = Bun.which('clangd');
        if (existing) Object.assign(m, { entry: existing, external: true });
        else {
          if (process.arch !== 'x64')
            throw fail('Install a native clangd on PATH for this architecture, then retry');
          const release = JSON.parse(
            (
              await httpsGet('https://api.github.com/repos/clangd/clangd/releases/latest', {
                signal,
              })
            ).toString(),
          );
          const osname = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
          const asset = release.assets.find(
            (x) => x.name.startsWith(`clangd-${osname}-`) && x.name.endsWith('.zip'),
          );
          if (!asset) throw fail('No clangd release for this platform');
          await download(asset.browser_download_url);
          m.entry = await findFile(stage, (n) => n === 'clangd' + suffix);
        }
      } else if (item.id === 'hcl') {
        const v = JSON.parse(
          (
            await httpsGet('https://checkpoint-api.hashicorp.com/v1/check/terraform-ls', { signal })
          ).toString(),
        ).current_version;
        await download(
          `https://releases.hashicorp.com/terraform-ls/${v}/terraform-ls_${v}_${win ? 'windows' : process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}.zip`,
        );
        m.entry = 'terraform-ls' + suffix;
      } else if (item.id === 'java') {
        const java = javaPath();
        const ver = await command([java, '-version']);
        if (Number(/version\s+"(\d+)/.exec(ver.err + ver.out)?.[1]) < 21)
          throw fail('JDT LS requires JDK 21 or newer');
        const base = 'https://download.eclipse.org/jdtls/milestones/';
        const html = (await httpsGet(base, { signal })).toString();
        const versions = [...html.matchAll(/href="(\d+\.\d+\.\d+)\//g)]
          .map((m) => m[1])
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!versions.length) throw fail('Eclipse JDT LS download service is unavailable');
        const url = base + versions.at(-1) + '/';
        const listing = (await httpsGet(url, { signal })).toString();
        const artifact = /jdt-language-server-[\w.-]+\.tar\.gz/.exec(listing)?.[0];
        if (!artifact) throw fail('Eclipse JDT LS download service is unavailable');
        await download(url + artifact);
        m.entry = 'jdtls';
      }
      if (server?.transport === 'ipc')
        await writeFile(
          path.join(stage, 'sulfur-ipc-bridge.cjs'),
          await readFile(
            process.env.SULFUR_IPC_BRIDGE || new URL('./lsp-ipc.cjs', import.meta.url),
          ),
        );
      await atomicJSON(path.join(stage, 'manifest.json'), m);
      if (signal?.aborted) throw signal.reason;
      if (await exists(target)) {
        await rename(target, backup);
        moved = true;
      }
      try {
        await rename(stage, target);
      } catch (error) {
        if (moved) await rename(backup, target);
        throw error;
      }
      if (moved) await rm(backup, { recursive: true, force: true });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  async launch(socket, item, request, emit) {
    const m = await this.load(item.id);
    if (!m?.enabled) throw fail('Extension is not installed and enabled');
    if (!path.isAbsolute(request.root || '') || !(await stat(request.root)).isDirectory())
      throw fail('Open an existing absolute project folder on this host');
    const root = await realpath(request.root),
      folder = path.join(this.home, item.id),
      entry = item.id === 'java' ? '' : m.external ? m.entry : await safePath(folder, m.entry);
    let argv;
    if (item.custom || m.custom) {
      argv =
        m.runtime === 'node'
          ? [
              nodePath(),
              ...(m.transport === 'ipc' ? [path.join(folder, 'sulfur-ipc-bridge.cjs')] : []),
              entry,
              ...(m.args || []),
            ]
          : [entry, ...(m.args || [])];
    } else if (item.packages)
      argv = [
        nodePath(),
        entry,
        ...(['typescript', 'javascript', 'python', 'php'].includes(item.id)
          ? [
              '--stdio',
              ...(['typescript', 'javascript'].includes(item.id)
                ? ['--tsserver-path', path.join(folder, 'node_modules/typescript/lib/tsserver.js')]
                : []),
            ]
          : item.id === 'shell'
            ? ['start']
            : []),
      ];
    else if (item.id === 'java') {
      const jar = await findFile(
        folder,
        (n) => n.startsWith('org.eclipse.equinox.launcher_') && n.endsWith('.jar'),
      );
      if (!jar) throw fail('The JDT LS launcher is missing; reinstall the extension');
      const system = win ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
      let config = path.join(folder, `config_${system}${process.arch === 'arm64' ? '_arm' : ''}`);
      if (!(await exists(config))) config = path.join(folder, `config_${system}`);
      const cache = path.join(
        this.home,
        '.workspaces',
        createHash('sha256')
          .update(request.root + (request.configuration || ''))
          .digest('hex')
          .slice(0, 24),
      );
      argv = [
        javaPath(),
        '-Declipse.application=org.eclipse.jdt.ls.core.id1',
        '-Dosgi.bundles.defaultStartLevel=4',
        '-Declipse.product=org.eclipse.jdt.ls.core.product',
        '-Xmx1G',
        '--add-modules=ALL-SYSTEM',
        '--add-opens',
        'java.base/java.util=ALL-UNNAMED',
        '--add-opens',
        'java.base/java.lang=ALL-UNNAMED',
        '-jar',
        path.join(folder, jar),
        '-configuration',
        config,
        '-data',
        cache,
      ];
    } else
      argv = [
        entry,
        ...(item.id === 'cpp'
          ? [
              '--background-index',
              ...(request.buildDirectory
                ? [`--compile-commands-dir=${request.buildDirectory}`]
                : []),
            ]
          : item.id === 'hcl'
            ? ['serve']
            : []),
      ];
    const proc = Bun.spawn(argv, {
      cwd: root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    socket.data.lsp = { proc, root, manifest: m, folder, virtual: new Set() };
    emit('ready', { rootUri: pathToFileURL(root).href });
    const framer = new LSPFramer((msg) => {
      rememberURIs(msg, socket.data.lsp.virtual);
      socket.send(JSON.stringify(msg));
    });
    (async () => {
      try {
        for await (const data of proc.stdout) framer.push(data);
      } catch (e) {
        emit('error', { error: e.message });
        proc.kill();
      }
    })();
    (async () => {
      for await (const data of proc.stderr) emit('log', { text: Buffer.from(data).toString() });
    })();
    proc.exited.then((code) => {
      emit('stopped', { code });
      socket.close(1000);
    });
  }
}
function nodePath() {
  const node = Bun.which('node');
  if (!node) throw fail('Node.js is not on PATH');
  return node;
}
function javaPath() {
  return process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin/java' + suffix)
    : Bun.which('java') || 'java';
}
async function findFile(root, predicate) {
  for (const ent of await readdir(root, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const found = await findFile(path.join(root, ent.name), predicate);
      if (found) return path.join(ent.name, found);
    } else if (predicate(ent.name)) return ent.name;
  }
  return '';
}
function rememberURIs(v, set) {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'uri' || k === 'targetUri') && typeof x === 'string' && x.startsWith('csharp:'))
      set.add(x);
    else rememberURIs(x, set);
  }
}
export async function lspMessage(socket, message) {
  const lsp = socket.data.lsp,
    doc = message.params?.textDocument?.uri;
  if (doc) {
    const virtualRead =
      lsp.virtual.has(doc) &&
      [
        'csharp/metadata',
        'textDocument/semanticTokens/full',
        'textDocument/definition',
        'textDocument/hover',
        'textDocument/documentSymbol',
      ].includes(message.method);
    if (!virtualRead) {
      let file;
      try {
        const uri = new URL(doc);
        if (uri.protocol !== 'file:' || uri.host) throw fail('document is outside this project');
        file = fileURLToPath(uri);
      } catch {
        throw fail('document is outside this project');
      }
      if (!inside(lsp.root, file)) throw fail('document is outside this project');
      await safePath(lsp.root, path.relative(lsp.root, file), true);
    }
  }
  if (message.method === 'initialize' && lsp.manifest.initializationOptions) {
    const expand = (v) =>
      typeof v === 'string'
        ? v.replaceAll('${extensionPath}', path.join(lsp.folder, 'extension'))
        : Array.isArray(v)
          ? v.map(expand)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
            : v;
    message.params = {
      ...message.params,
      initializationOptions: {
        ...expand(lsp.manifest.initializationOptions),
        ...message.params?.initializationOptions,
      },
    };
  }
  lsp.proc.stdin.write(frameLSP(message));
  await lsp.proc.stdin.flush();
}
export { unpack };
