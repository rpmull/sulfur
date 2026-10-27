import { prepare } from './prepare.js';
import { readdir } from 'node:fs/promises';
await prepare();
const files = (await readdir('web/tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => `web/tests/${f}`);
// Keep CPU-heavy incremental parser tests from starving each other's 1ms slices.
const child = Bun.spawn(
  [Bun.which('node') || process.execPath, '--test', '--test-concurrency=2', ...files],
  {
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
process.exitCode = await child.exited;
