import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAMES } from '../src/host/contract.js';

// Sulfur meets whatever hosts its page only at '#host' (src/host/contract.js). These hold
// Sulfur's own host to the contract and Sulfur's code to reaching its host by nothing else.
// The Phosphorus desktop's host is held to the same contract by Phosphorus's own test.
const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const read = (p) => readFileSync(join(src, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const names = (list) => list.split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean);
const exportsOf = (p) => {
  const s = read(p);
  const out = new Set([...s.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/gm)].map((m) => m[1]));
  for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of names(m[1])) out.add(n);
  return out;
};
// static imports of a module: [specifier, imported names or null]
const importsOf = (p) => {
  const s = read(p);
  return [...s.matchAll(/^\s*(?:import|export)\s+(?:([\s\S]*?)\s+from\s+)?'([^']+)'/gm)].map((m) => [m[2], m[1]?.match(/\{([^}]*)\}/) ? names(m[1].match(/\{([^}]*)\}/)[1]) : null]);
};
const resolveFrom = (from, spec) => (spec.startsWith('.') ? relative(src, resolve(dirname(join(src, from)), spec)).replaceAll('\\', '/') : null);
// every module reachable from an entry by static imports, '#host' left unfollowed
function graph(entry) {
  const seen = new Map();
  const walk = (p) => {
    if (seen.has(p) || !p.endsWith('.js')) return;
    const deps = importsOf(p);
    seen.set(p, deps);
    for (const [spec] of deps) {
      const to = resolveFrom(p, spec);
      if (to && existsSync(join(src, to))) walk(to);
    }
  };
  walk(entry);
  return seen;
}

test('Sulfur\'s own host exports every name the contract has', () => {
  const alone = exportsOf('sulfur/host.js');
  for (const n of HOST_NAMES) assert.ok(alone.has(n), `sulfur/host.js exports ${n}`);
});

test('Sulfur reaches its host only through #host, and only the contract\'s names', () => {
  const contract = new Set(HOST_NAMES);
  // the workbench is what a host's page loads; its graph is everything the desktop takes in
  for (const [p, deps] of graph('sulfur/workbench.js')) {
    for (const [spec, imported] of deps) {
      const to = resolveFrom(p, spec);
      // the page's one theme and one set of terminals are the host's: through '#host' alone
      assert.notEqual(to, 'theme.js', `${p} imports theme.js; take the theme from '#host'`);
      assert.ok(!to?.startsWith('apps/'), `${p} imports ${to}; take the terminals from '#host'`);
      assert.ok(!to?.startsWith('host/') || to === 'host/contract.js', `${p} imports ${to}; use '#host'`);
      if (spec === '#host') for (const n of imported || []) assert.ok(contract.has(n), `${p} imports ${n} from '#host', which the contract (src/host/contract.js) lacks`);
    }
  }
});

test('the shared terminals reach their host only through the contract', () => {
  const contract = new Set(HOST_NAMES);
  for (const [spec, imported] of importsOf('apps/terminal.js')) {
    if (spec === '#host') for (const n of imported || []) assert.ok(contract.has(n), `apps/terminal.js imports ${n} from '#host', which the contract lacks`);
    else assert.ok(!spec.startsWith('.'), `apps/terminal.js imports ${spec}; it's shared with the desktop, so '#host' only`);
  }
});
