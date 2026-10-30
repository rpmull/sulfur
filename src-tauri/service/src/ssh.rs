//! Machines reached over plain SSH, with no mesh: hosts saved by address, user and
//! key, each one's files through SFTP and its terminals, runs, Git and toolchains
//! through SSH channels. This process serves them itself under /api/ssh/<name>/
//! with the version 1 APIs a mesh's host gives (mesh.rs's `ssh` provider), beside
//! whichever mesh is linked. Host keys are checked against ~/.ssh/known_hosts, as
//! ssh does, a new one only trusted when the user says so. Logins go by ssh-agent,
//! ~/.ssh's usual keys or a named one, then a password; a password or passphrase
//! lives only in this process's memory, never on disk.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use bytes::Bytes;
use futures_util::{future::BoxFuture, FutureExt};
use russh::{
    client::{self, AuthResult, KeyboardInteractiveAuthResponse},
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use russh_sftp::{
    client::{fs::File as SftpFile, SftpSession},
    protocol::{OpenFlags, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::{mpsc, oneshot, Mutex},
};

use crate::{
    collab::{Collab, Store},
    files::{find_from, parse_count, posix_join, read_body, Entry, Share, LIST_MAX, TREE_MAX, UPLOAD_MAX, UPLOAD_PREFIX},
    mesh,
    processes::{self, GitRequest, Proc, Shell, Shells, Terminals, KNOWN, UNIX_PATH},
    util::{fail, fail_at, glob_match, home_dir, skipper, Fail, Output, Res, GONE, MAX_TEXT},
    ws::Ws,
};

/// a saved host: how ssh reaches it, and the name Sulfur gives it
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Spec {
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    /// a private key file; '' for ssh-agent and ~/.ssh's usual keys
    #[serde(default)]
    pub key: String,
}

fn default_port() -> u16 {
    22
}

/// what the user typed to connect
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Answers {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    /// the fingerprint of a new host key the user accepted
    #[serde(default)]
    pub trust: Option<String>,
}

/// why a connection didn't happen: a failure, or something to ask the user
#[derive(Debug)]
pub enum Refused {
    Fail(Fail),
    /// need: "password", "passphrase" or "trust" (a new host key, by its fingerprint)
    Need { need: &'static str, message: String, fingerprint: String },
}

impl From<Fail> for Refused {
    fn from(f: Fail) -> Self {
        Refused::Fail(f)
    }
}

impl Refused {
    /// the page's answer: its status and body
    pub fn answer(&self) -> (u16, Value) {
        match self {
            Refused::Fail(f) => (f.status, json!({ "error": f.message })),
            Refused::Need { need, message, fingerprint } => (401, json!({ "error": message, "need": need, "fingerprint": fingerprint })),
        }
    }
}

/// an address as ssh and scp take it: user@host, user@host:2222, ssh://user@host:2222/path,
/// user@host:/path; with no user, the default
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub user: String,
    pub host: String,
    pub port: u16,
    /// a folder named after the address, to open once connected
    pub path: String,
}

pub fn parse_target(input: &str, default_user: &str) -> Res<Target> {
    let bad = || Fail::new("an address as ssh takes it: user@host, user@host:2222, or user@host:/folder", 400);
    let t = input.trim();
    let (authority, path) = match t.strip_prefix("ssh://") {
        Some(rest) => match rest.find('/') {
            Some(i) => (&rest[..i], rest[i..].trim_end_matches('/').to_owned()),
            None => (rest, String::new()),
        },
        None => {
            // scp's user@host:/path, the path beginning with / or ~ after the host's colon
            let after = t.rfind('@').map(|i| i + 1).unwrap_or(0);
            let close = if t[after..].starts_with('[') { t[after..].find(']').map(|i| after + i) } else { Some(after) };
            let colon = close.and_then(|c| t[c..].find(":/").or_else(|| t[c..].find(":~")).map(|i| c + i));
            match colon {
                Some(i) => (&t[..i], t[i + 1..].to_owned()),
                None => (t, String::new()),
            }
        }
    };
    if authority.is_empty() || authority.contains(|c: char| c.is_whitespace() || c == '/') {
        return Err(bad());
    }
    let (user, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (u, h),
        None => (default_user, authority),
    };
    let (host, port) = if let Some(rest) = hostport.strip_prefix('[') {
        let (h, after) = rest.split_once(']').ok_or_else(bad)?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().map_err(|_| bad())?,
            None if after.is_empty() => 22,
            None => return Err(bad()),
        };
        (h, port)
    } else {
        match hostport.split_once(':') {
            // one colon: a port (ssh:// only; scp form's paths were taken above)
            Some((h, p)) if !p.contains(':') => (h, p.parse::<u16>().map_err(|_| bad())?),
            _ => (hostport, 22),
        }
    };
    let user_ok = !user.is_empty() && user.chars().all(|c| c.is_ascii_alphanumeric() || "._-$".contains(c));
    let host_ok = !host.is_empty() && !host.starts_with('-') && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:_%".contains(c));
    if !user_ok || !host_ok || port == 0 || path.contains('\0') {
        return Err(bad());
    }
    Ok(Target { user: user.into(), host: host.into(), port, path })
}

/// a host's name in Sulfur (lowercase letters, digits and dashes, as every host's is):
/// a DNS name by its first label, an address in full; numbered past the taken ones
pub fn name_for(host: &str, taken: &[String]) -> String {
    let lettered = host.chars().any(|c| c.is_ascii_alphabetic()) && !host.contains(':');
    let source = if lettered { host.split('.').next().unwrap_or(host) } else { host };
    let mut base = String::new();
    for c in source.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            base.push(c);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base = base.trim_matches('-').to_owned();
    let base = if base.is_empty() { "ssh-host".to_owned() } else { base };
    let mut name = base.clone();
    let mut n = 2;
    while taken.iter().any(|t| *t == name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    name
}

/// a value as one single-quoted sh word
pub fn sh(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\\''"))
}

/// a script run by sh whatever the user's login shell is (fish and csh among them)
fn sh_c(script: &str) -> String {
    format!("sh -c {}", sh(script))
}

/// a path under a share's folder, never above it: '..' refused, '.' and empty parts dropped
pub fn remote_path(root: &str, rel: &str) -> Res<String> {
    if rel.contains(['\0', '\\']) {
        return fail("invalid path");
    }
    let mut out = root.trim_end_matches('/').to_owned();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return fail("invalid path"),
            p => {
                out.push('/');
                out.push_str(p);
            }
        }
    }
    if out.is_empty() {
        out.push('/');
    }
    Ok(out)
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn parent(p: &str) -> &str {
    match p.trim_end_matches('/').rfind('/') {
        Some(0) => "/",
        Some(i) => &p[..i],
        None => "",
    }
}

fn ssh_fail(e: russh::Error) -> Fail {
    Fail::new(format!("ssh: {e}"), 502)
}

fn sftp_fail(e: russh_sftp::client::error::Error) -> Fail {
    use russh_sftp::client::error::Error as E;
    match &e {
        E::Status(s) if s.status_code == StatusCode::NoSuchFile => Fail::new(GONE, 404),
        E::Status(s) if s.status_code == StatusCode::PermissionDenied => Fail::new("permission denied", 403),
        E::Status(s) if !s.error_message.is_empty() => Fail::new(s.error_message.clone(), 500),
        E::Status(s) => Fail::new(s.status_code.to_string(), 500),
        _ => Fail::new(format!("SFTP: {e}"), 502),
    }
}

// --- the connection: host key, login --------------------------------------------------

/// the server's key as it was offered, where it wasn't one known_hosts knows
#[derive(Debug, Clone)]
struct KeySeen {
    fingerprint: String,
    /// known_hosts has another key for the host, at this line
    changed: Option<usize>,
}

pub struct Client {
    host: String,
    port: u16,
    trust: Option<String>,
    seen: Arc<StdMutex<Option<KeySeen>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, offered: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        use russh::keys::known_hosts::{check_known_hosts, learn_known_hosts};
        let key = offered.public_key();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let changed = match check_known_hosts(&self.host, self.port, &key) {
            Ok(true) => return Ok(true),
            Err(russh::keys::Error::KeyChanged { line }) => Some(line),
            // unknown (or no known_hosts yet): trusted only as the user accepted it
            _ if self.trust.as_deref() == Some(fingerprint.as_str()) => {
                // kept where ssh itself looks, so git's ssh knows it too
                let _ = learn_known_hosts(&self.host, self.port, &key);
                return Ok(true);
            }
            _ => None,
        };
        *self.seen.lock().unwrap() = Some(KeySeen { fingerprint, changed });
        Ok(false)
    }
}

type Handle = client::Handle<Client>;

impl KeySeen {
    fn refusal(self, spec: &Spec) -> Refused {
        match self.changed {
            Some(line) => Refused::Fail(Fail::new(
                format!(
                    "{}'s host key isn't the one this computer knows for it (~/.ssh/known_hosts, line {line}): it was reinstalled, or this isn't that machine. If it was reinstalled, remove that line and connect again.",
                    spec.host
                ),
                409,
            )),
            None => Refused::Need {
                need: "trust",
                message: format!(
                    "{} is new to this computer. Its host key is {}: trust it if that's what the machine's owner gives.",
                    spec.host, self.fingerprint
                ),
                fingerprint: self.fingerprint,
            },
        }
    }
}

/// ~/.ssh's usual keys, as ssh tries them
fn default_keys() -> Vec<PathBuf> {
    let dir = home_dir().join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|k| dir.join(k)).filter(|p| p.is_file()).collect()
}

/// a key file named with ~ for the home
fn key_path(p: &str) -> PathBuf {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(p),
    }
}

async fn agent_login(handle: &mut Handle, user: &str, rsa: Option<HashAlg>) -> bool {
    use russh::keys::agent::client::AgentClient;
    #[cfg(unix)]
    let agent = AgentClient::<tokio::net::UnixStream>::connect_env().await.ok().map(AgentClient::dynamic);
    #[cfg(windows)]
    let agent = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(r"\\.\pipe\openssh-ssh-agent")
        .ok()
        .map(|pipe| AgentClient::connect(pipe).dynamic());
    let Some(mut agent) = agent else { return false };
    let Ok(ids) = agent.request_identities().await else { return false };
    for id in ids {
        let key = id.public_key().into_owned();
        if let Ok(AuthResult::Success) = handle.authenticate_publickey_with(user, key, rsa, &mut agent).await {
            return true;
        }
    }
    false
}

/// whether the server's remaining methods let a password through
fn takes_passwords(methods: &Option<String>) -> bool {
    methods.as_deref().is_none_or(|m| m.contains("Password") || m.contains("KeyboardInteractive"))
}

async fn authenticate(handle: &mut Handle, spec: &Spec, a: &Answers) -> Result<(), Refused> {
    let user = spec.user.as_str();
    let to = format!("{user}@{}", spec.host);
    let rsa = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
    // what the server still takes, once it's said (its methods, as Debug names them)
    let mut methods: Option<String> = None;
    let mut locked: Option<PathBuf> = None;
    // keys first, unless this is the round with the password typed: each try counts
    // against the server's MaxAuthTries
    if a.password.is_none() {
        if spec.key.is_empty() && agent_login(handle, user, rsa).await {
            return Ok(());
        }
        let keys = if spec.key.is_empty() { default_keys() } else { vec![key_path(&spec.key)] };
        for path in keys {
            let key = match russh::keys::load_secret_key(&path, a.passphrase.as_deref()) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    locked.get_or_insert(path);
                    continue;
                }
                // a passphrase given and the key still not read: the wrong one
                Err(_) if a.passphrase.is_some() => {
                    return Err(Refused::Need {
                        need: "passphrase",
                        message: format!("That isn't {}'s passphrase.", path.display()),
                        fingerprint: String::new(),
                    })
                }
                Err(e) if !spec.key.is_empty() => return Err(Fail::new(format!("{}: {e}", path.display()), 400).into()),
                Err(_) => continue,
            };
            match handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa)).await.map_err(ssh_fail)? {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { remaining_methods, .. } => methods = Some(format!("{remaining_methods:?}")),
            }
        }
        if let Some(path) = locked.filter(|_| !spec.key.is_empty() || !takes_passwords(&methods)) {
            return Err(Refused::Need { need: "passphrase", message: format!("{} is locked: its passphrase", path.display()), fingerprint: String::new() });
        }
        if !takes_passwords(&methods) {
            return Err(Fail::new(
                format!("{to} didn't take this computer's keys, and takes no passwords: add this computer's public key to ~/.ssh/authorized_keys there, or name the key it takes"),
                401,
            )
            .into());
        }
        return Err(Refused::Need { need: "password", message: format!("{to}'s password"), fingerprint: String::new() });
    }
    let pass = a.password.clone().unwrap_or_default();
    match handle.authenticate_password(user, pass.as_str()).await.map_err(ssh_fail)? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure { remaining_methods, .. } => methods = Some(format!("{remaining_methods:?}")),
    }
    // PAM servers often take a password only as keyboard-interactive's one prompt
    if methods.as_deref().is_none_or(|m| m.contains("KeyboardInteractive")) {
        let mut r = handle.authenticate_keyboard_interactive_start(user, None::<String>).await.map_err(ssh_fail)?;
        for _ in 0..4 {
            r = match r {
                KeyboardInteractiveAuthResponse::Success => return Ok(()),
                KeyboardInteractiveAuthResponse::Failure { .. } => break,
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => handle
                    .authenticate_keyboard_interactive_respond(vec![pass.clone(); prompts.len()])
                    .await
                    .map_err(ssh_fail)?,
            };
        }
    }
    Err(Refused::Need { need: "password", message: format!("{to} refused that password"), fingerprint: String::new() })
}

/// one command run to its end without a terminal: what it printed and its exit code
async fn exec(handle: &Handle, cmd: &str, timeout: Duration) -> Res<Output> {
    let deadline = tokio::time::Instant::now() + timeout;
    let slow = || fail_at("the command took too long and was stopped", 504);
    let opened = async {
        let ch = handle.channel_open_session().await.map_err(ssh_fail)?;
        ch.exec(true, cmd).await.map_err(ssh_fail)?;
        // nothing to read: a command that asks gets end of input, not a wait
        ch.eof().await.map_err(ssh_fail)?;
        Ok::<_, Fail>(ch)
    };
    let Ok(opened) = tokio::time::timeout_at(deadline, opened).await else { return slow() };
    let mut ch = opened?;
    let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
    loop {
        // the channel is the command's: closed at the deadline, the host's end of its pipes
        // goes and it stops, instead of running on there with nobody to hear it
        let Ok(m) = tokio::time::timeout_at(deadline, ch.wait()).await else {
            let _ = tokio::time::timeout(Duration::from_secs(2), ch.close()).await;
            return slow();
        };
        match m {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => err.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
            Some(_) => {}
            None => break,
        }
    }
    Ok(Output {
        out: String::from_utf8_lossy(&out).into_owned(),
        err: String::from_utf8_lossy(&err).into_owned(),
        // ended by a signal, or the connection gone: never a success
        code: code.unwrap_or(255),
    })
}

// --- terminals and runs: a channel with a pseudo-terminal -----------------------------------

enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Stop,
}

/// a command in a terminal on the host, driven through its channel's task
struct ChannelProc {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl Proc for ChannelProc {
    fn input(&self, data: &[u8]) {
        let _ = self.tx.send(Cmd::Data(data.to_vec()));
    }
    fn resize(&self, cols: f64, rows: f64) {
        if (20.0..=1000.0).contains(&cols) && (5.0..=500.0).contains(&rows) {
            let _ = self.tx.send(Cmd::Resize(cols as u32, rows as u32));
        }
    }
    fn stop(&self) {
        let _ = self.tx.send(Cmd::Stop);
    }
}

async fn channel_proc(handle: &Handle, cmd: &str, cols: u16, rows: u16, out: mpsc::UnboundedSender<Bytes>) -> Res<(Arc<dyn Proc>, oneshot::Receiver<i32>)> {
    let size = processes::size(cols, rows);
    let mut ch = handle.channel_open_session().await.map_err(ssh_fail)?;
    ch.request_pty(false, "xterm-256color", size.cols as u32, size.rows as u32, 0, 0, &[]).await.map_err(ssh_fail)?;
    ch.exec(true, cmd).await.map_err(ssh_fail)?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let (exit_tx, exit_rx) = oneshot::channel();
    tokio::spawn(async move {
        let mut code = None;
        let mut stopping = false;
        loop {
            tokio::select! {
                m = ch.wait() => match m {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = out.send(Bytes::copy_from_slice(&data));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
                    Some(_) => {}
                    None => break,
                },
                c = rx.recv(), if !stopping => match c {
                    Some(Cmd::Data(d)) => { let _ = ch.data(&d[..]).await; }
                    Some(Cmd::Resize(w, h)) => { let _ = ch.window_change(w, h, 0, 0).await; }
                    // closing the channel hangs its terminal up: the command and its children end
                    Some(Cmd::Stop) | None => { stopping = true; let _ = ch.close().await; }
                },
            }
        }
        let _ = exit_tx.send(code.unwrap_or(if stopping { -1 } else { 1 }));
    });
    Ok((Arc::new(ChannelProc { tx }), exit_rx))
}

/// the host's login shell in a terminal, in the folder asked for
struct SshShells {
    handle: Arc<Handle>,
    files: Arc<RemoteFiles>,
    home: String,
}

impl Shells for SshShells {
    fn shell(&self, wanted: String, cols: u16, rows: u16, out: mpsc::UnboundedSender<Bytes>) -> BoxFuture<'_, Res<Shell>> {
        async move {
            let there = wanted.starts_with('/') && self.files.sftp.metadata(wanted.clone()).await.is_ok_and(|m| m.is_dir());
            let dir = if there { wanted } else { self.home.clone() };
            let script = format!("cd {} 2>/dev/null; COLORTERM=truecolor TERM_PROGRAM=Sulfur; export COLORTERM TERM_PROGRAM; exec \"${{SHELL:-/bin/sh}}\" -l", sh(&dir));
            let (p, exited) = channel_proc(&self.handle, &sh_c(&script), cols, rows, out).await?;
            Ok((p, exited, dir))
        }
        .boxed()
    }
}

// --- files over SFTP -----------------------------------------------------------------

struct Upload {
    temp: String,
    file: SftpFile,
    offset: u64,
    total: u64,
    at: Instant,
}

/// an SSH host's files as the files API gives them, by SFTP
pub struct RemoteFiles {
    sftp: SftpSession,
    pub shares: Vec<Share>,
    uploads: Mutex<HashMap<String, Upload>>,
}

/// the lines of a text holding `q`, five at most, as Find in Files shows them (util.rs)
fn text_matches(data: &[u8], q: &str) -> Vec<Value> {
    crate::util::text_matches(data, q)
}

impl RemoteFiles {
    pub fn share(&self, id: &str) -> Res<&Share> {
        self.shares.iter().find(|s| s.id == id).ok_or_else(|| Fail::new("no such folder here", 404))
    }

    pub fn path(&self, id: &str, rel: &str) -> Res<String> {
        remote_path(&self.share(id)?.label, rel)
    }

    async fn entries(&self, dir: &str) -> Res<Vec<Entry>> {
        let listing = self.sftp.read_dir(dir).await.map_err(sftp_fail)?;
        let mut out = Vec::new();
        for e in listing {
            let name = e.file_name();
            if name == "." || name == ".." || name.starts_with(UPLOAD_PREFIX) {
                continue;
            }
            let link = e.file_type().is_symlink();
            // a link as its target says, as this computer's listing has it
            let meta = if link { self.sftp.metadata(join(dir, &name)).await.ok() } else { Some(e.metadata()) };
            out.push(Entry {
                dir: meta.as_ref().is_some_and(|m| m.is_dir()),
                link,
                size: meta.as_ref().filter(|m| m.is_regular()).and_then(|m| m.size),
                mtime: meta.as_ref().and_then(|m| m.mtime).map(|t| t as i64 * 1000),
                empty: None,
                name,
            });
        }
        crate::util::locale_sort(&mut out, |e| &e.name, |_| false);
        Ok(out)
    }

    pub async fn list(&self, id: &str, rel: &str) -> Res<Value> {
        let mut entries = self.entries(&self.path(id, rel)?).await?;
        crate::util::locale_sort(&mut entries, |e| &e.name, |e| e.dir);
        let truncated = entries.len() > LIST_MAX;
        entries.truncate(LIST_MAX);
        Ok(json!({ "path": rel, "entries": entries, "truncated": truncated }))
    }

    /// a folder's tree breadth first, `depth` levels down, as this computer's is
    pub async fn tree(&self, id: &str, rel: &str, depth: &str, matching: &str, skip: &str) -> Res<Value> {
        let root = self.path(id, rel)?;
        let max_depth = depth.trim().parse::<f64>().ok().filter(|d| d.is_finite()).map(|d| d.trunc() as i64).unwrap_or(1).clamp(1, 8);
        let skipped = skipper(skip);
        let mut entries = Vec::new();
        let mut level = vec![(rel.to_owned(), root)];
        let mut truncated = false;
        let mut lv = 1;
        while lv <= max_depth && !level.is_empty() && !truncated {
            // a level's folders listed sixteen at a time, each a round trip
            let mut lists = Vec::with_capacity(level.len());
            for chunk in level.chunks(16) {
                lists.extend(futures_util::future::join_all(chunk.iter().map(|(_, abs)| self.entries(abs))).await);
            }
            let mut next = Vec::new();
            for (i, ((dir, abs), children)) in level.iter().zip(lists).enumerate() {
                let children = match children {
                    Ok(c) => c,
                    Err(e) if lv == 1 && i == 0 => return Err(e),
                    Err(_) => continue,
                };
                for e in children {
                    if e.dir && skipped(&e.name) {
                        continue;
                    }
                    let p = posix_join(dir, &e.name);
                    if e.dir && !e.link {
                        next.push((p.clone(), join(abs, &e.name)));
                    }
                    if !matching.is_empty() && !glob_match(matching, &e.name) {
                        continue;
                    }
                    if entries.len() >= TREE_MAX {
                        truncated = true;
                        break;
                    }
                    let mut item = Map::new();
                    item.insert("path".into(), json!(if e.dir { format!("{p}/") } else { p }));
                    if !e.dir {
                        item.insert("size".into(), json!(e.size));
                    }
                    item.insert("mtime".into(), json!(e.mtime));
                    entries.push(Value::Object(item));
                }
                if truncated {
                    break;
                }
            }
            level = next;
            lv += 1;
        }
        let mut out = json!({ "path": rel, "depth": max_depth, "entries": entries });
        if truncated {
            out["truncated"] = json!(true);
        }
        Ok(out)
    }

    /// names, or text inside files of up to 1 MiB, under a folder; 200 results at most
    pub async fn search(&self, id: &str, rel: &str, query: &str, content: bool, glob: &str, skip: &str) -> Res<Value> {
        let q = query.trim().to_lowercase();
        if q.is_empty() && glob.is_empty() {
            return fail("a query or a glob");
        }
        let skipped = skipper(skip);
        let mut results = Vec::new();
        let mut scanned = 0usize;
        let mut truncated = false;
        let mut stack = vec![(rel.to_owned(), self.path(id, rel)?)];
        'walk: while let Some((dir, abs)) = stack.pop() {
            let Ok(children) = self.entries(&abs).await else { continue };
            let mut below = Vec::new();
            for e in children {
                if e.dir && skipped(&e.name) {
                    continue;
                }
                scanned += 1;
                if scanned > 50000 || results.len() >= 200 {
                    truncated = true;
                    break 'walk;
                }
                let p = posix_join(&dir, &e.name);
                let file = join(&abs, &e.name);
                if glob.is_empty() || glob_match(glob, &e.name) {
                    if !content && crate::util::contains_ci(&e.name, &q) {
                        results.push(json!({ "path": if e.dir { format!("{p}/") } else { p.clone() } }));
                    } else if content && !e.dir && !e.link && e.size.unwrap_or(u64::MAX) <= 1 << 20 {
                        if let Ok(data) = self.sftp.read(file.clone()).await {
                            let matches = if data.contains(&0) { Vec::new() } else { text_matches(&data, &q) };
                            if !matches.is_empty() {
                                results.push(json!({ "path": p, "matches": matches }));
                            }
                        }
                    }
                }
                if e.dir && !e.link {
                    below.push((p, file));
                }
            }
            stack.extend(below.into_iter().rev());
        }
        let mut out = json!({ "path": rel, "results": results });
        if truncated {
            out["truncated"] = json!(true);
        }
        Ok(out)
    }

    pub async fn read(&self, id: &str, rel: &str) -> Res<Value> {
        let p = self.path(id, rel)?;
        let m = self.sftp.metadata(p.as_str()).await.map_err(sftp_fail)?;
        if !m.is_regular() {
            return fail("not a file");
        }
        let size = m.size.unwrap_or(0);
        if size > MAX_TEXT as u64 {
            return Ok(json!({ "path": rel, "size": size, "tooBig": true }));
        }
        let data = self.sftp.read(p).await.map_err(sftp_fail)?;
        if data.contains(&0) {
            return Ok(json!({ "path": rel, "size": data.len(), "binary": true }));
        }
        let text = match String::from_utf8(data) {
            Ok(t) => t,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        };
        Ok(json!({ "path": rel, "size": text.len(), "text": text }))
    }

    /// a file opened to stream down: it, its size and its name
    pub async fn open(&self, id: &str, rel: &str) -> Res<(SftpFile, u64, String)> {
        let p = self.path(id, rel)?;
        let m = self.sftp.metadata(p.as_str()).await.map_err(sftp_fail)?;
        if !m.is_regular() {
            return fail("not a file");
        }
        let name = p.rsplit('/').next().unwrap_or("").to_owned();
        Ok((self.sftp.open(p).await.map_err(sftp_fail)?, m.size.unwrap_or(0), name))
    }

    /// every folder down to `dir` made where missing
    async fn mkdirs(&self, dir: &str) -> Res<()> {
        let mut at = String::new();
        for part in dir.split('/').filter(|p| !p.is_empty()) {
            at.push('/');
            at.push_str(part);
            match self.sftp.metadata(at.as_str()).await {
                Ok(m) if m.is_dir() => {}
                Ok(_) => return fail_at(format!("{at} is a file, not a folder"), 409),
                Err(_) => self.sftp.create_dir(at.as_str()).await.map_err(sftp_fail)?,
            }
        }
        Ok(())
    }

    /// a whole file written over: the same file kept (its permissions, its inode), truncated
    async fn write(&self, p: &str, data: &[u8]) -> Res<()> {
        let mut f = self.sftp.create(p).await.map_err(sftp_fail)?;
        f.write_all(data).await?;
        f.shutdown().await?;
        Ok(())
    }

    /// a whole text, or one unique `old` replaced by `new`
    pub async fn save(&self, id: &str, rel: &str, text: Option<String>, old: Option<String>, new: Option<String>) -> Res<Value> {
        let target = self.path(id, rel)?;
        let text = match (old, new) {
            (Some(old), Some(new)) => {
                let current = String::from_utf8_lossy(&self.sftp.read(target.as_str()).await.map_err(sftp_fail)?).into_owned();
                let Some(at) = current.find(&old).filter(|_| !old.is_empty()) else {
                    return fail_at("old text not found", 409);
                };
                if find_from(current.as_bytes(), old.as_bytes(), at + 1).is_some() {
                    return fail_at("old text found more than once, give more of it", 409);
                }
                format!("{}{}{}", &current[..at], new, &current[at + old.len()..])
            }
            _ => match text {
                Some(t) => t,
                None => return fail("text, or old and new"),
            },
        };
        if text.len() > MAX_TEXT {
            return fail_at("over 16MB", 413);
        }
        self.mkdirs(parent(&target)).await?;
        self.write(&target, text.as_bytes()).await?;
        Ok(json!({ "ok": true, "path": rel, "size": text.len() }))
    }

    async fn drop_upload(&self, u: Upload) {
        let mut f = u.file;
        let _ = f.shutdown().await;
        drop(f);
        let _ = self.sftp.remove_file(u.temp).await;
    }

    /// a whole body, or one chunk of an upload at its offset; the file appears whole
    pub async fn upload(&self, id: &str, rel: &str, body: axum::body::Body, upload: Option<&str>, offset: Option<&str>, total: Option<&str>) -> Res<Value> {
        let target = self.path(id, rel)?;
        self.mkdirs(parent(&target)).await?;
        let Some(upload) = upload.filter(|u| !u.is_empty()) else {
            let data = read_body(body, 64 << 20).await?;
            self.write(&target, &data).await?;
            return Ok(json!({ "ok": true, "path": rel, "size": data.len() }));
        };
        let (Some(size), Some(offset)) = (parse_count(total.unwrap_or("")), parse_count(offset.unwrap_or("0"))) else { return fail("invalid upload") };
        if upload.len() > 80 || !upload.chars().all(|c| c.is_ascii_alphanumeric()) || size > UPLOAD_MAX {
            return fail("invalid upload");
        }
        let data = read_body(body, 8 << 20).await?;
        let key = format!("{id}\n{rel}\n{upload}");
        let mut uploads = self.uploads.lock().await;
        // an upload left unfinished for ten minutes is dropped
        let stale: Vec<String> = uploads.iter().filter(|(_, u)| u.at.elapsed() > Duration::from_secs(600)).map(|(k, _)| k.clone()).collect();
        for k in stale {
            if let Some(u) = uploads.remove(&k) {
                self.drop_upload(u).await;
            }
        }
        if !uploads.contains_key(&key) {
            if offset != 0 {
                return fail_at("upload offset mismatch", 409);
            }
            let temp = join(parent(&target), &format!("{UPLOAD_PREFIX}{upload}"));
            let file = self
                .sftp
                .open_with_flags(temp.as_str(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
                .await
                .map_err(sftp_fail)?;
            uploads.insert(key.clone(), Upload { temp, file, offset: 0, total: size, at: Instant::now() });
        }
        let u = uploads.get_mut(&key).expect("present");
        if u.offset != offset || u.total != size {
            return fail_at("upload offset mismatch", 409);
        }
        if offset + data.len() as u64 > size {
            let u = uploads.remove(&key).expect("present");
            self.drop_upload(u).await;
            return fail("upload exceeds total");
        }
        let written = async {
            u.file.seek(std::io::SeekFrom::Start(offset)).await?;
            u.file.write_all(&data).await
        }
        .await;
        if let Err(e) = written {
            let u = uploads.remove(&key).expect("present");
            self.drop_upload(u).await;
            return Err(e.into());
        }
        u.offset += data.len() as u64;
        u.at = Instant::now();
        if u.offset < size {
            return Ok(json!({ "ok": true, "next": u.offset }));
        }
        let u = uploads.remove(&key).expect("present");
        drop(uploads);
        let mut f = u.file;
        f.shutdown().await?;
        drop(f);
        // SFTP's rename won't replace a file: the old one goes first
        if self.sftp.rename(u.temp.as_str(), target.as_str()).await.is_err() {
            let _ = self.sftp.remove_file(target.as_str()).await;
            if let Err(e) = self.sftp.rename(u.temp.as_str(), target.as_str()).await {
                let _ = self.sftp.remove_file(u.temp).await;
                return Err(sftp_fail(e));
            }
        }
        Ok(json!({ "ok": true, "path": rel }))
    }

    /// a file, or a folder and everything in it
    async fn remove_all(&self, p: &str) -> Res<()> {
        let m = self.sftp.symlink_metadata(p).await.map_err(sftp_fail)?;
        if !m.is_dir() {
            return self.sftp.remove_file(p).await.map_err(sftp_fail);
        }
        let mut dirs = vec![p.to_owned()];
        let mut i = 0;
        while i < dirs.len() {
            let d = dirs[i].clone();
            for e in self.sftp.read_dir(d.as_str()).await.map_err(sftp_fail)? {
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let c = join(&d, &name);
                if e.file_type().is_dir() {
                    dirs.push(c);
                } else {
                    self.sftp.remove_file(c).await.map_err(sftp_fail)?;
                }
            }
            i += 1;
        }
        for d in dirs.iter().rev() {
            self.sftp.remove_dir(d.as_str()).await.map_err(sftp_fail)?;
        }
        Ok(())
    }

    pub async fn mutate(&self, id: &str, op: &str, p: &Value) -> Res<Value> {
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let target = self.path(id, &if op == "rename" { s("from") } else { s("path") })?;
        if target.trim_end_matches('/') == self.share(id)?.label.trim_end_matches('/') {
            return fail("can't modify the share itself");
        }
        let shown = if op == "rename" { s("to") } else { s("path") };
        match op {
            "mkdir" => self.mkdirs(&target).await?,
            "rename" => {
                let dest = self.path(id, &s("to"))?;
                if self.sftp.symlink_metadata(dest.as_str()).await.is_ok() {
                    return fail_at("destination exists", 409);
                }
                self.mkdirs(parent(&dest)).await?;
                self.sftp.rename(target, dest).await.map_err(sftp_fail)?;
            }
            "delete" => self.remove_all(&target).await?,
            _ => return fail_at("method not allowed", 405),
        }
        Ok(json!({ "ok": true, "path": shown }))
    }
}

impl Store for RemoteFiles {
    fn read<'a>(&'a self, share: &'a str, rel: &'a str) -> BoxFuture<'a, Res<Value>> {
        RemoteFiles::read(self, share, rel).boxed()
    }
    fn save<'a>(&'a self, share: &'a str, rel: &'a str, text: Option<String>, old: Option<String>, new: Option<String>) -> BoxFuture<'a, Res<Value>> {
        RemoteFiles::save(self, share, rel, text, old, new).boxed()
    }
    fn perms(&self, share: &str) -> Res<String> {
        Ok(self.share(share)?.perms.clone())
    }
    // SFTP gives whole seconds and the host's clock: a file is never taken as still
    // being written, so a clock ahead of this one can't hold a save back for good
    fn stat<'a>(&'a self, share: &'a str, rel: &'a str) -> BoxFuture<'a, Res<(String, bool)>> {
        async move {
            let m = self.sftp.metadata(self.path(share, rel)?).await.map_err(sftp_fail)?;
            Ok((format!("{}:{}", m.mtime.unwrap_or(0), m.size.unwrap_or(0)), false))
        }
        .boxed()
    }
}

// --- one connected host ----------------------------------------------------------------

/// `uname -s` as Sulfur names platforms
pub fn platform_of(uname: &str) -> String {
    match uname.trim() {
        "Linux" => "linux".into(),
        "Darwin" => "darwin".into(),
        "" => "linux".into(),
        other => other.to_lowercase(),
    }
}

/// `uname -m` as the toolchains name architectures
pub fn arch_of(uname: &str) -> String {
    match uname.trim() {
        "x86_64" | "amd64" => "amd64".into(),
        "aarch64" | "arm64" => "arm64".into(),
        other => other.to_lowercase(),
    }
}

/// a host's toolchain probe's lines: `id\tpath\tversion`, and `@dotnet\t<sdk line>`
pub fn parse_tools(out: &str) -> (Vec<Value>, Vec<String>) {
    let mut tools = Vec::new();
    let mut dotnet = Vec::new();
    for line in out.lines() {
        if let Some(sdk) = line.strip_prefix("@dotnet\t") {
            if let Some(v) = sdk.split(' ').next().map(str::trim).filter(|v| !v.is_empty()) {
                dotnet.push(v.to_owned());
            }
            continue;
        }
        let mut it = line.splitn(3, '\t');
        let (Some(id), Some(path), version) = (it.next(), it.next(), it.next()) else { continue };
        let Some((_, name, kind, _)) = KNOWN.iter().find(|k| k.0 == id) else { continue };
        if path.is_empty() {
            continue;
        }
        let version: String = version.unwrap_or("").trim().chars().take(300).collect();
        tools.push(json!({ "id": id, "name": name, "kind": kind, "path": path, "version": version }));
    }
    tools.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    (tools, dotnet)
}

/// the one-line script that finds a Unix host's compilers, build tools and runtimes
pub fn tools_script() -> String {
    let mut s = format!("PATH=\"{UNIX_PATH}\"; export PATH;");
    for (id, _, _, arg) in KNOWN {
        if matches!(*id, "cl" | "msbuild") {
            continue;
        }
        s.push_str(&format!(" p=$(command -v {id} 2>/dev/null) && printf '%s\\t%s\\t%s\\n' '{id}' \"$p\" \"$(\"$p\" {arg} 2>&1 </dev/null | head -n 1)\";"));
    }
    s.push_str(" command -v dotnet >/dev/null 2>&1 && dotnet --list-sdks 2>/dev/null | sed 's/^/@dotnet\\t/'; true");
    s
}

/// a git command for the host: its arguments quoted, prompting off
pub fn git_line(dir: &str, args: &[String]) -> String {
    let mut line = "GIT_TERMINAL_PROMPT=0 LC_ALL=C git".to_owned();
    if !dir.is_empty() {
        line.push_str(&format!(" -C {}", sh(dir)));
    }
    for a in args {
        line.push(' ');
        line.push_str(&sh(a));
    }
    line
}

/// a task's command line on a Unix host: in its folder, with its variables and the
/// toolchains' usual folders on PATH
pub fn task_line(dir: &str, env: &HashMap<String, String>, command: &str) -> String {
    let mut line = format!("cd {} || exit 1; PATH=\"{UNIX_PATH}\"; export PATH; COLORTERM=truecolor TERM_PROGRAM=Sulfur; export COLORTERM TERM_PROGRAM;", sh(dir));
    let mut keys: Vec<&String> = env.keys().filter(|k| !k.is_empty() && !k.starts_with(|c: char| c.is_ascii_digit()) && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).collect();
    keys.sort();
    for k in keys {
        line.push_str(&format!(" {k}={}; export {k};", sh(&env[k])));
    }
    line.push(' ');
    line.push_str(command);
    line
}

pub struct Remote {
    pub spec: Spec,
    handle: Arc<Handle>,
    pub files: Arc<RemoteFiles>,
    pub collab: Arc<Collab>,
    pub terms: Arc<Terminals>,
    /// as /api/state gives a host: platform, shell, home and shares
    pub info: Value,
    os: String,
    arch: String,
    tools: Mutex<Option<(Instant, Value)>>,
}

impl Remote {
    async fn open(spec: Spec, a: &Answers) -> Result<Remote, Refused> {
        let seen = Arc::new(StdMutex::new(None));
        let handler = Client { host: spec.host.clone(), port: spec.port, trust: a.trust.clone(), seen: seen.clone() };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        });
        let started = tokio::time::timeout(Duration::from_secs(20), client::connect(config, (spec.host.as_str(), spec.port), handler)).await;
        let mut handle = match started {
            Err(_) => {
                return Err(Fail::new(format!("{}:{} didn't answer: is this computer on its network (its VPN)?", spec.host, spec.port), 504).into())
            }
            Ok(Err(e)) => {
                if let Some(k) = seen.lock().unwrap().take() {
                    return Err(k.refusal(&spec));
                }
                return Err(Fail::new(format!("{}:{}: {e}", spec.host, spec.port), 502).into());
            }
            Ok(Ok(h)) => h,
        };
        authenticate(&mut handle, &spec, a).await?;
        let handle = Arc::new(handle);
        // what the machine is, and the user's home there
        let probe = exec(&handle, &sh_c("uname -s; uname -m; printf '%s\\n' \"$HOME\""), Duration::from_secs(15)).await.ok();
        let lines: Vec<String> = probe.map(|p| p.out.lines().map(str::to_owned).collect()).unwrap_or_default();
        let line = |i: usize| lines.get(i).cloned().unwrap_or_default();
        let (os, arch) = (platform_of(&line(0)), arch_of(&line(1)));
        let ch = handle.channel_open_session().await.map_err(ssh_fail)?;
        ch.request_subsystem(true, "sftp").await.map_err(ssh_fail)?;
        let sftp = SftpSession::new(ch.into_stream()).await.map_err(sftp_fail)?;
        let mut home = line(2);
        if !home.starts_with('/') {
            home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
        }
        // the folder holding the user's home, and the whole disk, as this computer's are
        let above = parent(&home).to_owned();
        let mut shares = Vec::new();
        if !above.is_empty() {
            shares.push(Share { id: "home".into(), label: above.clone(), root: PathBuf::from(&above), perms: "rwd".into(), home: true });
        }
        shares.push(Share { id: "0".into(), label: "/".into(), root: PathBuf::from("/"), perms: "rwd".into(), home: false });
        let files = Arc::new(RemoteFiles { sftp, shares, uploads: Mutex::new(HashMap::new()) });
        let info = json!({ "platform": os, "shell": "sh", "home": home, "files": { "shares": files.shares } });
        let shells = SshShells { handle: handle.clone(), files: files.clone(), home };
        Ok(Remote {
            spec,
            collab: Collab::watching(files.clone(), Duration::from_millis(1500)),
            terms: Arc::new(Terminals::on(Arc::new(shells))),
            handle,
            files,
            info,
            os,
            arch,
            tools: Mutex::new(None),
        })
    }

    pub fn alive(&self) -> bool {
        !self.handle.is_closed()
    }

    /// a git command of the verbs Sulfur runs, in a folder of the host
    pub async fn git(&self, p: GitRequest) -> Res<Output> {
        let (args, slow) = processes::git_args(&p.args)?;
        if !p.dir.is_empty() && !p.dir.starts_with('/') {
            return fail("a full path to the folder");
        }
        exec(&self.handle, &sh_c(&git_line(&p.dir, &args)), processes::git_deadline(slow, p.quiet)).await
    }

    /// the host's compilers, build tools and runtimes; probed again after ten minutes
    pub async fn toolchains(&self, fresh: bool) -> Value {
        let mut cached = self.tools.lock().await;
        if let Some((at, v)) = cached.as_ref() {
            if !fresh && at.elapsed() < Duration::from_secs(600) {
                return v.clone();
            }
        }
        let out = exec(&self.handle, &sh_c(&tools_script()), Duration::from_secs(30)).await.map(|o| o.out).unwrap_or_default();
        let (tools, dotnet) = parse_tools(&out);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let v = json!({
            "host": self.spec.name, "os": self.os, "arch": self.arch, "shell": "sh",
            "tools": tools, "vs": [], "dotnet": dotnet, "at": now,
        });
        *cached = Some((Instant::now(), v.clone()));
        v
    }

    /// a build or run in a terminal of its own on the host; the socket ends with its exit code
    pub async fn task(&self, ws: &Ws, task: Option<processes::Task>) -> Res<Arc<dyn Proc>> {
        let Some(task) = task.filter(|t| !t.command.trim().is_empty() && t.dir.starts_with('/')) else {
            return fail("a task needs a command and full directory");
        };
        if format!("{}{}", task.command, task.dir).contains(['\0', '\r', '\n']) {
            return fail("a command is one line");
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<Bytes>();
        let line = sh_c(&task_line(&task.dir, &task.env, &task.command));
        let (p, exited) = channel_proc(&self.handle, &line, task.cols as u16, task.rows as u16, tx).await?;
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
        Ok(p)
    }

    /// its open files saved, its terminals ended, then the connection
    async fn close(&self) {
        if self.alive() {
            self.collab.flush().await;
        }
        self.terms.dispose();
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

// --- the saved hosts --------------------------------------------------------------------

/// the saved SSH hosts and the ones connected
#[derive(Default)]
pub struct SshHosts {
    specs: StdMutex<Vec<Spec>>,
    live: Mutex<HashMap<String, Arc<Remote>>>,
    /// a password or passphrase typed, in memory only: kept while the host is
    /// connected (to connect again after a drop), after that only if asked
    secrets: StdMutex<HashMap<String, (Answers, bool)>>,
    /// the hosts connected this run, and when a lost one was last tried again
    wanted: StdMutex<HashMap<String, Option<Instant>>>,
    connecting: Mutex<()>,
}

impl SshHosts {
    /// the hosts saved in the app's settings (its "ssh" list)
    pub fn new(cfg: &Value) -> SshHosts {
        let specs: Vec<Spec> = serde_json::from_value(cfg["ssh"].clone()).unwrap_or_default();
        SshHosts { specs: StdMutex::new(specs), ..Default::default() }
    }

    pub fn specs(&self) -> Vec<Spec> {
        self.specs.lock().unwrap().clone()
    }

    pub fn find(&self, name: &str) -> Option<Spec> {
        self.specs.lock().unwrap().iter().find(|s| s.name == name).cloned()
    }

    fn host_json(spec: &Spec, remote: Option<&Arc<Remote>>) -> Value {
        json!({
            "name": spec.name, "host": spec.host, "port": spec.port, "user": spec.user, "key": spec.key,
            "connected": remote.is_some(), "info": remote.map(|r| r.info.clone()),
        })
    }

    /// the provider as the page takes it: its kind and caps, and every saved host
    pub async fn info(&self) -> Value {
        let live = self.live.lock().await;
        let hosts: Vec<Value> = self.specs().iter().map(|s| Self::host_json(s, live.get(&s.name).filter(|r| r.alive()))).collect();
        let mut v = mesh::mesh_info("ssh");
        v["hosts"] = json!(hosts);
        v
    }

    /// a host saved from its address; `taken` are the names other hosts already go by
    pub fn add(&self, address: &str, key: &str, name: &str, default_user: &str, taken: &[String]) -> Res<(Value, String)> {
        let t = parse_target(address, default_user)?;
        if key.contains('\0') {
            return fail("invalid key path");
        }
        let mut specs = self.specs.lock().unwrap();
        if let Some(s) = specs.iter().find(|s| s.host.eq_ignore_ascii_case(&t.host) && s.port == t.port && s.user == t.user) {
            return Ok((Self::host_json(s, None), t.path));
        }
        let mut all: Vec<String> = specs.iter().map(|s| s.name.clone()).collect();
        all.extend(taken.iter().cloned());
        let name = if name.is_empty() { name_for(&t.host, &all) } else { name.to_owned() };
        if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') || name.is_empty() || all.contains(&name) {
            return fail(format!("{name} is taken, or isn't lowercase letters, digits and dashes"));
        }
        let spec = Spec { name, host: t.host, port: t.port, user: t.user, key: key.trim().to_owned() };
        specs.push(spec.clone());
        Ok((Self::host_json(&spec, None), t.path))
    }

    /// a host connected: already, or now with what the user typed (kept in memory
    /// only, past a disconnect only when `remember`)
    pub async fn connect(&self, name: &str, mut answers: Answers, remember: bool) -> Result<Value, Refused> {
        if let Some(r) = self.live.lock().await.get(name).filter(|r| r.alive()).cloned() {
            return Ok(Self::host_json(&r.spec, Some(&r)));
        }
        if let Some((kept, _)) = self.secrets.lock().unwrap().get(name) {
            answers.password = answers.password.or_else(|| kept.password.clone());
            answers.passphrase = answers.passphrase.or_else(|| kept.passphrase.clone());
        }
        let r = self.connect_with(name, &answers).await?;
        if answers.password.is_some() || answers.passphrase.is_some() {
            let keep = Answers { trust: None, ..answers };
            self.secrets.lock().unwrap().insert(name.to_owned(), (keep, remember));
        }
        self.wanted.lock().unwrap().insert(name.to_owned(), None);
        Ok(Self::host_json(&r.spec, Some(&r)))
    }

    async fn connect_with(&self, name: &str, answers: &Answers) -> Result<Arc<Remote>, Refused> {
        let _one = self.connecting.lock().await;
        let spec = self.find(name).ok_or_else(|| Fail::new(format!("no SSH host named {name}"), 404))?;
        let remote = Arc::new(Remote::open(spec, answers).await?);
        let old = self.live.lock().await.insert(name.to_owned(), remote.clone());
        if let Some(old) = old {
            old.close().await;
        }
        Ok(remote)
    }

    /// a connected host, or one connected this run and lost, connected again
    /// quietly (at most every ten seconds, so a server's auth limits aren't tripped)
    pub async fn get(&self, name: &str) -> Res<Arc<Remote>> {
        if let Some(r) = self.live.lock().await.get(name).filter(|r| r.alive()).cloned() {
            return Ok(r);
        }
        let gone = || Fail::new(format!("{name} isn't connected: connect to it again (Remote: Connect to SSH Host…)"), 503);
        {
            let mut wanted = self.wanted.lock().unwrap();
            let Some(at) = wanted.get_mut(name) else { return Err(gone()) };
            if at.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
                return Err(gone());
            }
            *at = Some(Instant::now());
        }
        let answers = self.secrets.lock().unwrap().get(name).map(|(a, _)| a.clone()).unwrap_or_default();
        self.connect_with(name, &answers).await.map_err(|_| gone())
    }

    pub async fn disconnect(&self, name: &str) {
        self.wanted.lock().unwrap().remove(name);
        {
            let mut secrets = self.secrets.lock().unwrap();
            if secrets.get(name).is_some_and(|(_, remember)| !remember) {
                secrets.remove(name);
            }
        }
        let gone = self.live.lock().await.remove(name);
        if let Some(r) = gone {
            r.close().await;
        }
    }

    /// a saved host forgotten, its connection and anything typed for it with it
    pub async fn forget(&self, name: &str) -> bool {
        self.disconnect(name).await;
        self.secrets.lock().unwrap().remove(name);
        let mut specs = self.specs.lock().unwrap();
        let had = specs.len();
        specs.retain(|s| s.name != name);
        specs.len() != had
    }

    pub async fn dispose(&self) {
        let all: Vec<Arc<Remote>> = self.live.lock().await.drain().map(|(_, r)| r).collect();
        for r in all {
            r.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_as_ssh_and_scp_write_them() {
        let t = |s: &str| parse_target(s, "me").unwrap();
        assert_eq!(t("user@172.18.220.63"), Target { user: "user".into(), host: "172.18.220.63".into(), port: 22, path: "".into() });
        assert_eq!(t("user@172.18.220.63:/usr/arconic/ccm").path, "/usr/arconic/ccm");
        assert_eq!(t("box.example.com").user, "me");
        assert_eq!(t("u@box:2222").port, 2222);
        assert_eq!(t("ssh://u@box:2200/srv/code/").port, 2200);
        assert_eq!(t("ssh://u@box:2200/srv/code/").path, "/srv/code");
        assert_eq!(t("u@[fe80::1]:2222").host, "fe80::1");
        assert_eq!(t("u@[fe80::1]:2222").port, 2222);
        assert_eq!(t("u@box:~/src").path, "~/src");
        for bad in ["", "u@", "@box", "u@box:notaport", "u@-oProxyCommand=x", "u@bo x", "u;rm@box", "u@box:0"] {
            assert!(parse_target(bad, "me").is_err(), "{bad} refused");
        }
    }

    #[test]
    fn host_names_stay_api_names_and_unique() {
        assert_eq!(name_for("172.18.220.63", &[]), "172-18-220-63");
        assert_eq!(name_for("CCM.arconic.com", &[]), "ccm");
        assert_eq!(name_for("ccm", &["ccm".into(), "ccm-2".into()]), "ccm-3");
        assert_eq!(name_for("fe80::1", &[]), "fe80-1");
        assert_eq!(name_for("...", &[]), "ssh-host");
    }

    #[test]
    fn remote_paths_stay_inside_their_share() {
        assert_eq!(remote_path("/home", "rpm/src").unwrap(), "/home/rpm/src");
        assert_eq!(remote_path("/", "usr/arconic/ccm").unwrap(), "/usr/arconic/ccm");
        assert_eq!(remote_path("/", "").unwrap(), "/");
        assert_eq!(remote_path("/home", "./a//b/").unwrap(), "/home/a/b");
        assert!(remote_path("/home", "rpm/../../etc").is_err());
        assert!(remote_path("/home", "a\\b").is_err());
        assert_eq!(parent("/home/rpm"), "/home");
        assert_eq!(parent("/home"), "/");
        assert_eq!(join("/", "usr"), "/usr");
        assert_eq!(join("/usr", "lib"), "/usr/lib");
    }

    #[test]
    fn commands_reach_the_host_quoted() {
        assert_eq!(sh("it's"), r"'it'\''s'");
        assert_eq!(sh_c("echo 'a'"), r"sh -c 'echo '\''a'\'''");
        assert_eq!(
            git_line("/usr/arconic/ccm", &["commit".into(), "-m".into(), "fix: it's $HOME".into()]),
            "GIT_TERMINAL_PROMPT=0 LC_ALL=C git -C '/usr/arconic/ccm' 'commit' '-m' 'fix: it'\\''s $HOME'"
        );
        let env = HashMap::from([("CC".to_owned(), "clang".to_owned()), ("bad name".to_owned(), "x".to_owned()), ("1X".to_owned(), "y".to_owned())]);
        let line = task_line("/srv/my app", &env, "make -j8");
        assert!(line.starts_with("cd '/srv/my app' || exit 1;"));
        assert!(line.contains(" CC='clang'; export CC;"));
        assert!(!line.contains("bad name") && !line.contains("1X"));
        assert!(line.ends_with(" make -j8"));
    }

    #[test]
    fn toolchains_read_from_the_probe() {
        let script = tools_script();
        assert!(script.contains("command -v gcc") && !script.contains("command -v cl ") && !script.contains("msbuild"));
        let (tools, dotnet) = parse_tools("gcc\t/usr/bin/gcc\tgcc (GCC) 13.2.0\ngit\t/usr/bin/git\tgit version 2.43.0\nnope\t/x\ty\nmake\t\t\n@dotnet\t8.0.100 [/usr/share/dotnet/sdk]\n");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["id"], "gcc");
        assert_eq!(tools[0]["kind"], "compiler");
        assert_eq!(tools[1]["version"], "git version 2.43.0");
        assert_eq!(dotnet, vec!["8.0.100"]);
        assert_eq!(platform_of("Linux\n"), "linux");
        assert_eq!(platform_of("FreeBSD"), "freebsd");
        assert_eq!(arch_of("x86_64"), "amd64");
        assert_eq!(arch_of("aarch64"), "arm64");
    }

    #[test]
    fn hosts_are_saved_once_and_named_apart_from_this_computer() {
        let hosts = SshHosts::new(&json!({ "ssh": [{ "name": "ccm", "host": "ccm.example.com", "user": "u" }] }));
        assert_eq!(hosts.find("ccm").unwrap().port, 22, "a saved host without a port takes ssh's");
        let (added, path) = hosts.add("user@172.18.220.63:/usr/arconic/ccm", "", "", "me", &["this-pc".into()]).unwrap();
        assert_eq!(added["name"], "172-18-220-63");
        assert_eq!(path, "/usr/arconic/ccm");
        let (again, _) = hosts.add("user@172.18.220.63", "", "", "me", &[]).unwrap();
        assert_eq!(again["name"], "172-18-220-63", "the same login isn't saved twice");
        let (other, _) = hosts.add("ccm.example.org", "~/.ssh/work", "", "me", &[]).unwrap();
        assert_eq!(other["name"], "ccm-2");
        assert!(hosts.add("x@box", "", "this-pc", "me", &["this-pc".into()]).is_err(), "a name already in use");
        assert!(hosts.add("x@box", "", "Bad Name", "me", &[]).is_err());
        assert_eq!(hosts.specs().len(), 3);
        assert_eq!(key_path("~/.ssh/work"), home_dir().join(".ssh/work"));
    }

    #[tokio::test]
    async fn a_host_never_connected_is_never_dialed_quietly() {
        let hosts = SshHosts::new(&json!({ "ssh": [{ "name": "ccm", "host": "192.0.2.1", "user": "u" }] }));
        let e = hosts.get("ccm").await.err().unwrap();
        assert_eq!(e.status, 503);
        assert!(hosts.forget("ccm").await);
        assert!(hosts.find("ccm").is_none());
        let info = hosts.info().await;
        assert_eq!(info["kind"], "ssh");
        assert_eq!(info["hosts"], json!([]));
    }

    #[test]
    fn a_refusal_tells_the_page_what_to_ask() {
        let (status, body) = Refused::Need { need: "trust", message: "new".into(), fingerprint: "SHA256:x".into() }.answer();
        assert_eq!(status, 401);
        assert_eq!(body["need"], "trust");
        assert_eq!(body["fingerprint"], "SHA256:x");
        let spec = Spec { name: "b".into(), host: "box".into(), port: 22, user: "u".into(), key: "".into() };
        let changed = KeySeen { fingerprint: "SHA256:y".into(), changed: Some(7) }.refusal(&spec);
        assert!(matches!(changed, Refused::Fail(ref f) if f.status == 409 && f.message.contains("line 7")));
        assert!(matches!(KeySeen { fingerprint: "SHA256:y".into(), changed: None }.refusal(&spec), Refused::Need { need: "trust", .. }));
        assert!(takes_passwords(&None));
        assert!(takes_passwords(&Some("MethodSet([Password, PublicKey])".into())));
        assert!(!takes_passwords(&Some("MethodSet([PublicKey])".into())));
    }
}
