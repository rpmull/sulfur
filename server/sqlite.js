import { StringDecoder } from 'node:string_decoder';
import { selfCommand } from './extensions.js';

// A native SQLite call can block a JavaScript worker's event loop. OS processes
// make the deadline enforceable even then. Reuse two processes between jobs.
export class SQLitePool {
  constructor({ timeout = 10000, concurrency = 2 } = {}) {
    this.timeout = timeout;
    this.concurrency = concurrency;
    this.slots = [];
    this.queue = [];
    this.sequence = 0;
    this.closed = false;
  }
  run(request, { signal } = {}) {
    if (this.closed) return Promise.reject(new Error('SQLite host stopped'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.queue.length >= 64) return Promise.reject(new Error('SQLite host is busy'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, request, resolve, reject, signal };
      job.abort = () => {
        const slot = this.slots.find((slot) => slot.job === job);
        if (slot) this.reset(slot, new Error('SQLite query cancelled'));
        else {
          const at = this.queue.indexOf(job);
          if (at >= 0) this.queue.splice(at, 1);
          signal?.removeEventListener('abort', job.abort);
          reject(new Error('SQLite query cancelled'));
        }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }
  spawn() {
    const proc = Bun.spawn(selfCommand('--sqlite-worker'), {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    const slot = { proc, job: null, stderr: '' };
    this.slots.push(slot);
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    (async () => {
      for await (const chunk of proc.stdout) {
        buffered += decoder.write(Buffer.from(chunk));
        if (buffered.length > 16 << 20) throw new Error('SQLite response exceeds limit');
        let at;
        while ((at = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          if (!line) continue;
          const reply = JSON.parse(line),
            job = slot.job;
          if (!job || reply.id !== job.id) throw new Error('Invalid SQLite response');
          this.finish(job);
          slot.job = null;
          proc.unref();
          if (reply.error) job.reject(new Error(reply.error));
          else job.resolve(reply.value);
          this.pump();
        }
      }
    })().catch((error) => this.reset(slot, error));
    (async () => {
      for await (const chunk of proc.stderr)
        slot.stderr = (slot.stderr + Buffer.from(chunk).toString()).slice(-4096);
    })().catch(() => {});
    proc.exited.then((code) =>
      this.reset(
        slot,
        new Error(`SQLite host exited (${code})${slot.stderr ? `: ${slot.stderr}` : ''}`),
      ),
    );
    return slot;
  }
  finish(job) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
  }
  pump() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = this.slots.find((slot) => !slot.job);
      if (!slot) {
        if (this.slots.length >= this.concurrency) return;
        try {
          slot = this.spawn();
        } catch (error) {
          const job = this.queue.shift();
          this.finish(job);
          job.reject(error);
          continue;
        }
      }
      const job = (slot.job = this.queue.shift());
      slot.proc.ref();
      job.timer = setTimeout(
        () => this.reset(slot, new Error('SQLite query timed out')),
        this.timeout,
      );
      try {
        slot.proc.stdin.write(JSON.stringify({ id: job.id, request: job.request }) + '\n');
        slot.proc.stdin.flush();
      } catch (error) {
        this.reset(slot, error);
      }
    }
  }
  reset(slot, error) {
    const at = this.slots.indexOf(slot);
    if (at < 0) return;
    this.slots.splice(at, 1);
    const job = slot.job;
    slot.job = null;
    if (job) {
      this.finish(job);
      job.reject(error);
    }
    slot.proc.kill('SIGKILL');
    this.pump();
  }
  async close() {
    this.closed = true;
    const error = new Error('SQLite host stopped');
    for (const job of this.queue.splice(0)) {
      this.finish(job);
      job.reject(error);
    }
    const slots = [...this.slots];
    for (const slot of slots) this.reset(slot, error);
    await Promise.allSettled(slots.map((slot) => slot.proc.exited));
  }
}
let shared;
export function sqlite(request, options) {
  if (!shared || shared.closed) shared = new SQLitePool();
  return shared.run(request, options);
}
export async function closeSQLite() {
  await shared?.close();
}
