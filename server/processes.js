import path from 'node:path';
import os from 'node:os';
import { stat, readdir } from 'node:fs/promises';
import { command, fail, exists } from './util.js';
const win = process.platform === 'win32';
export const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
export async function git({ dir, args, creds }) {
  const verbs = new Set(
    'status diff add restore rm mv commit push pull fetch branch switch checkout log show stash rev-parse remote init clone merge rebase reset ls-files tag blame for-each-ref symbolic-ref check-ignore'.split(
      ' ',
    ),
  );
  if (
    !Array.isArray(args) ||
    !verbs.has(args[0]) ||
    args.some((a) => typeof a !== 'string' || a.includes('\0'))
  )
    throw fail('not a git command Sulfur runs');
  for (const a of args.slice(1))
    if (
      /^-c|upload-pack|receive-pack|^--exec|^--config|^--template|^--output/i.test(a) ||
      (a === '-u' && ['clone', 'pull', 'fetch'].includes(args[0]))
    )
      throw fail(`an option Sulfur doesn't pass to git: ${a}`);
  if (dir && !path.isAbsolute(dir)) throw fail('a full path to the folder');
  const env = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  if (creds?.host && creds.user && !/['"\\ \r\n]/.test(creds.host))
    Object.assign(env, {
      PHOS_GIT_USER: creds.user,
      PHOS_GIT_PASS: creds.pass || '',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `credential.https://${creds.host}.helper`,
      GIT_CONFIG_VALUE_0:
        '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$PHOS_GIT_USER" "$PHOS_GIT_PASS"; }; f',
    });
  return command(['git', ...(dir ? ['-C', dir] : []), ...args], {
    env,
    timeout: ['clone', 'push', 'pull', 'fetch'].includes(args[0]) ? 900000 : 120000,
  });
}
export function spawnTerminal({ dir, cols = 120, rows = 30, cmd = '', shell, env }, output) {
  if (!Bun.Terminal) throw fail('This Bun runtime has no terminal support; use Bun 1.4.4 or later');
  const executable =
    shell || (win ? Bun.which('pwsh.exe') || 'powershell.exe' : process.env.SHELL || '/bin/sh');
  const args = cmd
    ? win
      ? ['cmd.exe', '/d', '/s', '/c', cmd]
      : ['/bin/sh', '-c', cmd]
    : [executable, ...(win ? ['-NoLogo'] : ['-l'])];
  let streamClosed;
  const drained = new Promise((resolve) => {
    streamClosed = resolve;
  });
  const proc = Bun.spawn(args, {
    cwd: dir || os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Sulfur',
      ...env,
    },
    windowsHide: true,
    terminal: {
      cols: cols >= 20 && cols <= 1000 ? cols : 120,
      rows: rows >= 5 && rows <= 500 ? rows : 30,
      data: (_, data) => output(Buffer.from(data)),
      exit: () => streamClosed(),
    },
  });
  let stopped = false;
  return {
    input: (b) => proc.terminal.write(b),
    resize: (c, r) => {
      if (c >= 20 && c <= 1000 && r >= 5 && r <= 500) proc.terminal.resize(c, r);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (win) command(['taskkill', '/pid', String(proc.pid), '/t', '/f']).catch(() => {});
      else {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          proc.kill();
        }
      }
    },
    exited: proc.exited.then(async (code) => {
      let timer;
      await Promise.race([
        drained,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 300);
        }),
      ]);
      clearTimeout(timer);
      proc.terminal.close();
      return code;
    }),
  };
}
export class Terminals {
  constructor() {
    this.sessions = new Map();
  }
  attach(ws, sid, since = 0) {
    const s = this.sessions.get(sid);
    if (!s) return false;
    clearTimeout(s.idle);
    if (s.ws && s.ws !== ws) s.ws.close(4001);
    s.ws = ws;
    ws.data.terminal = s;
    const from = Math.max(0, since <= s.total ? since - (s.total - s.buffer.length) : 0);
    if (s.buffer.length > from) ws.send(s.buffer.subarray(from));
    return true;
  }
  async message(ws, data, binary) {
    let s = ws.data.terminal;
    if (binary) {
      s?.proc.input(data);
      return;
    }
    const m = JSON.parse(data);
    if (m.type === 'close') {
      s?.proc.stop();
      return;
    }
    if (m.type === 'resize') {
      ws.data.cols = m.cols;
      ws.data.rows = m.rows;
      s?.proc.resize(m.cols, m.rows);
      if (s || ws.data.auto) return;
    }
    if (!s && ['resize', 'login'].includes(m.type)) {
      let dir = m.dir;
      if (
        !dir ||
        !(await stat(dir).then(
          (x) => x.isDirectory(),
          () => false,
        ))
      )
        dir = os.homedir();
      s = { sid: ws.data.sid, buffer: Buffer.alloc(0), total: 0, ws, idle: null };
      s.proc = spawnTerminal({ dir, cols: ws.data.cols, rows: ws.data.rows }, (b) => {
        s.total += b.length;
        s.buffer = Buffer.concat([s.buffer, b]);
        if (s.buffer.length > 256 * 1024)
          s.buffer = s.buffer.subarray(s.buffer.length - 256 * 1024);
        s.ws?.send(b);
      });
      this.sessions.set(s.sid, s);
      ws.data.terminal = s;
      s.proc.exited.then(() => {
        s.ws?.close(4000);
        this.sessions.delete(s.sid);
        clearTimeout(s.idle);
      });
      if (m.type === 'login') {
        const line = typeof m.then === 'string' && dir === m.dir ? m.then : m.run;
        if (line) setTimeout(() => s.proc.input(`${line}\r`), 250);
      }
    } else if (s && m.type === 'login' && m.run) s.proc.input(`${m.run}\r`);
  }
  close(ws) {
    const s = ws.data.terminal;
    if (!s || s.ws !== ws) return;
    s.ws = null;
    s.idle = setTimeout(() => s.proc.stop(), 600000);
    s.idle.unref();
  }
  dispose() {
    for (const s of this.sessions.values()) {
      clearTimeout(s.idle);
      s.proc.stop();
    }
  }
}
export async function taskStart(ws, task) {
  if (
    !task ||
    typeof task.command !== 'string' ||
    !task.command.trim() ||
    !path.isAbsolute(task.dir || '')
  )
    throw fail('a task needs a command and full directory');
  if (/[\0\r\n]/.test(task.command + task.dir + (task.vcvars || '')))
    throw fail('a command is one line');
  if (win && /"/.test(task.dir + (task.vcvars || '')))
    throw fail('a folder or script with a quote in its name');
  const cmd = win
    ? (task.vcvars ? `call "${task.vcvars}" >nul && ` : '') + task.command
    : `PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.dotnet:$HOME/.bun/bin:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH; ${task.command}`;
  const proc = spawnTerminal({ ...task, cmd }, (b) => ws.send(b));
  ws.data.task = proc;
  proc.exited.then((code) => {
    ws.send(JSON.stringify({ type: 'exit', code }));
    ws.close(4000);
  });
}
const known = [
  ['gcc', 'GCC', 'compiler', '--version'],
  ['g++', 'G++', 'compiler', '--version'],
  ['clang', 'Clang', 'compiler', '--version'],
  ['clang++', 'Clang++', 'compiler', '--version'],
  ['cl', 'MSVC cl', 'compiler', ''],
  ['zig', 'Zig', 'compiler', 'version'],
  ['rustc', 'Rust', 'compiler', '--version'],
  ['cargo', 'Cargo', 'build', '--version'],
  ['go', 'Go', 'compiler', 'version'],
  ['dotnet', '.NET', 'sdk', '--version'],
  ['javac', 'Java', 'compiler', '-version'],
  ['mvn', 'Maven', 'build', '-v'],
  ['gradle', 'Gradle', 'build', '--version'],
  ['cmake', 'CMake', 'build', '--version'],
  ['ninja', 'Ninja', 'build', '--version'],
  ['make', 'Make', 'build', '--version'],
  ['meson', 'Meson', 'build', '--version'],
  ['msbuild', 'MSBuild', 'build', '-version'],
  ['node', 'Node.js', 'runtime', '--version'],
  ['npm', 'npm', 'build', '--version'],
  ['bun', 'Bun', 'runtime', '--version'],
  ['python3', 'Python', 'runtime', '--version'],
  ['python', 'Python', 'runtime', '--version'],
  ['swift', 'Swift', 'compiler', '--version'],
  ['git', 'Git', 'vcs', '--version'],
];
let probing, cached;
export async function toolchains(host, fresh = false) {
  if (!fresh && cached && Date.now() - cached.at < 600000) return cached;
  if (probing) return probing;
  probing = (async () => {
    const tools = [];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < known.length) {
          const [id, name, kind, arg] = known[cursor++],
            exe = Bun.which(id);
          if (!exe) continue;
          const r = await command([exe, ...(arg ? [arg] : [])], { timeout: 3000 }).catch(
            () => null,
          );
          tools.push({
            id,
            name,
            kind,
            path: exe,
            version: (r?.out || r?.err || '').trim().split('\n')[0].slice(0, 300),
          });
        }
      }),
    );
    const vs = [],
      dotnet = [];
    if (Bun.which('dotnet')) {
      const r = await command(['dotnet', '--list-sdks'], { timeout: 3000 });
      dotnet.push(
        ...r.out
          .trim()
          .split('\n')
          .map((l) => l.split(' ')[0])
          .filter(Boolean),
      );
    }
    if (win) {
      const where = path.join(
        process.env['ProgramFiles(x86)'] || '',
        'Microsoft Visual Studio/Installer/vswhere.exe',
      );
      if (await exists(where)) {
        const r = await command([where, '-all', '-products', '*', '-format', 'json'], {
          timeout: 3000,
        });
        for (const x of JSON.parse(r.out || '[]')) {
          const root = x.installationPath;
          vs.push({
            name: x.displayName,
            version: x.installationVersion,
            path: root,
            vcvars: path.join(root, 'VC/Auxiliary/Build/vcvars64.bat'),
            msvc: await readdir(path.join(root, 'VC/Tools/MSVC')).catch(() => []),
            cmake: path.join(
              root,
              'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe',
            ),
          });
        }
      }
    }
    return (cached = {
      host,
      os: win ? 'windows' : process.platform,
      arch: process.arch === 'x64' ? 'amd64' : process.arch,
      shell: win ? 'powershell' : 'sh',
      tools: tools.sort((a, b) => a.id.localeCompare(b.id)),
      vs,
      dotnet,
      at: Date.now(),
    });
  })().finally(() => {
    probing = null;
  });
  return probing;
}
