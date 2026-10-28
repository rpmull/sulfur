//! Shells and tasks in real terminals, Git as the page asks it, and the
//! compilers this computer has.
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use bytes::Bytes;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::{
    files::platform,
    util::{command, fail, home_dir, is_absolute_str, which, Output, Res},
    ws::Ws,
};

const REPLAY_MAX: usize = 256 * 1024;

/// a process in a pseudo-terminal: what it prints streamed, its input written
pub struct Pty {
    writer: StdMutex<Option<Box<dyn Write + Send>>>,
    master: StdMutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    killer: StdMutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    stopped: std::sync::atomic::AtomicBool,
}

pub struct Spawn<'a> {
    pub dir: Option<&'a Path>,
    pub cols: u16,
    pub rows: u16,
    pub cmd: Option<String>,
    pub env: Vec<(String, String)>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: if (20..=1000).contains(&cols) { cols } else { 120 },
        rows: if (5..=500).contains(&rows) { rows } else { 30 },
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl Pty {
    /// the user's shell (PowerShell on Windows, a login $SHELL elsewhere), or one command
    pub fn spawn(opts: Spawn, output: mpsc::UnboundedSender<Bytes>) -> Res<(Arc<Pty>, oneshot::Receiver<i32>)> {
        let pair = native_pty_system()
            .openpty(size(opts.cols, opts.rows))
            .map_err(|e| crate::util::Fail::new(format!("no terminal: {e}"), 500))?;
        let mut cmd = match &opts.cmd {
            Some(line) if cfg!(windows) => {
                // the builder writes a quote as \", which cmd doesn't read: cmd expands
                // variables before it parses quotes, so each one reaches it as one
                let mut c = CommandBuilder::new("cmd.exe");
                c.args(["/d", "/s", "/c", &line.replace('"', "%SULFUR_QUOTE%")]);
                c.env("SULFUR_QUOTE", "\"");
                c
            }
            Some(line) => {
                let mut c = CommandBuilder::new("/bin/sh");
                c.args(["-c", line]);
                c
            }
            None if cfg!(windows) => {
                let shell = which("pwsh.exe").map(|p| p.into_os_string()).unwrap_or_else(|| "powershell.exe".into());
                let mut c = CommandBuilder::new(shell);
                c.arg("-NoLogo");
                c
            }
            None => {
                let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
                let mut c = CommandBuilder::new(shell);
                c.arg("-l");
                c
            }
        };
        let dir = opts.dir.map(Path::to_path_buf).unwrap_or_else(home_dir);
        cmd.cwd(dir);
        if let Some(path) = crate::util::path_var() {
            cmd.env("PATH", path);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Sulfur");
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| crate::util::Fail::new(format!("couldn't start: {e}"), 500))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| crate::util::Fail::new(e.to_string(), 500))?;
        let writer = pair.master.take_writer().map_err(|e| crate::util::Fail::new(e.to_string(), 500))?;
        let pty = Arc::new(Pty {
            writer: StdMutex::new(Some(writer)),
            master: StdMutex::new(Some(pair.master)),
            killer: StdMutex::new(child.clone_killer()),
            pid: child.process_id(),
            stopped: false.into(),
        });
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
        let answerer = pty.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            // ConPTY inherits the cursor: conhost asks where it is (ESC[6n) as it starts and
            // holds the child's output until that's answered, which a page may never do
            let mut asked = !cfg!(windows);
            let mut seen = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut chunk = &buf[..n];
                        let mut rest = Vec::new();
                        if !asked {
                            if let Some(at) = chunk.windows(4).position(|w| w == b"\x1b[6n") {
                                asked = true;
                                answerer.input(b"\x1b[1;1R");
                                rest = [&chunk[..at], &chunk[at + 4..]].concat();
                                chunk = &rest;
                            }
                            seen += n;
                            asked |= seen > 4096;
                        }
                        if chunk.is_empty() {
                            continue;
                        }
                        if output.send(Bytes::copy_from_slice(chunk)).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = drained_tx.send(());
        });
        let (exit_tx, exit_rx) = oneshot::channel();
        let owner = pty.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
            // the last output read before the terminal's closed; ConPTY ends its
            // reader only once the terminal itself is gone
            let _ = drained_rx.recv_timeout(Duration::from_millis(300));
            owner.writer.lock().unwrap().take();
            owner.master.lock().unwrap().take();
            let _ = exit_tx.send(code);
        });
        Ok((pty, exit_rx))
    }

    pub fn input(&self, data: &[u8]) {
        if let Some(w) = self.writer.lock().unwrap().as_mut() {
            let _ = w.write_all(data);
            let _ = w.flush();
        }
    }

    pub fn resize(&self, cols: f64, rows: f64) {
        if (20.0..=1000.0).contains(&cols) && (5.0..=500.0).contains(&rows) {
            if let Some(m) = self.master.lock().unwrap().as_ref() {
                let _ = m.resize(size(cols as u16, rows as u16));
            }
        }
    }

    /// the process and everything it started
    pub fn stop(&self) {
        if self.stopped.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // SAFETY: signals the process group the terminal's session leader heads
            if unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } == 0 {
                return;
            }
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let _ = crate::util::hidden_std("taskkill").args(["/pid", &pid.to_string(), "/t", "/f"]).spawn();
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

struct TermSession {
    buffer: Vec<u8>,
    total: u64,
    ws: Option<Ws>,
    idle: u64,
    pty: Arc<Pty>,
}

/// the page's shells by id, their recent output kept for a reloaded page
#[derive(Default)]
pub struct Terminals {
    sessions: StdMutex<HashMap<String, Arc<StdMutex<TermSession>>>>,
}

/// one page's socket onto a terminal: its size and the session once one's started
pub struct TermSocket {
    pub sid: String,
    pub auto: bool,
    cols: f64,
    rows: f64,
    session: Option<Arc<StdMutex<TermSession>>>,
}

impl TermSocket {
    pub fn new(sid: String, auto: bool) -> TermSocket {
        TermSocket { sid, auto, cols: 0.0, rows: 0.0, session: None }
    }
}

impl Terminals {
    pub fn attach(&self, ws: &Ws, t: &mut TermSocket, since: u64) -> bool {
        let Some(s) = self.sessions.lock().unwrap().get(&t.sid).cloned() else { return false };
        {
            let mut g = s.lock().unwrap();
            g.idle += 1;
            if let Some(old) = g.ws.as_ref().filter(|o| *o != ws) {
                old.close(4001);
            }
            g.ws = Some(ws.clone());
            let kept = g.buffer.len() as u64;
            let from = if since <= g.total { since.saturating_sub(g.total - kept) } else { 0 } as usize;
            if g.buffer.len() > from {
                ws.binary(Bytes::copy_from_slice(&g.buffer[from..]));
            }
        }
        t.session = Some(s);
        true
    }

    pub async fn message(self: &Arc<Self>, ws: &Ws, t: &mut TermSocket, frame: crate::ws::Frame) -> Res<()> {
        let text = match frame {
            crate::ws::Frame::Binary(b) => {
                if let Some(s) = &t.session {
                    let pty = s.lock().unwrap().pty.clone();
                    pty.input(&b);
                }
                return Ok(());
            }
            crate::ws::Frame::Text(s) => s,
        };
        let m: Value = serde_json::from_str(&text)?;
        let kind = m["type"].as_str().unwrap_or("");
        let pty = t.session.as_ref().map(|s| s.lock().unwrap().pty.clone());
        if kind == "close" {
            if let Some(p) = pty {
                p.stop();
            }
            return Ok(());
        }
        if kind == "resize" {
            t.cols = m["cols"].as_f64().unwrap_or(0.0);
            t.rows = m["rows"].as_f64().unwrap_or(0.0);
            if let Some(p) = &pty {
                p.resize(t.cols, t.rows);
            }
            if pty.is_some() || t.auto {
                return Ok(());
            }
        }
        if pty.is_none() && (kind == "resize" || kind == "login") {
            let wanted = m["dir"].as_str().unwrap_or("").to_owned();
            let dir = if !wanted.is_empty() && tokio::fs::metadata(&wanted).await.is_ok_and(|m| m.is_dir()) {
                PathBuf::from(&wanted)
            } else {
                home_dir()
            };
            let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
            let (pty, exited) = Pty::spawn(
                Spawn { dir: Some(&dir), cols: t.cols as u16, rows: t.rows as u16, cmd: None, env: vec![] },
                tx,
            )?;
            let s = Arc::new(StdMutex::new(TermSession { buffer: Vec::new(), total: 0, ws: Some(ws.clone()), idle: 0, pty: pty.clone() }));
            self.sessions.lock().unwrap().insert(t.sid.clone(), s.clone());
            t.session = Some(s.clone());
            let out = s.clone();
            tokio::spawn(async move {
                while let Some(b) = rx.recv().await {
                    let mut g = out.lock().unwrap();
                    g.total += b.len() as u64;
                    g.buffer.extend_from_slice(&b);
                    if g.buffer.len() > REPLAY_MAX {
                        let cut = g.buffer.len() - REPLAY_MAX;
                        g.buffer.drain(..cut);
                    }
                    if let Some(ws) = &g.ws {
                        ws.binary(b);
                    }
                }
            });
            let terms = self.clone();
            let sid = t.sid.clone();
            tokio::spawn(async move {
                let _ = exited.await;
                // what's still queued reaches the page before the socket ends
                tokio::time::sleep(Duration::from_millis(20)).await;
                let ws = s.lock().unwrap().ws.take();
                if let Some(ws) = ws {
                    ws.close(4000);
                }
                let mut sessions = terms.sessions.lock().unwrap();
                if sessions.get(&sid).is_some_and(|x| Arc::ptr_eq(x, &s)) {
                    sessions.remove(&sid);
                }
            });
            if kind == "login" {
                let then = m["then"].as_str().filter(|_| dir.to_string_lossy() == wanted);
                if let Some(line) = then.or_else(|| m["run"].as_str()).filter(|l| !l.is_empty()) {
                    let line = format!("{line}\r");
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        pty.input(line.as_bytes());
                    });
                }
            }
        } else if let (Some(p), "login", Some(run)) = (pty, kind, m["run"].as_str()) {
            p.input(format!("{run}\r").as_bytes());
        }
        Ok(())
    }

    /// a page gone: its shell kept ten minutes for its return
    pub fn close(&self, ws: &Ws, t: &TermSocket) {
        let Some(s) = &t.session else { return };
        let mut g = s.lock().unwrap();
        if g.ws.as_ref() != Some(ws) {
            return;
        }
        g.ws = None;
        g.idle += 1;
        let generation = g.idle;
        let s = s.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(600)).await;
            let g = s.lock().unwrap();
            if g.idle == generation && g.ws.is_none() {
                g.pty.stop();
            }
        });
    }

    pub fn dispose(&self) {
        for s in self.sessions.lock().unwrap().values() {
            s.lock().unwrap().pty.stop();
        }
    }
}

#[derive(Deserialize)]
pub struct Task {
    #[serde(default)]
    command: String,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    vcvars: String,
    #[serde(default)]
    cols: f64,
    #[serde(default)]
    rows: f64,
    #[serde(default)]
    env: HashMap<String, String>,
}

/// a build or run in a terminal of its own; the socket ends with its exit code
pub fn task_start(ws: &Ws, task: Option<Task>) -> Res<Arc<Pty>> {
    let Some(task) = task.filter(|t| !t.command.trim().is_empty() && is_absolute_str(&t.dir)) else {
        return fail("a task needs a command and full directory");
    };
    if format!("{}{}{}", task.command, task.dir, task.vcvars).contains(['\0', '\r', '\n']) {
        return fail("a command is one line");
    }
    if cfg!(windows) && format!("{}{}", task.dir, task.vcvars).contains('"') {
        return fail("a folder or script with a quote in its name");
    }
    let cmd = if cfg!(windows) {
        let pre = if task.vcvars.is_empty() { String::new() } else { format!("call \"{}\" >nul && ", task.vcvars) };
        format!("{pre}{}", task.command)
    } else {
        format!(
            "PATH=\"$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.dotnet:$HOME/.bun/bin:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; export PATH; {}",
            task.command
        )
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
    let dir = PathBuf::from(&task.dir);
    let (pty, exited) = Pty::spawn(
        Spawn {
            dir: Some(&dir),
            cols: task.cols as u16,
            rows: task.rows as u16,
            cmd: Some(cmd),
            env: task.env.into_iter().collect(),
        },
        tx,
    )?;
    let out = ws.clone();
    let pump = tokio::spawn(async move {
        while let Some(b) = rx.recv().await {
            out.binary(b);
        }
    });
    let ws = ws.clone();
    tokio::spawn(async move {
        let code = exited.await.unwrap_or(1);
        let _ = tokio::time::timeout(Duration::from_millis(500), pump).await;
        ws.json(&json!({ "type": "exit", "code": code }));
        ws.close(4000);
    });
    Ok(pty)
}

#[derive(Deserialize, Default)]
pub struct GitCreds {
    #[serde(default)]
    host: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    pass: String,
}

#[derive(Deserialize)]
pub struct GitRequest {
    #[serde(default)]
    dir: String,
    #[serde(default)]
    args: Vec<Value>,
    #[serde(default)]
    creds: Option<GitCreds>,
}

const GIT_VERBS: &str = "status diff add restore rm mv commit push pull fetch branch switch checkout log show stash rev-parse remote init clone merge rebase reset ls-files tag blame for-each-ref symbolic-ref check-ignore lfs";
// what of git-lfs Sulfur runs: whether it is there, what it tracks, and bringing those files down
const LFS_VERBS: &str = "version ls-files status pull fetch install env";

/// a git command of the verbs Sulfur runs, without options that run other programs
pub async fn git(p: GitRequest) -> Res<Output> {
    let mut args = Vec::with_capacity(p.args.len());
    for a in &p.args {
        match a.as_str() {
            Some(s) if !s.contains('\0') => args.push(s.to_owned()),
            _ => return fail("not a git command Sulfur runs"),
        }
    }
    let Some(verb) = args.first().cloned().filter(|v| GIT_VERBS.split(' ').any(|x| x == v)) else {
        return fail("not a git command Sulfur runs");
    };
    if verb == "lfs" && !args.get(1).is_some_and(|v| LFS_VERBS.split(" ").any(|x| x == v.as_str())) {
        return fail("not a git lfs command Sulfur runs");
    }
    let refused = regex::Regex::new(r"(?i)^-c|upload-pack|receive-pack|^--exec|^--config|^--template|^--output").unwrap();
    for a in &args[1..] {
        if refused.is_match(a) || (a == "-u" && ["clone", "pull", "fetch"].contains(&verb.as_str())) {
            return fail(format!("an option Sulfur doesn't pass to git: {a}"));
        }
    }
    if !p.dir.is_empty() && !is_absolute_str(&p.dir) {
        return fail("a full path to the folder");
    }
    let mut env = vec![("GIT_TERMINAL_PROMPT".into(), "0".into()), ("LC_ALL".into(), "C".into())];
    if let Some(c) = p.creds.filter(|c| !c.host.is_empty() && !c.user.is_empty() && !c.host.contains(['\'', '"', '\\', ' ', '\r', '\n'])) {
        env.extend([
            ("PHOS_GIT_USER".into(), c.user),
            ("PHOS_GIT_PASS".into(), c.pass),
            ("GIT_CONFIG_COUNT".into(), "1".into()),
            ("GIT_CONFIG_KEY_0".into(), format!("credential.https://{}.helper", c.host)),
            (
                "GIT_CONFIG_VALUE_0".into(),
                "!f() { test \"$1\" = get && printf \"username=%s\\npassword=%s\\n\" \"$PHOS_GIT_USER\" \"$PHOS_GIT_PASS\"; }; f".into(),
            ),
        ]);
    }
    let mut argv = vec!["git".to_owned()];
    if !p.dir.is_empty() {
        argv.extend(["-C".into(), p.dir.clone()]);
    }
    let slow = ["clone", "push", "pull", "fetch"].contains(&verb.as_str())
        || (verb == "lfs" && ["pull", "fetch"].contains(&args.get(1).map(String::as_str).unwrap_or_default()));
    argv.extend(args);
    command(&argv, None, &env, Duration::from_secs(if slow { 900 } else { 120 })).await
}

const KNOWN: &[(&str, &str, &str, &str)] = &[
    ("gcc", "GCC", "compiler", "--version"),
    ("g++", "G++", "compiler", "--version"),
    ("clang", "Clang", "compiler", "--version"),
    ("clang++", "Clang++", "compiler", "--version"),
    ("cl", "MSVC cl", "compiler", ""),
    ("zig", "Zig", "compiler", "version"),
    ("rustc", "Rust", "compiler", "--version"),
    ("cargo", "Cargo", "build", "--version"),
    ("go", "Go", "compiler", "version"),
    ("dotnet", ".NET", "sdk", "--version"),
    ("javac", "Java", "compiler", "-version"),
    ("mvn", "Maven", "build", "-v"),
    ("gradle", "Gradle", "build", "--version"),
    ("cmake", "CMake", "build", "--version"),
    ("ninja", "Ninja", "build", "--version"),
    ("make", "Make", "build", "--version"),
    ("meson", "Meson", "build", "--version"),
    ("msbuild", "MSBuild", "build", "-version"),
    ("node", "Node.js", "runtime", "--version"),
    ("npm", "npm", "build", "--version"),
    ("bun", "Bun", "runtime", "--version"),
    ("python3", "Python", "runtime", "--version"),
    ("python", "Python", "runtime", "--version"),
    ("swift", "Swift", "compiler", "--version"),
    ("git", "Git", "vcs", "--version"),
];

#[derive(Default)]
pub struct Toolchains {
    cached: Mutex<Option<(std::time::Instant, Value)>>,
}

impl Toolchains {
    /// this computer's compilers, build tools and runtimes; probed again after ten minutes
    pub async fn probe(&self, host: &str, fresh: bool) -> Value {
        let mut cached = self.cached.lock().await;
        if let Some((at, v)) = cached.as_ref() {
            if !fresh && at.elapsed() < Duration::from_secs(600) {
                return v.clone();
            }
        }
        let mut tools = Vec::new();
        let probes = KNOWN.iter().filter_map(|(id, name, kind, arg)| {
            let exe = which(id)?;
            Some(async move {
                let mut argv = vec![exe.to_string_lossy().into_owned()];
                if !arg.is_empty() {
                    argv.push(arg.to_string());
                }
                let r = command(&argv, None, &[], Duration::from_secs(3)).await.ok();
                let text = r.map(|r| if r.out.trim().is_empty() { r.err } else { r.out }).unwrap_or_default();
                let line: String = text.trim().lines().next().unwrap_or("").chars().take(300).collect();
                json!({ "id": id, "name": name, "kind": kind, "path": exe, "version": line })
            })
        });
        let found = futures_util::future::join_all(probes).await;
        tools.extend(found);
        tools.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let mut dotnet = Vec::new();
        if which("dotnet").is_some() {
            if let Ok(r) = command(&["dotnet".into(), "--list-sdks".into()], None, &[], Duration::from_secs(3)).await {
                dotnet.extend(r.out.lines().filter_map(|l| l.split(' ').next()).filter(|v| !v.trim().is_empty()).map(|v| v.trim().to_owned()));
            }
        }
        let vs = visual_studios().await;
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            a => a,
        };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let v = json!({
            "host": host,
            "os": platform(),
            "arch": arch,
            "shell": if cfg!(windows) { "powershell" } else { "sh" },
            "tools": tools,
            "vs": vs,
            "dotnet": dotnet,
            "at": now,
        });
        *cached = Some((std::time::Instant::now(), v.clone()));
        v
    }
}

async fn visual_studios() -> Vec<Value> {
    let mut vs = Vec::new();
    if !cfg!(windows) {
        return vs;
    }
    let Some(pf) = std::env::var_os("ProgramFiles(x86)") else { return vs };
    let where_ = PathBuf::from(pf).join("Microsoft Visual Studio/Installer/vswhere.exe");
    if !where_.exists() {
        return vs;
    }
    let argv = [where_.to_string_lossy().into_owned(), "-all".into(), "-products".into(), "*".into(), "-format".into(), "json".into()];
    let Ok(r) = command(&argv, None, &[], Duration::from_secs(3)).await else { return vs };
    let list: Vec<Value> = serde_json::from_str(&r.out).unwrap_or_default();
    for x in list {
        let root = PathBuf::from(x["installationPath"].as_str().unwrap_or(""));
        let msvc: Vec<String> = std::fs::read_dir(root.join("VC/Tools/MSVC"))
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        vs.push(json!({
            "name": x["displayName"],
            "version": x["installationVersion"],
            "path": root,
            "vcvars": root.join("VC/Auxiliary/Build/vcvars64.bat"),
            "msvc": msvc,
            "cmake": root.join("Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"),
        }));
    }
    vs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_pty_streams_real_output() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        // a quoted program, as a task's vcvars prefix is
        let cmd = if cfg!(windows) { r#""%SystemRoot%\System32\cmd.exe" /d /c echo sulfur-pty"# } else { "printf sulfur-pty" };
        let (_pty, exited) = Pty::spawn(Spawn { dir: None, cols: 80, rows: 24, cmd: Some(cmd.into()), env: vec![] }, tx).unwrap();
        let code = tokio::time::timeout(Duration::from_secs(30), exited).await.expect("the terminal never exited");
        assert_eq!(code.unwrap(), 0);
        let mut out = Vec::new();
        while let Ok(b) = rx.try_recv() {
            out.extend_from_slice(&b);
        }
        assert!(String::from_utf8_lossy(&out).contains("sulfur-pty"));
    }

    #[tokio::test]
    async fn git_keeps_exit_and_output_and_refuses_execution_options() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let run = |args: &[&str]| GitRequest { dir: root.clone(), args: args.iter().map(|a| json!(a)).collect(), creds: None };
        assert_eq!(git(run(&["init"])).await.unwrap().code, 0);
        std::fs::write(
            dir.path().join(".git/config"),
            "[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = .git/no-hooks\n[commit]\ngpgsign = false\n[user]\nname = Fixture\nemail = fixture@example.invalid\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        assert!(git(run(&["status", "--porcelain"])).await.unwrap().out.contains("?? a.txt"));
        assert_eq!(git(run(&["add", "--", "a.txt"])).await.unwrap().code, 0);
        assert_eq!(git(run(&["commit", "-m", "fixture"])).await.unwrap().code, 0);
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        assert!(git(run(&["diff", "--", "a.txt"])).await.unwrap().out.contains("+two"));
        assert_ne!(git(run(&["rev-parse", "--verify", "unknown-ref"])).await.unwrap().code, 0);
        assert!(git(run(&["status", "-c", "x=y"])).await.unwrap_err().message.contains("option"));
        assert!(git(run(&["fetch", "--upload-pack=evil"])).await.unwrap_err().message.contains("option"));
        assert!(git(run(&["config", "x"])).await.is_err());
        // git-lfs: what it reports and pulls, nothing that writes the user's config or migrates history
        assert!(git(run(&["lfs"])).await.unwrap_err().message.contains("lfs"));
        assert!(git(run(&["lfs", "migrate", "import"])).await.unwrap_err().message.contains("lfs"));
        assert!(git(run(&["lfs", "ls-files", "-c", "x"])).await.unwrap_err().message.contains("option"));
    }
}
