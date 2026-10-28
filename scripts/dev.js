// Development and build commands are user-run; agents must not launch this script.
// The app runs its service in process and serves dist/ from disk in debug builds,
// so a rebuilt web page needs only a reload.
import { spawn } from 'node:child_process';
const native = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
native.on('exit', (code) => {
  process.exitCode = code || 0;
});
process.on('SIGINT', () => native.kill());
