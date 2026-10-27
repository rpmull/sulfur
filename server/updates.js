import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { httpsGet } from './registry.js';
import { fail } from './util.js';
function unwrap(value) {
  let s = value.trim();
  if (!s.startsWith('untrusted comment:')) {
    const decoded = Buffer.from(s, 'base64').toString();
    if (decoded.startsWith('untrusted comment:')) s = decoded;
  }
  const lines = s.replaceAll('\r\n', '\n').trim().split('\n');
  if (!lines[0].startsWith('untrusted comment:')) lines.unshift('untrusted comment:');
  return lines;
}
export function verifyMinisign(data, signature, key) {
  const pub = Buffer.from(unwrap(key)[1] || '', 'base64'),
    lines = unwrap(signature),
    sig = Buffer.from(lines[1] || '', 'base64');
  if (
    pub.length !== 42 ||
    pub.subarray(0, 2).toString() !== 'Ed' ||
    sig.length !== 74 ||
    !pub.subarray(2, 10).equals(sig.subarray(2, 10))
  )
    throw fail('minisign: malformed signature or another key');
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const alg = sig.subarray(0, 2).toString();
  if (!['ED', 'Ed'].includes(alg)) throw fail('minisign: unknown signature algorithm');
  const msg = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, msg, publicKey, sig.subarray(10))) throw fail('minisign: bad signature');
  if (
    !lines[2]?.startsWith('trusted comment: ') ||
    !verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice(17))]),
      publicKey,
      Buffer.from(lines[3] || '', 'base64'),
    )
  )
    throw fail('minisign: bad trusted comment');
  return true;
}
export function newer(a, b) {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
export class Updates {
  constructor(
    version,
    {
      url = process.env.SULFUR_UPDATE_FEED ||
        (typeof __SULFUR_UPDATE_FEED__ === 'undefined' ? '' : __SULFUR_UPDATE_FEED__),
      key = process.env.SULFUR_UPDATE_PUBKEY ||
        (typeof __SULFUR_UPDATE_PUBKEY__ === 'undefined' ? '' : __SULFUR_UPDATE_PUBKEY__),
    } = {},
  ) {
    this.version = version;
    this.url = url;
    this.key = key;
    this.busy = false;
  }
  async check() {
    if (!this.url || !this.key) return null;
    const target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    let release;
    try {
      release = JSON.parse(
        (await httpsGet(`${this.url.replace(/\/$/, '')}/sulfur-${target}.json`)).toString(),
      );
    } catch (e) {
      if (e.message.endsWith('404')) return null;
      throw e;
    }
    return release.url && newer(release.version, this.version) ? release : null;
  }
  async info() {
    const out = { version: this.version, on: !!(this.url && this.key) };
    try {
      const r = await this.check();
      if (r) out.latest = r.version;
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }
  async install() {
    if (this.busy) throw fail('already updating', 409);
    this.busy = true;
    try {
      const release = await this.check();
      if (!release) throw fail(`Sulfur ${this.version} is the latest`, 409);
      const data = await httpsGet(release.url, {
        limit: 1 << 30,
        signal: AbortSignal.timeout(900000),
      });
      verifyMinisign(data, release.signature, this.key);
      const dir = await mkdtemp(path.join(os.tmpdir(), 'sulfur-update-'));
      const file = path.join(dir, path.basename(new URL(release.url).pathname));
      await writeFile(file, data, { mode: 0o700 });
      // Installation is performed by the native shell, after the page closes safely.
      return { ok: true, version: release.version, file, prepared: true };
    } finally {
      this.busy = false;
    }
  }
}
