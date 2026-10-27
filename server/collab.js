import { stat } from 'node:fs/promises';
import { opApply, opTransform, opBuilder, opMap } from '../web/src/text-operations.js';
import { fail, lf, MAX_TEXT } from './util.js';
const diskDiff = (before, after) => {
  let start = 0,
    tail = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start && /[\uDC00-\uDFFF]/.test(before[start] || '')) start--;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before.at(-tail - 1) === after.at(-tail - 1)
  )
    tail++;
  if (tail && /[\uDC00-\uDFFF]/.test(after[after.length - tail] || '')) tail--;
  const b = opBuilder();
  b.retain(start);
  b.insert(after.slice(start, after.length - tail));
  b.del(before.length - start - tail);
  b.retain(tail);
  return b.ops;
};
function validate(ops, length) {
  if (!Array.isArray(ops) || ops.length > MAX_TEXT) return false;
  let used = 0,
    inserted = 0;
  for (const o of ops) {
    if (typeof o === 'string') inserted += o.length;
    else if (Number.isSafeInteger(o) && o !== 0) used += Math.abs(o);
    else return false;
  }
  return used === length && inserted <= MAX_TEXT;
}
export class Collaboration {
  constructor(files) {
    this.files = files;
    this.sessions = new Map();
    this.sequence = 0;
    this.loading = new Map();
    this.watch = setInterval(() => this.checkDisk(), 300);
    this.watch.unref();
  }
  async attach(socket, share, rel) {
    const key = `${share}\n${rel}`;
    let s = this.sessions.get(key);
    if (!s) {
      if (this.loading.has(key)) {
        await this.loading.get(key);
        return this.attach(socket, share, rel);
      }
      let done;
      this.loading.set(
        key,
        new Promise((resolve) => {
          done = resolve;
        }),
      );
      try {
        const file = await this.files.read(share, rel);
        if (file.binary) throw fail('a binary file, not text', 415);
        if (file.tooBig) throw fail('over 16MB, too big to edit here', 413);
        s = {
          key,
          share,
          rel,
          text: lf(file.text),
          eol: file.text.includes('\r\n') ? '\r\n' : '\n',
          v: 0,
          saved: 0,
          history: [],
          clients: new Set(),
          diskText: lf(file.text),
          diskPending: '',
          diskProblem: '',
          conflict: false,
          revision: 0,
        };
        this.sessions.set(key, s);
      } finally {
        this.loading.delete(key);
        done();
      }
    }
    clearTimeout(s.idle);
    const c = { socket, id: ++this.sequence, pos: 0, name: '', color: '' };
    s.clients.add(c);
    socket.data.collab = { s, c };
    socket.send(
      JSON.stringify({
        type: 'init',
        text: s.text,
        v: s.v,
        saved: s.saved,
        eol: s.eol,
        people: this.people(s),
        you: c.id,
        perms: this.files.share(share).perms,
      }),
    );
    if (s.conflict) socket.send(JSON.stringify(this.diskMessage(s)));
    return s;
  }
  people(s) {
    return [...s.clients]
      .filter((c) => c.name)
      .map(({ id, name, color, pos, agent }) => ({
        id,
        name,
        color,
        pos,
        ...(agent ? { agent: true } : {}),
      }));
  }
  all(s, msg) {
    const data = JSON.stringify(msg);
    for (const c of s.clients) c.socket?.send(data);
  }
  diskMessage(s) {
    return {
      type: 'disk',
      conflict: s.conflict,
      text: s.diskPending,
      problem: s.diskProblem,
      revision: s.revision,
    };
  }
  commit(s, ops, id, c) {
    s.text = opApply(s.text, ops);
    s.v++;
    s.history.push(ops);
    if (s.history.length > 2000) s.history.shift();
    for (const p of s.clients) if (p !== c) p.pos = opMap(ops, p.pos);
    this.all(s, {
      type: 'op',
      v: s.v,
      ops,
      id,
      by: c.name || '',
      agent: !!c.agent,
      agentEdit: c.id,
    });
    this.saveSoon(s);
  }
  serial(s, fn) {
    const next = (s.chain || Promise.resolve()).then(fn);
    s.chain = next.catch(() => {});
    return next;
  }
  message(socket, msg) {
    return this.serial(socket.data.collab.s, () => this.messageNow(socket, msg));
  }
  async messageNow(socket, msg) {
    const { s, c } = socket.data.collab;
    if (msg.type === 'join') {
      c.name = String(msg.name || 'anon').slice(0, 32);
      c.color = String(msg.color || '').slice(0, 16);
      this.all(s, { type: 'people', people: this.people(s) });
    } else if (msg.type === 'cursor') {
      c.pos = Math.max(0, Math.min(s.text.length, Number(msg.pos) || 0));
      this.all(s, { type: 'people', people: this.people(s) });
    } else if (msg.type === 'save') await this.saveNow(s, c.name);
    else if (msg.type === 'eol') {
      s.eol = ['\r\n', 'CRLF'].includes(msg.eol) ? '\r\n' : '\n';
      s.eolPending = true;
      this.all(s, { type: 'eol', eol: s.eol });
      await this.saveNow(s, c.name);
    } else if (msg.type === 'resolveDisk') {
      if (!(await this.observe(s, true)))
        throw fail('file is changing on disk; saving will retry', 409);
      if (!s.conflict) return;
      if (msg.revision !== s.revision) {
        socket.send(JSON.stringify(this.diskMessage(s)));
        return;
      }
      if (msg.choice === 'reload') this.applyDisk(s, s.diskPending);
      else if (msg.choice === 'overwrite' || msg.choice === 'keep')
        await this.saveNow(s, c.name, true);
    } else if (msg.type === 'op') {
      const base = Number(msg.base),
        oldest = s.v - s.history.length;
      const resync = () =>
        socket.send(
          JSON.stringify({ type: 'resync', text: s.text, v: s.v, saved: s.saved, id: msg.id }),
        );
      if (!Number.isInteger(base) || base < oldest || base > s.v || !Array.isArray(msg.ops)) {
        resync();
        return;
      }
      let ops = msg.ops;
      try {
        for (const h of s.history.slice(base - oldest)) [ops] = opTransform(ops, h);
        if (!validate(ops, s.text.length)) throw fail('invalid operation');
        if (opApply(s.text, ops).length > MAX_TEXT) throw fail('over 16MB');
      } catch {
        resync();
        return;
      }
      this.commit(s, ops, msg.id, c);
    }
  }
  saveSoon(s) {
    if (s.conflict) return;
    clearTimeout(s.timer);
    s.dirtyAt ||= Date.now();
    s.timer = setTimeout(
      () => this.save(s, '').catch((e) => this.all(s, { type: 'error', error: e.message })),
      Math.max(0, Math.min(1500, s.dirtyAt + 10000 - Date.now())),
    );
    s.timer.unref();
  }
  save(s, by = '', reviewed = false) {
    return this.serial(s, () => this.saveNow(s, by, reviewed));
  }
  async saveNow(s, by = '', reviewed = false) {
    clearTimeout(s.timer);
    s.dirtyAt = 0;
    if (s.saved === s.v && !s.eolPending && !s.conflict) return { path: s.rel };
    const reviewedRevision = s.revision;
    if (!(await this.observe(s, true))) {
      this.saveSoon(s);
      throw fail('file is changing on disk; saving will retry', 409);
    }
    if (reviewed && reviewedRevision !== s.revision)
      throw fail('file changed again on disk; review both versions before saving', 409);
    if (s.conflict && !reviewed)
      throw fail('file changed on disk; resolve the conflict before saving', 409);
    const text = s.text,
      version = s.v;
    const out = await this.files.save(s.share, s.rel, {
      text: s.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text,
    });
    s.diskText = text;
    s.saved = version;
    s.conflict = false;
    s.diskPending = '';
    s.diskProblem = '';
    s.diskSignature = '';
    s.eolPending = false;
    this.all(s, { type: 'saved', v: version, by });
    this.all(s, this.diskMessage(s));
    return out;
  }
  async write(share, rel, p) {
    const s = this.sessions.get(`${share}\n${rel}`);
    if (!s?.clients.size) return this.files.save(share, rel, p);
    const c = {
      id: ++this.sequence,
      name: String(p.by?.name || 'phosphorus').slice(0, 32),
      color: String(p.by?.color || '').slice(0, 16),
      pos: 0,
      agent: true,
    };
    let typed;
    await this.serial(s, () => {
      let text = p.text;
      if (typeof p.old === 'string' && typeof p.new === 'string') {
        const old = lf(p.old),
          at = s.text.indexOf(old);
        if (!old || at < 0) throw fail('old text not found', 409);
        if (s.text.indexOf(old, at + 1) >= 0)
          throw fail('old text found more than once, give more of it', 409);
        text = s.text.slice(0, at) + lf(p.new) + s.text.slice(at + old.length);
      }
      if (typeof text !== 'string') throw fail('text, or old and new');
      text = lf(text);
      if (text.length > MAX_TEXT) throw fail('over 16MB', 413);
      const ops = diskDiff(s.text, text);
      let at = 0,
        gone = 0;
      typed = '';
      for (const o of ops) {
        if (typeof o === 'string') typed += o;
        else if (o < 0) gone -= o;
        else if (!typed && !gone) at += o;
      }
      // diskDiff may be a no-op retain; only clamp the insertion position.
      c.pos = Math.min(at, s.text.length);
      s.clients.add(c);
      clearTimeout(s.idle);
      this.all(s, { type: 'people', people: this.people(s) });
      if (gone) this.put(s, c, gone, '');
    });
    try {
      const step = Math.max(1, Math.ceil(typed.length / 24));
      for (let i = 0; i < typed.length; ) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        let end = Math.min(typed.length, i + step);
        if (end < typed.length && /[\uDC00-\uDFFF]/.test(typed[end])) end++;
        const part = typed.slice(i, end);
        i = end;
        await this.serial(s, () => this.put(s, c, 0, part));
      }
      const out = await this.save(s, c.name);
      return { ...out, live: true, note: 'typed into the open editor and saved' };
    } finally {
      c.linger = setTimeout(() => {
        s.clients.delete(c);
        this.all(s, { type: 'people', people: this.people(s) });
      }, 10000);
      c.linger.unref();
    }
  }
  put(s, c, gone, text) {
    const at = Math.min(c.pos, s.text.length),
      b = opBuilder();
    b.retain(at);
    b.insert(text);
    b.del(gone);
    b.retain(s.text.length - at - gone);
    c.pos = at + text.length;
    this.commit(s, b.ops, `agent-${Date.now()}`, c);
    this.all(s, { type: 'people', people: this.people(s) });
  }
  applyDisk(s, text) {
    const ops = diskDiff(s.text, text);
    this.commit(s, ops, undefined, { name: 'disk', id: 0 });
    clearTimeout(s.timer);
    s.saved = s.v;
    s.diskText = text;
    s.conflict = false;
    s.diskPending = '';
    s.diskProblem = '';
    this.all(s, { type: 'saved', v: s.v, by: 'disk' });
    this.all(s, this.diskMessage(s));
  }
  async observe(s, force = false) {
    try {
      const info = await stat(await this.files.resolve(s.share, s.rel));
      if (Date.now() - info.mtimeMs < 150) return false;
      const signature = `${info.ino}:${info.mtimeMs}:${info.size}`;
      if (!force && signature === s.diskSignature) return true;
      const file = await this.files.read(s.share, s.rel);
      if (file.binary || file.tooBig)
        throw fail(
          'The disk file is binary or too large to reload. The editor version has been preserved.',
        );
      const after = await stat(await this.files.resolve(s.share, s.rel));
      if (`${after.ino}:${after.mtimeMs}:${after.size}` !== signature) return false;
      const text = lf(file.text);
      s.diskSignature = signature;
      if (text === s.diskText || text === s.text) {
        if (text === s.text && s.saved !== s.v) {
          s.saved = s.v;
          this.all(s, { type: 'saved', v: s.v, by: 'disk' });
        }
        if (s.conflict) {
          s.conflict = false;
          s.diskPending = '';
          s.diskProblem = '';
          s.revision++;
          this.all(s, this.diskMessage(s));
          if (s.saved !== s.v) this.saveSoon(s);
        }
        return true;
      }
      if (s.saved !== s.v) {
        if (s.conflict && s.diskPending === text && !s.diskProblem) return true;
        s.conflict = true;
        s.diskPending = text;
        s.diskProblem = '';
        s.revision++;
        clearTimeout(s.timer);
        this.all(s, this.diskMessage(s));
      } else {
        s.eol = file.text.includes('\r\n') ? '\r\n' : '\n';
        this.applyDisk(s, text);
      }
      return true;
    } catch (error) {
      if (s.diskProblem !== error.message) {
        s.diskProblem = error.message;
        s.conflict = true;
        s.revision++;
        clearTimeout(s.timer);
        this.all(s, this.diskMessage(s));
      }
      return true;
    }
  }
  async checkDisk() {
    for (const s of this.sessions.values())
      if (s.clients.size && !s.checking) {
        s.checking = true;
        this.serial(s, () => this.observe(s)).finally(() => {
          s.checking = false;
        });
      }
  }
  close(socket) {
    const v = socket.data.collab;
    if (!v) return;
    const { s, c } = v;
    s.clients.delete(c);
    this.all(s, { type: 'people', people: this.people(s) });
    if (!s.clients.size) {
      s.idle = setTimeout(
        () =>
          this.save(s).then(
            () => this.sessions.delete(s.key),
            () => {},
          ),
        60000,
      );
      s.idle.unref();
    }
  }
  dispose() {
    clearInterval(this.watch);
    for (const s of this.sessions.values()) {
      clearTimeout(s.timer);
      clearTimeout(s.idle);
      for (const c of s.clients) clearTimeout(c.linger);
    }
  }
}
export { diskDiff, validate };
