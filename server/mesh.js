import { createConnection } from 'node:net';
import { fail } from './util.js';

export function serverURL(input) {
  let value = String(input || '').trim();
  if (!value) throw fail("that isn't a host name or address");
  if (!value.includes('://')) {
    const host = value.replace(/:\d+$/, '');
    value =
      (host.includes('.') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
      !host.toLowerCase().endsWith('.ts.net')
        ? 'https://'
        : 'http://') + value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("that isn't a host name or address");
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname)
    throw fail("that isn't a host name or address");
  return url.origin;
}

export async function reach(raw) {
  const url = new URL(raw);
  return new Promise((resolve, reject) => {
    const connection = createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
    });
    connection.setTimeout(5000);
    connection.once('connect', () => {
      connection.destroy();
      resolve();
    });
    connection.once('error', reject);
    connection.once('timeout', () => {
      connection.destroy();
      reject(fail(`${url.host} didn't answer`, 502));
    });
  });
}

// Providers advertise implemented services, not merely network reachability.
// All providers expose the versioned HTTP/socket protocol to the unchanged UI.
const providers = new Map();
export function registerMeshProvider(provider) {
  if (
    !/^[a-z][a-z0-9-]*$/.test(provider.kind) ||
    provider.version !== 1 ||
    !Array.isArray(provider.caps) ||
    typeof provider.normalize !== 'function' ||
    typeof provider.reach !== 'function'
  )
    throw new Error('Invalid mesh provider');
  if (providers.has(provider.kind))
    throw new Error(`Mesh provider already registered: ${provider.kind}`);
  providers.set(
    provider.kind,
    Object.freeze({ ...provider, caps: Object.freeze([...provider.caps]) }),
  );
}
export function meshProvider(kind = 'phosphorus') {
  const provider = providers.get(kind);
  if (!provider) throw fail('unknown mesh kind');
  return provider;
}
export function meshInfo(config) {
  const { kind, version, caps } = meshProvider(config.kind || 'phosphorus');
  return { kind, version, caps };
}
registerMeshProvider({
  kind: 'phosphorus',
  version: 1,
  caps: [
    'hosts',
    'files',
    'home',
    'sessions',
    'terminals',
    'toolchains',
    'runs',
    'languages',
    'git',
    'sqlite',
    'vsx',
    'people',
    'agents',
    'models',
    'forgejo',
  ],
  normalize: serverURL,
  reach,
});
