import path from 'node:path';
import os from 'node:os';
import {
  readdir,
  stat,
  lstat,
  opendir,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  open,
  realpath,
} from 'node:fs/promises';
import { MAX_TEXT, fail, safePath, limitedBody, exists } from './util.js';

export async function localMachine() {
  const home = os.homedir(),
    host =
      os
        .hostname()
        .split('.')[0]
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '') || 'this-computer';
  const roots =
    process.platform === 'win32'
      ? (
          await Promise.all(
            Array.from({ length: 26 }, (_, n) => `${String.fromCharCode(n + 65)}:\\`).map(
              async (p) => ((await exists(p)) ? p : null),
            ),
          )
        ).filter(Boolean)
      : ['/'];
  const shares = [
    { id: 'home', label: path.dirname(home), root: path.dirname(home), perms: 'rwd', home: true },
    ...roots.map((root, i) => ({ id: String(i), label: root, root, perms: 'rwd' })),
  ];
  return {
    user: path.basename(home),
    host,
    platform: process.platform === 'win32' ? 'windows' : process.platform,
    shell: process.platform === 'win32' ? 'powershell' : 'sh',
    shares,
    info: {
      platform: process.platform === 'win32' ? 'windows' : process.platform,
      shell: process.platform === 'win32' ? 'powershell' : 'sh',
      files: { shares: shares.map(({ root, ...s }) => s) },
    },
  };
}
export class Files {
  constructor(machine) {
    this.machine = machine;
    this.uploads = new Map();
  }
  share(id = '0') {
    const sh = this.machine.shares.find((s) => s.id === id);
    if (!sh) throw fail('no such folder here', 404);
    return sh;
  }
  async resolve(id, rel, write = false) {
    return safePath(this.share(id).root, rel, write);
  }
  async read(id, rel) {
    const p = await this.resolve(id, rel),
      info = await stat(p);
    if (!info.isFile()) throw fail('not a file');
    if (info.size > MAX_TEXT) return { path: rel, size: info.size, tooBig: true };
    const data = await readFile(p);
    if (data.includes(0)) return { path: rel, size: info.size, binary: true };
    return { path: rel, size: info.size, text: data.toString('utf8') };
  }
  async entries(id, rel = '') {
    const dir = await this.resolve(id, rel),
      ents = await readdir(dir, { withFileTypes: true }),
      entries = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, ents.length) }, async () => {
        while (cursor < ents.length) {
          const ent = ents[cursor++];
          if (ent.name.startsWith('.phosphorus-upload-')) continue;
          const file = path.join(dir, ent.name);
          try {
            const info = await lstat(file),
              link = info.isSymbolicLink();
            const target = link ? await stat(file).catch(() => null) : info;
            const e = {
              name: ent.name,
              dir: target?.isDirectory() || false,
              link,
              size: target?.isFile() ? target.size : null,
              mtime: target ? Math.round(target.mtimeMs) : null,
            };
            if (e.dir && !link) {
              const folder = await opendir(file).catch(() => null);
              if (folder) {
                try {
                  e.empty = !(await folder.read());
                } finally {
                  await folder.close();
                }
              }
            }
            entries.push(e);
          } catch {}
        }
      }),
    );
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  async list(id, rel = '') {
    const entries = await this.entries(id, rel);
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: rel, entries: entries.slice(0, 5000), truncated: entries.length > 5000 };
  }
  async tree(id, rel = '', { depth = 1, match = '', skip = '' } = {}) {
    const entries = [],
      want = match ? globRE(match) : null,
      skipped = skipper(skip);
    const maxDepth = Math.min(8, Math.max(1, Math.trunc(Number(depth)) || 1));
    let level = [rel],
      truncated = false;
    for (let lv = 1; lv <= maxDepth && level.length && !truncated; lv++) {
      const next = [];
      for (const dir of level) {
        const children = await this.entries(id, dir).catch((error) => {
          if (dir === rel) throw error;
          return [];
        });
        for (const e of children) {
          if (e.dir && skipped(e.name)) continue;
          const p = path.posix.join(dir, e.name);
          if (e.dir && !e.link) next.push(p);
          if (want && !want.test(e.name)) continue;
          if (entries.length >= 60000) {
            truncated = true;
            break;
          }
          entries.push({
            path: p + (e.dir ? '/' : ''),
            ...(!e.dir ? { size: e.size } : {}),
            mtime: e.mtime,
          });
        }
        if (truncated) break;
      }
      level = next;
    }
    return { path: rel, depth: maxDepth, entries, ...(truncated ? { truncated: true } : {}) };
  }
  async search(id, rel, { query = '', content = false, glob = '', skip = '' } = {}) {
    const q = query.trim().toLowerCase(),
      want = glob ? globRE(glob) : null,
      skipped = skipper(skip),
      results = [];
    if (!q && !glob) throw fail('a query or a glob');
    let scanned = 0,
      truncated = false;
    const walk = async (dir) => {
      for (const e of await this.entries(id, dir).catch(() => [])) {
        if (e.dir && skipped(e.name)) continue;
        if (++scanned > 50000 || results.length >= 200) {
          truncated = true;
          return;
        }
        const p = path.posix.join(dir, e.name);
        if (!want || want.test(e.name)) {
          if (!content && (!q || e.name.toLowerCase().includes(q)))
            results.push({ path: p + (e.dir ? '/' : '') });
          else if (content && !e.dir && !e.link && e.size <= 1 << 20) {
            const file = await this.read(id, p).catch(() => null),
              matches = [];
            if (file?.text)
              for (const [i, line] of file.text.split('\n').entries()) {
                if (!line.toLowerCase().includes(q)) continue;
                const text = [...line.trim()];
                matches.push({
                  line: i + 1,
                  text: text.length > 240 ? text.slice(0, 240).join('') + '…' : line.trim(),
                });
                if (matches.length >= 5) break;
              }
            if (matches.length) results.push({ path: p, matches });
          }
        }
        if (e.dir && !e.link) await walk(p);
        if (truncated) return;
      }
    };
    await this.resolve(id, rel);
    await walk(rel);
    return { path: rel, results, ...(truncated ? { truncated: true } : {}) };
  }
  async save(id, rel, p) {
    const target = await this.resolve(id, rel, true);
    let text = p.text;
    if (typeof p.old === 'string' && typeof p.new === 'string') {
      const current = await readFile(target, 'utf8');
      const i = current.indexOf(p.old);
      if (!p.old || i < 0) throw fail('old text not found', 409);
      if (current.indexOf(p.old, i + 1) >= 0)
        throw fail('old text found more than once, give more of it', 409);
      text = current.slice(0, i) + p.new + current.slice(i + p.old.length);
    }
    if (typeof text !== 'string') throw fail('text, or old and new');
    if (Buffer.byteLength(text) > MAX_TEXT) throw fail('over 16MB', 413);
    await mkdir(path.dirname(target), { recursive: true });
    // Preserve file permissions and the inode, including existing editor handles.
    await writeFile(target, text);
    return { ok: true, path: rel, size: Buffer.byteLength(text) };
  }
  async upload(id, rel, req, q) {
    const target = await this.resolve(id, rel, true);
    await mkdir(path.dirname(target), { recursive: true });
    const size = Number(q.get('total')),
      offset = Number(q.get('offset') || 0),
      upload = q.get('id');
    if (!upload) {
      const data = await limitedBody(req.body, 64 << 20);
      await writeFile(target, data);
      return { ok: true, path: rel, size: data.length };
    }
    if (
      !/^[a-z0-9]{1,80}$/i.test(upload) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 64 * 2 ** 30 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw fail('invalid upload');
    const key = `${id}\n${rel}\n${upload}`;
    let state = this.uploads.get(key);
    if (!state) {
      if (offset !== 0) throw fail('upload offset mismatch', 409);
      const temp = path.join(path.dirname(target), `.phosphorus-upload-${upload}`);
      const file = await open(temp, 'wx', 0o600);
      state = { file, temp, offset: 0, total: size, timer: null, busy: false };
      this.uploads.set(key, state);
      this.expireUpload(key, state);
    }
    if (state.busy || state.offset !== offset || state.total !== size)
      throw fail('upload offset mismatch', 409);
    state.busy = true;
    try {
      const data = await limitedBody(req.body, 8 << 20);
      if (offset + data.length > size) throw fail('upload exceeds total');
      try {
        for (let at = 0; at < data.length; ) {
          const { bytesWritten } = await state.file.write(data, at, data.length - at, offset + at);
          if (!bytesWritten) throw fail('upload write failed');
          at += bytesWritten;
        }
        state.offset += data.length;
        this.expireUpload(key, state);
        if (state.offset === size) {
          clearTimeout(state.timer);
          await state.file.close();
          await rename(state.temp, target);
          this.uploads.delete(key);
        }
      } catch (error) {
        await this.dropUpload(key, state);
        throw error;
      }
      return state.offset === size ? { ok: true, path: rel } : { ok: true, next: state.offset };
    } finally {
      state.busy = false;
    }
  }
  expireUpload(key, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (state.busy) this.expireUpload(key, state);
      else this.dropUpload(key, state);
    }, 600000);
    state.timer.unref();
  }
  async dropUpload(key, state) {
    clearTimeout(state.timer);
    this.uploads.delete(key);
    await state.file.close().catch(() => {});
    await rm(state.temp, { force: true }).catch(() => {});
  }
  async dispose() {
    await Promise.all([...this.uploads].map(([key, state]) => this.dropUpload(key, state)));
  }
  async mutate(id, op, p) {
    const target = await this.resolve(id, op === 'rename' ? p.from : p.path, true);
    if (path.resolve(target) === path.resolve(this.share(id).root))
      throw fail("can't modify the share itself");
    if (op === 'mkdir') await mkdir(target, { recursive: true });
    else if (op === 'rename') {
      const dest = await this.resolve(id, p.to, true);
      if (await exists(dest)) throw fail('destination exists', 409);
      await rename(target, dest);
    } else if (op === 'delete') await rm(target, { recursive: true });
    else throw fail('method not allowed', 405);
    return { ok: true, path: p.to || p.path };
  }
}

export function globRE(pattern) {
  return new RegExp(
    '^' +
      [...pattern]
        .map((c) =>
          c === '*' ? '.*' : c === '?' ? '.' : '.+^${}()|[]\\'.includes(c) ? '\\' + c : c,
        )
        .join('') +
      '$',
    'i',
  );
}
const skipper = (skip) => {
  const patterns = skip
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(globRE);
  return (name) => patterns.some((re) => re.test(name));
};
