import { realpath, stat, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const MAX_TEXT = 16 << 20;
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const json = (value, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export const exists = async (p) =>
  stat(p).then(
    () => true,
    () => false,
  );
export const lf = (text) => text.replace(/\r\n?/g, '\n');
export const configHome = () =>
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
}
export async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
export const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
export async function safePath(root, rel, write = false) {
  if (
    typeof rel !== 'string' ||
    /[\0]/.test(rel) ||
    path.isAbsolute(rel) ||
    /^[a-z]:/i.test(rel) ||
    rel.replaceAll('\\', '/').split('/').includes('..')
  )
    throw fail('invalid path');
  const base = await realpath(root);
  const target = path.resolve(base, rel || '.');
  if (!inside(base, target)) throw fail('invalid path');
  let probe = target;
  while (true) {
    try {
      const resolved = await realpath(probe);
      if (!inside(base, resolved)) throw fail('path leaves its share');
      break;
    } catch (error) {
      if (!write || !['ENOENT', 'ENOTDIR'].includes(error.code) || probe === base) throw error;
      probe = path.dirname(probe);
    }
  }
  return target;
}
export async function bodyJSON(req, max = 64 << 20) {
  const data = await limitedBody(req.body, max);
  try {
    return JSON.parse(data.toString());
  } catch {
    throw fail('invalid json');
  }
}
export async function limitedBody(body, max) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const value of body) {
    size += value.length;
    if (size > max) throw fail('request too large', 413);
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}
export async function command(args, { cwd, timeout = 90000, env, signal } = {}) {
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const timer = setTimeout(() => proc.kill(), timeout);
  const abort = () => proc.kill();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
