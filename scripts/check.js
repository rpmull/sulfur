import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepare } from './prepare.js';
// Web sources import through the generated web/.vendor link, absent on a fresh checkout.
await prepare();
async function walk(dir) {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (
      [
        'node_modules',
        '.git',
        '.tools',
        'target',
        'dist',
        '.vendor',
        'binaries',
        'resources',
      ].includes(e.name)
    )
      continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else files.push(p);
  }
  return files;
}
const files = await walk('.');
const go = files.filter((f) => f.endsWith('.go') || ['go.mod', 'go.sum'].includes(f));
if (go.length) throw new Error(`Go files remain: ${go.join(', ')}`);
const scanner = new Bun.Transpiler({ loader: 'js' });
const javascript = files.filter((f) => /\.[cm]?js$/.test(f));
const syntax = Bun.spawn(
  [
    Bun.which('node') || 'node',
    '--experimental-vm-modules',
    'scripts/syntax-check.cjs',
    ...javascript,
  ],
  { stdout: 'pipe', stderr: 'pipe' },
);
const syntaxErrors = await new Response(syntax.stderr).text();
if (await syntax.exited) throw new Error(syntaxErrors);
for (const file of javascript) {
  // Parsing imports is source analysis, not an application build.
  for (const entry of scanner.scanImports(await readFile(file, 'utf8'))) {
    if (!entry.path.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), entry.path);
    if (!(await Bun.file(target).exists())) throw new Error(`${file}: missing ${entry.path}`);
  }
}
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  vendor = JSON.parse(await readFile('web/vendor.lock', 'utf8'));
for (const [name, entry] of Object.entries(vendor))
  if (pkg.dependencies[name] !== entry.version)
    throw new Error(
      `Frontend dependency pin differs from Phosphorus's compatible vendor lock: ${name}`,
    );
console.log('JavaScript syntax, imports, frontend pins and Go removal checks passed');
