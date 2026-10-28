import { mkdir, rm, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepare } from './prepare.js';
import { themeCSS } from './themes.js';
await prepare();
const out = path.resolve('dist');
// whole each time: the service compresses everything here into the app
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// source maps only when asked for: they'd double what the app carries
const sourcemap = process.env.SULFUR_SOURCEMAP ? 'external' : 'none';
const assets = {};
for (const [key, file] of Object.entries({
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'katex.css': 'katex/dist/katex.min.css',
})) {
  const data = await readFile(path.join('node_modules', file));
  const name = key.replace(
    /\./,
    `-${createHash('sha256').update(data).digest('hex').slice(0, 12)}.`,
  );
  await mkdir(path.join(out, 'vendor'), { recursive: true });
  await writeFile(path.join(out, 'vendor', name), data);
  assets[key] = `/vendor/${name}`;
}
// every webview Sulfur runs in reads WOFF2, the first source KaTeX's stylesheet names
await cp('node_modules/katex/dist/fonts', path.join(out, 'vendor/fonts'), {
  recursive: true,
  filter: (file) => !/\.(woff|ttf)$/.test(file),
});
const host = path.resolve('web/src/sulfur/host.js');
const generatedThemes = path.resolve('web/.vendor/themes.css');
await writeFile(generatedThemes, themeCSS());
const result = await Bun.build({
  entrypoints: ['web/src/sulfur/main.js', 'web/style.css'],
  outdir: path.join(out, 'sulfur/assets'),
  target: 'browser',
  format: 'esm',
  splitting: true,
  minify: true,
  sourcemap,
  naming: {
    entry: '[name]-[hash].[ext]',
    chunk: '[name]-[hash].[ext]',
    asset: '[name]-[hash].[ext]',
  },
  define: { __ASSETS__: JSON.stringify(assets) },
  external: ['/vendor/*'],
  loader: { '.md': 'text' },
  plugins: [
    {
      name: 'sulfur-host-and-theme',
      setup(build) {
        build.onResolve({ filter: /^#host$/ }, () => ({ path: host }));
        build.onResolve({ filter: /^(sulfur|phosphorus):themes$/ }, () => ({
          path: generatedThemes,
        }));
      },
    },
  ],
});
if (!result.success) throw new AggregateError(result.logs, 'web build failed');
const js = result.outputs.find((x) => x.kind === 'entry-point' && x.path.endsWith('.js'));
const css = result.outputs.find((x) => x.path.endsWith('.css'));
if (!js || !css) throw new Error('Missing web entry output');
let html = await readFile('web/sulfur.html', 'utf8');
html = html
  .replace('/src/sulfur/main.js', '/' + path.relative(out, js.path).replaceAll('\\', '/'))
  .replace('/style.css', '/' + path.relative(out, css.path).replaceAll('\\', '/'));
await mkdir(path.join(out, 'sulfur'), { recursive: true });
await writeFile(path.join(out, 'sulfur/index.html'), html);
await cp('web/static', out, { recursive: true });
// a converted Node extension's process: run by the Node.js (or Bun) on PATH
const extensionHost = await Bun.build({
  entrypoints: ['server/extension-host.js'],
  target: 'node',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
  naming: 'sulfur-extension-host.mjs',
  outdir: out,
});
if (!extensionHost.success) throw new AggregateError(extensionHost.logs, 'extension host build failed');
console.log(`Built Sulfur web assets in ${out}`);
