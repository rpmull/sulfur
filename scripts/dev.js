// Development and build commands are user-run; agents must not launch this script.
import { spawn } from 'node:child_process';
const service = spawn(process.execPath, ['--watch', 'server/main.js'], {
  stdio: 'inherit',
  env: process.env,
});
const native = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, SULFUR_SERVICE_EXTERNAL: '1' },
});
native.on('exit', (code) => {
  service.kill();
  process.exitCode = code || 0;
});
process.on('SIGINT', () => {
  service.kill();
  native.kill();
});
