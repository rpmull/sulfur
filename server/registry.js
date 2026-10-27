import { createHash } from 'node:crypto';
import { convertVSIX, openVSIX, plan } from './vsix.js';
import { bundleBrowserExtension } from './browser-extension.js';
import { fail, limitedBody } from './util.js';
export const registryURL = () => {
  const raw = process.env.SULFUR_VSX_REGISTRY || 'https://open-vsx.org/api';
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw fail('Open VSX is reached over HTTPS only');
  return url.href.replace(/\/$/, '');
};
export async function httpsGet(raw, { signal, limit = 8 << 20, redirects = 0 } = {}) {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw fail('downloads must use HTTPS');
  const response = await fetch(u, {
    signal: signal || AbortSignal.timeout(120000),
    headers: { 'User-Agent': 'Sulfur-extensions', Accept: 'application/json, */*' },
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    if (redirects >= 9) throw fail('too many redirects');
    return httpsGet(new URL(response.headers.get('location'), u).href, {
      signal,
      limit,
      redirects: redirects + 1,
    });
  }
  if (!response.ok) throw fail(`${u.host} answered ${response.status}`, 502);
  return limitedBody(response.body, limit);
}
export async function fetchVSIX(download, signal) {
  if (!download.startsWith(registryURL() + '/'))
    throw fail(`a package is fetched from ${registryURL()} only`);
  const url = new URL(download);
  if (!url.pathname.endsWith('.vsix'))
    throw fail('the registry package has no .vsix checksum location');
  const data = await httpsGet(download, { signal, limit: 512 << 20 });
  url.pathname = url.pathname.slice(0, -5) + '.sha256';
  const sum = createHash('sha256').update(data).digest('hex');
  const expected = (await httpsGet(url, { signal, limit: 4096 })).toString().trim().split(/\s/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected) || expected.toLowerCase() !== sum)
    throw fail("the package doesn't match the registry's sha256");
  return { data, sum };
}
export const platform = () =>
  `${{ win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform] || process.platform}-${process.arch}`;
export const pickDownload = (meta) => {
  for (const key of [platform(), 'universal', 'web'])
    if (meta.downloads?.[key]) return { download: meta.downloads[key], targetPlatform: key };
  return { download: meta.files?.download, targetPlatform: meta.targetPlatform || '' };
};
const manifestCache = new Map();
let cachedBytes = 0;
async function manifestOf(extension, signal) {
  const key = `${registryURL()}/${extension.namespace}/${extension.name}/${extension.version}`;
  let hit = manifestCache.get(key);
  if (hit) {
    manifestCache.delete(key);
    manifestCache.set(key, hit);
    return hit.promise;
  }
  hit = { bytes: 0, promise: null };
  manifestCache.set(key, hit);
  hit.promise = (async () => {
    const meta = JSON.parse((await httpsGet(key, { signal })).toString());
    let manifest;
    if (meta.files?.manifest)
      manifest = JSON.parse(
        (await httpsGet(meta.files.manifest, { signal, limit: 4 << 20 })).toString(),
      );
    else {
      const { data } = await fetchVSIX(pickDownload(meta).download, signal);
      manifest = openVSIX(data).manifest;
    }
    if (manifestCache.get(key) === hit) {
      hit.bytes = Buffer.byteLength(JSON.stringify(manifest));
      cachedBytes += hit.bytes;
      while (manifestCache.size && (manifestCache.size > 128 || cachedBytes > 16 << 20)) {
        const [key, entry] = manifestCache.entries().next().value;
        manifestCache.delete(key);
        cachedBytes -= entry.bytes;
      }
    }
    return manifest;
  })().catch((e) => {
    if (manifestCache.get(key) === hit) {
      manifestCache.delete(key);
      cachedBytes -= hit.bytes;
    }
    throw e;
  });
  return hit.promise;
}
export async function searchExtensions(q, signal) {
  const size = Math.min(50, Math.max(1, Number(q.get('size')) || 20)),
    offset = Math.max(0, Number(q.get('offset')) || 0);
  const params = new URLSearchParams({
    query: q.get('q') || '',
    offset: String(offset),
    size: String(size),
    includeAllVersions: 'false',
  });
  const sorts = {
    relevance: 'relevance',
    downloads: 'downloadCount',
    rating: 'averageRating',
    updated: 'timestamp',
  };
  const sort = sorts[q.get('sort')] || (!q.get('q') ? 'downloadCount' : '');
  if (sort) {
    params.set('sortBy', sort);
    params.set('sortOrder', 'desc');
  }
  if (q.get('category')) params.set('category', q.get('category'));
  const page = JSON.parse(
    (await httpsGet(`${registryURL()}/-/search?${params}`, { signal })).toString(),
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, page.extensions.length) }, async () => {
      while (cursor < page.extensions.length) {
        const e = page.extensions[cursor++];
        e.icon = e.files?.icon || '';
        e.plan = [];
        try {
          const manifest = await manifestOf(
            e,
            AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(6000)]),
          );
          e.plan = plan(manifest);
          e.manifest = {
            name: manifest.name,
            publisher: manifest.publisher,
            version: manifest.version,
            displayName: manifest.displayName,
            contributes: manifest.contributes,
            extensionDependencies: manifest.extensionDependencies,
            extensionPack: manifest.extensionPack,
          };
        } catch (error) {
          e.planError = error.message;
        }
      }
    }),
  );
  return { offset: page.offset, totalSize: page.totalSize, extensions: page.extensions };
}
export async function convertExtension(request, signal) {
  for (const k of ['namespace', 'name', 'version'])
    if (request[k] && !/^[\w.-]{1,128}$/.test(request[k])) throw fail(`invalid ${k}`);
  const url =
    registryURL() +
    '/' +
    [request.namespace, request.name, request.version]
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');
  const meta = JSON.parse((await httpsGet(url, { signal })).toString());
  if (meta.error) throw fail(meta.error);
  const selected = pickDownload(meta);
  if (!selected.download)
    throw fail(`${request.namespace}.${request.name} has nothing to download`);
  if (
    selected.targetPlatform &&
    ![platform(), 'universal', 'web'].includes(selected.targetPlatform)
  )
    throw fail(`no package for ${platform()} (the registry offered ${selected.targetPlatform})`);
  const { data, sum } = await fetchVSIX(selected.download, signal);
  const result = convertVSIX(
    data,
    {
      registry: registryURL(),
      namespace: meta.namespace,
      name: meta.name,
      version: meta.version,
      ...selected,
      sha256: sum,
    },
    { commands: request.commands },
  );
  await bundleBrowserExtension(result);
  for (const server of result.manifest.contributes.languageServers || [])
    server.downloads = meta.downloads || { [selected.targetPlatform]: selected.download };
  result.files['package.json'] = JSON.stringify(result.manifest, null, 2) + '\n';
  return result;
}
