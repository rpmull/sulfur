//! Errors as the page reads them, paths held inside their share, settings
//! written whole, and child processes that never flash a console window.
use std::{
    ffi::OsStr,
    io,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode},
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

/// a text file read or saved whole: source as big as an amalgamation's
pub const MAX_TEXT: usize = 16 << 20;

/// whether `hay` holds `needle` regardless of case; `needle` already lowercase. An ASCII
/// needle is found by comparing bytes as they lie, with no copy of the text: a search of a
/// workspace lowercased every line of every file before
pub fn contains_ci(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if !needle.is_ascii() {
        return hay.to_lowercase().contains(needle);
    }
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    if n.len() > h.len() {
        return false;
    }
    let first = n[0];
    let upper = first.to_ascii_uppercase();
    let last = h.len() - n.len();
    let mut i = 0;
    while i <= last {
        let c = h[i];
        if (c == first || c == upper) && h[i..i + n.len()].eq_ignore_ascii_case(n) {
            return true;
        }
        i += 1;
    }
    false
}

/// the lines of a text holding `q` (lowercase), five at most, as Find in Files shows them:
/// a file without it anywhere is passed over in one scan, its lines never walked
pub fn text_matches(data: &[u8], q: &str) -> Vec<Value> {
    let text = String::from_utf8_lossy(data);
    let mut matches = Vec::new();
    if !contains_ci(&text, q) {
        return matches;
    }
    for (i, line) in text.split('\n').enumerate() {
        if !contains_ci(line, q) {
            continue;
        }
        let trimmed = line.trim();
        let shown = if trimmed.chars().count() > 240 { format!("{}…", trimmed.chars().take(240).collect::<String>()) } else { trimmed.to_owned() };
        matches.push(json!({ "line": i + 1, "text": shown }));
        if matches.len() >= 5 {
            break;
        }
    }
    matches
}
pub const GONE: &str = "no such file or folder";

/// An answer the page shows as it is: its message and status
#[derive(Debug, Clone)]
pub struct Fail {
    pub status: u16,
    pub message: String,
    /// the path wasn't there, as a quiet read tells it
    pub missing: bool,
}

impl Fail {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Fail { status, message: message.into(), missing: status == 404 }
    }
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Fail {}

impl From<io::Error> for Fail {
    fn from(e: io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::NotFound => Fail { status: 404, message: GONE.into(), missing: true },
            io::ErrorKind::PermissionDenied => Fail::new("permission denied", 403),
            io::ErrorKind::NotADirectory => Fail::new("not a folder", 400),
            io::ErrorKind::IsADirectory => Fail::new("a folder, not a file", 400),
            io::ErrorKind::AlreadyExists => Fail::new("already exists", 409),
            io::ErrorKind::DirectoryNotEmpty => Fail::new("the folder isn't empty", 409),
            _ => Fail::new(e.to_string(), 500),
        }
    }
}

impl From<serde_json::Error> for Fail {
    fn from(_: serde_json::Error) -> Self {
        Fail::new("invalid json", 400)
    }
}

impl From<reqwest::Error> for Fail {
    fn from(e: reqwest::Error) -> Self {
        let mut message = e.to_string();
        let mut source = std::error::Error::source(&e);
        while let Some(s) = source {
            message = format!("{message}: {s}");
            source = s.source();
        }
        Fail::new(message, 502)
    }
}

impl From<tokio::task::JoinError> for Fail {
    fn from(e: tokio::task::JoinError) -> Self {
        Fail::new(e.to_string(), 500)
    }
}

pub type Res<T> = Result<T, Fail>;

/// shorthand for a 400 with a message
pub fn fail<T>(message: impl Into<String>) -> Res<T> {
    Err(Fail::new(message, 400))
}

pub fn fail_at<T>(message: impl Into<String>, status: u16) -> Res<T> {
    Err(Fail::new(message, status))
}

/// a JSON answer, never cached
pub fn json<T: Serialize + ?Sized>(value: &T) -> Response<Body> {
    json_status(value, 200)
}

pub fn json_status<T: Serialize + ?Sized>(value: &T, status: u16) -> Response<Body> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"null".to_vec());
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub fn error_response(e: &Fail) -> Response<Body> {
    json_status(&serde_json::json!({ "error": e.message }), e.status)
}

/// CRLF and lone CR as LF
pub fn lf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_owned();
    }
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| {
        #[allow(deprecated)]
        std::env::home_dir().unwrap_or_else(std::env::temp_dir)
    })
}

/// the user's settings folder: AppData's Roaming, Application Support, XDG's
pub fn config_home() -> PathBuf {
    if let Some(p) = std::env::var_os("APPDATA") {
        return PathBuf::from(p);
    }
    if cfg!(target_os = "macos") {
        return home_dir().join("Library/Application Support");
    }
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home_dir().join(".config"))
}

pub fn random_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut x = (nanos as u64) ^ ((std::process::id() as u64) << 32)
        ^ SEQ.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    let mut out = String::with_capacity(16);
    for _ in 0..16 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push(char::from_digit((x % 36) as u32, 36).unwrap_or('0'));
    }
    out
}

/// a settings file replaced whole, so a crash never leaves half of one
pub fn atomic_json(file: &Path, value: &Value) -> Res<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = file.with_file_name(format!(
        "{}.{}.{}.tmp",
        file.file_name().and_then(OsStr::to_str).unwrap_or("settings"),
        std::process::id(),
        random_id()
    ));
    let data = serde_json::to_vec(value)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = (|| -> io::Result<()> {
        use std::io::Write;
        let mut f = options.open(&temp)?;
        f.write_all(&data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&temp, file)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    Ok(written?)
}

pub fn read_json(file: &Path) -> Option<Value> {
    let data = std::fs::read(file).ok()?;
    serde_json::from_slice(strip_bom(&data)).ok()
}

pub fn strip_bom(data: &[u8]) -> &[u8] {
    data.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(data)
}

/// a path with `.` parts dropped, as path.resolve gives it
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// whether `file` is `root` or within it
pub fn inside(root: &Path, file: &Path) -> bool {
    let root = normalize(root);
    let file = normalize(file);
    if cfg!(windows) {
        let lower = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
        let (r, f) = (lower(&root), lower(&file));
        let r = r.trim_end_matches('\\');
        f == r || f.starts_with(&format!("{r}\\"))
    } else {
        file.starts_with(&root)
    }
}

/// a real path without Windows' \\?\ prefix where an ordinary one names it
pub fn canonical(p: &Path) -> io::Result<PathBuf> {
    let real = std::fs::canonicalize(p)?;
    Ok(simplify(real))
}

pub fn simplify(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.len() >= 2 && rest.as_bytes()[1] == b':' && !rest.contains('?') {
                return PathBuf::from(rest);
            }
        }
    }
    p
}

pub fn is_absolute_str(p: &str) -> bool {
    !p.is_empty()
        && (Path::new(p).is_absolute()
            || (cfg!(windows) && (p.starts_with('\\') || p.starts_with('/'))))
}

/// `rel` under `root`, refused when it climbs out, names a drive, or (through a
/// link) resolves outside; for a write, the nearest existing parent decides
pub fn safe_path(root: &Path, rel: &str, write: bool) -> Res<PathBuf> {
    let slashed = rel.replace('\\', "/");
    let drive = rel.len() >= 2 && rel.as_bytes()[0].is_ascii_alphabetic() && rel.as_bytes()[1] == b':';
    if rel.contains('\0')
        || rel.starts_with('/')
        || rel.starts_with('\\')
        || Path::new(rel).is_absolute()
        || drive
        || slashed.split('/').any(|part| part == "..")
    {
        return fail("invalid path");
    }
    let base = canonical(root)?;
    let target = normalize(&base.join(if rel.is_empty() { "." } else { rel }));
    if !inside(&base, &target) {
        return fail("invalid path");
    }
    let mut probe = target.clone();
    loop {
        match canonical(&probe) {
            Ok(resolved) => {
                if !inside(&base, &resolved) {
                    return fail("path leaves its share");
                }
                break;
            }
            Err(e) => {
                let missing = matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
                    || e.raw_os_error() == Some(20);
                if !write || !missing || probe == base {
                    return Err(e.into());
                }
                if !probe.pop() {
                    return Err(e.into());
                }
            }
        }
    }
    Ok(target)
}

/// what a finished command printed, and how it ended
#[derive(Debug, Serialize, Clone)]
pub struct Output {
    pub out: String,
    pub err: String,
    pub code: i32,
}

/// a process that opens no console window of its own on Windows
pub fn hidden(program: impl AsRef<OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    if let Some(Some(path)) = LOGIN_PATH.get() {
        cmd.env("PATH", path);
    }
    cmd
}

pub fn hidden_std(program: impl AsRef<OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000);
    if let Some(Some(path)) = LOGIN_PATH.get() {
        cmd.env("PATH", path);
    }
    cmd
}

/// a process and everything it started, killed when this is dropped unless it ended on
/// its own: git hands its work to ssh, git-remote-https, git-lfs and credential helpers,
/// and killing git alone leaves those waiting (on a sign-in nobody sees) for good
struct Tree {
    pid: Option<u32>,
}

impl Tree {
    fn ended(&mut self) {
        self.pid = None;
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let Some(pid) = self.pid.take() else { return };
        #[cfg(unix)]
        // SAFETY: signals the process group the command was started as the leader of
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            // run to its end here, before the process itself is taken: the tree is found from it
            let _ = hidden_std("taskkill").args(["/pid", &pid.to_string(), "/t", "/f"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    }
}

/// what a pipe gives, kept as it comes so a read cut short still has what it read
async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin, into: std::sync::Arc<std::sync::Mutex<Vec<u8>>>) {
    let mut buf = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut buf).await {
        if n == 0 {
            break;
        }
        into.lock().unwrap().extend_from_slice(&buf[..n]);
    }
}

/// a command run to its end, or killed with everything it started at its deadline (or if
/// the caller goes away). Its output is what it printed by the time it ended: a helper
/// it left running that still holds its pipes is waited for a moment, not to the deadline
pub async fn command(
    args: &[String],
    cwd: Option<&Path>,
    env: &[(String, String)],
    timeout: Duration,
) -> Res<Output> {
    let Some((program, rest)) = args.split_first() else {
        return fail("no command");
    };
    let mut cmd = hidden(program);
    cmd.args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // its own process group, so everything it starts can be signalled together
    #[cfg(unix)]
    cmd.process_group(0);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| Fail::new(format!("{program}: {e}"), 500))?;
    let mut tree = Tree { pid: child.id() };
    let (out, err) = (std::sync::Arc::new(std::sync::Mutex::new(Vec::new())), std::sync::Arc::new(std::sync::Mutex::new(Vec::new())));
    let readers = tokio::spawn({
        let (stdout, stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let (o, e) = (out.clone(), err.clone());
        async move {
            tokio::join!(drain(stdout, o), drain(stderr, e));
        }
    });
    // aborted with the command, whichever way it ends
    let _readers = AbortOnDrop(readers.abort_handle());
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status?,
        Err(_) => return fail_at(format!("{program} took too long and was stopped"), 504),
    };
    tree.ended();
    let _ = tokio::time::timeout(Duration::from_secs(2), readers).await;
    let text = |b: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap()).into_owned();
    Ok(Output { out: text(&out), err: text(&err), code: exit_code(&status) })
}

struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn exit_code(status: &std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    1
}

/// an executable on PATH, as a shell finds it
pub fn which(name: &str) -> Option<PathBuf> {
    let path = path_var()?;
    let exts: Vec<String> = if cfg!(windows) {
        let mut v = vec![String::new()];
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        v.extend(pathext.split(';').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()));
        v
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in &exts {
            if cfg!(windows) && ext.is_empty() && Path::new(name).extension().is_none() {
                continue;
            }
            let file = dir.join(format!("{name}{ext}"));
            if is_executable(&file) {
                return Some(file);
            }
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// the PATH every command and terminal gets: the user's login shell's once
/// it's known (Finder and the dock start apps with a bare one), else this process's
pub fn path_var() -> Option<std::ffi::OsString> {
    LOGIN_PATH.get().cloned().flatten().or_else(|| std::env::var_os("PATH"))
}

static LOGIN_PATH: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();

/// the login shell asked for its PATH, once, on a thread of its own: node,
/// cargo, go and the rest then found as in a terminal
pub fn adopt_login_path() {
    #[cfg(unix)]
    std::thread::spawn(|| {
        let found = login_path();
        let _ = LOGIN_PATH.set(found);
    });
}

#[cfg(unix)]
fn login_path() -> Option<std::ffi::OsString> {
    if std::env::var_os("SULFUR_KEEP_PATH").is_some() {
        return None;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/sh".into());
    let mark = "__SULFUR_PATH__";
    let mut child = std::process::Command::new(&shell)
        .args(["-l", "-c", &format!("printf '{mark}%s{mark}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut stdout = child.stdout.take();
    std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(s) = stdout.as_mut() {
            let _ = std::io::Read::read_to_string(s, &mut out);
        }
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let _ = child.kill();
    let _ = child.wait();
    let found = out.split(mark).nth(1).filter(|p| !p.is_empty())?.to_owned();
    let mut seen = std::collections::HashSet::new();
    let current = std::env::var("PATH").unwrap_or_default();
    let merged: Vec<&str> = found.split(':').chain(current.split(':')).filter(|p| !p.is_empty() && seen.insert(*p)).collect();
    Some(merged.join(":").into())
}

/// Ctrl+C, or the system asking the process to end
pub async fn interrupted() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// ICU root's order of ASCII's spaces, punctuation and symbols, all before digits
const ROOT_PUNCT: &str = "\t\n\u{b}\u{c}\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

fn root_rank(c: char) -> i32 {
    if (c as u32) < 128 {
        if let Some(i) = ROOT_PUNCT.find(c) {
            return i as i32 + 1;
        }
        if c.is_ascii_digit() {
            return 100 + (c as i32 - '0' as i32);
        }
        if c.is_ascii_alphabetic() {
            return 200 + (c.to_ascii_lowercase() as i32 - 'a' as i32);
        }
        return -1;
    }
    if c.is_control() {
        return -1;
    }
    if c.is_whitespace() {
        return 0;
    }
    if c.is_numeric() {
        return 100 + c.to_digit(10).unwrap_or(0) as i32;
    }
    if c.is_alphabetic() {
        return 1000 + c.to_lowercase().next().unwrap_or(c) as i32;
    }
    50
}

struct RootKey {
    prim: Vec<i32>,
    marks: Vec<String>,
    upper: Vec<bool>,
}

fn root_key(s: &str) -> RootKey {
    use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
    let mut k = RootKey { prim: vec![], marks: vec![], upper: vec![] };
    for c in s.nfd() {
        if is_combining_mark(c) {
            if let Some(m) = k.marks.last_mut() {
                m.push(c);
            }
            continue;
        }
        let w = root_rank(c);
        if w < 0 {
            continue;
        }
        k.prim.push(w);
        k.marks.push(String::new());
        k.upper.push(c.is_uppercase());
    }
    k
}

/// String.prototype.localeCompare under ICU's root order: base letters, then
/// accents, then lower before upper, then code units
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let (ka, kb) = (root_key(a), root_key(b));
    ka.prim
        .cmp(&kb.prim)
        .then_with(|| ka.marks.cmp(&kb.marks))
        .then_with(|| ka.upper.cmp(&kb.upper))
        .then_with(|| a.encode_utf16().cmp(b.encode_utf16()))
}

/// a name's place in that order, worked out once: a listing sorted by these keys
/// normalizes each name once rather than twice per comparison
#[derive(PartialEq, Eq, PartialOrd, Ord)]
pub struct SortKey {
    prim: Vec<i32>,
    marks: Vec<String>,
    upper: Vec<bool>,
    units: Vec<u16>,
}

pub fn sort_key(s: &str) -> SortKey {
    let k = root_key(s);
    SortKey { prim: k.prim, marks: k.marks, upper: k.upper, units: s.encode_utf16().collect() }
}

/// items sorted as locale_compare orders their names, folders first when asked
pub fn locale_sort<T>(items: &mut [T], name: impl Fn(&T) -> &str, dir: impl Fn(&T) -> bool) {
    items.sort_by_cached_key(|x| (!dir(x), sort_key(name(x))));
}

/// a name matched against a glob of * and ?, ignoring case
pub fn glob_match(pattern: &str, name: &str) -> bool {
    // ASCII both (nearly every name and glob): matched over the bytes as they lie, no copy
    if pattern.is_ascii() && name.is_ascii() {
        return glob_match_in(pattern.as_bytes(), name.as_bytes(), |a, b| a.eq_ignore_ascii_case(&b), b'?', b'*', b'\n');
    }
    let p: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let n: Vec<char> = name.chars().flat_map(char::to_lowercase).collect();
    glob_match_in(&p, &n, |a, b| a == b, '?', '*', '\n')
}

fn glob_match_in<T: Copy + PartialEq>(p: &[T], n: &[T], same: impl Fn(T, T) -> bool, any: T, star_c: T, nl: T) -> bool {
    let (mut pi, mut ni) = (0, 0);
    let (mut star, mut mark) = (usize::MAX, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == any || (same(p[pi], n[ni]) && p[pi] != star_c)) && n[ni] != nl {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == star_c {
            star = pi;
            mark = ni;
            pi += 1;
        } else if star != usize::MAX && n[mark] != nl {
            pi = star + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == star_c {
        pi += 1;
    }
    pi == p.len()
}

/// comma-separated globs, any of which skips a name
pub fn skipper(skip: &str) -> impl Fn(&str) -> bool {
    let patterns: Vec<String> = skip
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    move |name: &str| patterns.iter().any(|p| glob_match(p, name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn globs_match_whole_names_ignoring_case() {
        assert!(glob_match("[a].*", "[A].js"));
        assert!(!glob_match("[a].*", "a.js"));
        assert!(glob_match("*.JS", "dir.js"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "abbc"));
        // beyond ASCII, case-blind through Unicode lowercasing
        assert!(glob_match("*.TXT", "Ünïcode.txt"));
        assert!(glob_match("ünï*", "ÜNÏcode.txt"));
        assert!(!glob_match("*.md", "Ünïcode.txt"));
        assert!(glob_match("*", ""));
        assert!(skipper("node_modules, .git")("node_modules"));
    }

    #[test]
    fn names_sort_as_icu_root() {
        let mut v = vec!["b", "A", "a", "_x", "10", "2", "é", "e", "Z"];
        v.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(v, ["_x", "10", "2", "a", "A", "b", "e", "é", "Z"]);
        assert_eq!(locale_compare("dir", "binary"), Greater);
        assert_eq!(locale_compare("a", "a"), Equal);
        // the cached keys order names the same, folders first when asked
        let mut names: Vec<(&str, bool)> = vec![("b", false), ("A", true), ("a", false), ("_x", false), ("10", true), ("é", false), ("e", false), ("Z", true)];
        locale_sort(&mut names, |x| x.0, |x| x.1);
        assert_eq!(names.iter().map(|x| x.0).collect::<Vec<_>>(), ["10", "A", "Z", "_x", "a", "b", "e", "é"]);
        let mut plain = vec!["b", "A", "a", "_x", "10", "2", "é", "e", "Z"];
        locale_sort(&mut plain, |x| x, |_| false);
        assert_eq!(plain, ["_x", "10", "2", "a", "A", "b", "e", "é", "Z"]);
        assert!(sort_key("a") < sort_key("A") && sort_key("e") < sort_key("é") && sort_key("x") == sort_key("x"));
    }
}
