import { mkdir, rm, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepare } from './prepare.js';
import { themeCSS } from './themes.js';
await prepare();
const out = path.resolve('dist');
await mkdir(out, { recursive: true });
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
await cp('node_modules/katex/dist/fonts', path.join(out, 'vendor/fonts'), { recursive: true });
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
  sourcemap: 'external',
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
async function compress(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await compress(file);
    else if (/\.(js|css|svg|html|json)$/.test(file)) {
      const raw = await readFile(file);
      await writeFile(file + '.gz', Bun.gzipSync(raw));
    }
  }
}
await compress(out);
console.log(`Built Sulfur web assets in ${out}`);
