//! One live session per open file: every page editing it shares the text,
//! edits rebased in UTF-16 as the page counts them, saved soon after typing
//! stops, and a change on disk taken in, or held as a conflict while the
//! editor has unsaved work.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use futures_util::{future::BoxFuture, FutureExt};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{
    files::{mtime_ms, Files},
    json16::{self, J},
    ot::{self, Op},
    util::{fail, fail_at, Fail, Res, MAX_TEXT},
    ws::Ws,
};

const HISTORY: usize = 2000;

/// where a session's file lives: this computer's disk, or an SSH host's over SFTP
pub trait Store: Send + Sync + 'static {
    /// the file as the files API reads it: its text, or binary or tooBig
    fn read<'a>(&'a self, share: &'a str, rel: &'a str) -> BoxFuture<'a, Res<Value>>;
    /// a whole text, or one unique `old` replaced by `new`
    fn save<'a>(&'a self, share: &'a str, rel: &'a str, text: Option<String>, old: Option<String>, new: Option<String>) -> BoxFuture<'a, Res<Value>>;
    fn perms(&self, share: &str) -> Res<String>;
    /// the file's signature as it is now (any change to it changes this), and
    /// whether it was written so lately it may still be being written
    fn stat<'a>(&'a self, share: &'a str, rel: &'a str) -> BoxFuture<'a, Res<(String, bool)>>;
}

impl Store for Files {
    fn read<'a>(&'a self, share: &'a str, rel: &'a str) -> BoxFuture<'a, Res<Value>> {
        Files::read(self, share, rel).boxed()
    }
    fn save<'a>(&'a self, share: &'a str, rel: &'a str, text: Option<String>, old: Option<String>, new: Option<String>) -> BoxFuture<'a, Res<Value>> {
        Files::save(self, share, rel, text, old, new).boxed()
    }
    fn perms(&self, share: &str) -> Res<String> {
        Ok(self.share(share)?.perms.clone())
    }
    fn stat<'a>(&'a self, share: &'a str, rel: &'a str) -> BoxFuture<'a, Res<(String, bool)>> {
        async move {
            let path = self.resolve(share, rel, false).await?;
            let m = tokio::fs::metadata(&path).await?;
            #[cfg(unix)]
            let ino = std::os::unix::fs::MetadataExt::ino(&m);
            #[cfg(not(unix))]
            let ino = 0u64;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            Ok((format!("{ino}:{}:{}", mtime_ms(&m), m.len()), now - mtime_ms(&m) < 150.0))
        }
        .boxed()
    }
}

struct Client {
    id: u64,
    ws: Option<Ws>,
    name: String,
    color: String,
    pos: usize,
    agent: bool,
}

pub struct Session {
    key: String,
    share: String,
    rel: String,
    st: Mutex<State>,
}

struct State {
    text: Vec<u16>,
    crlf: bool,
    v: u64,
    saved: u64,
    history: VecDeque<Vec<Op>>,
    clients: Vec<Client>,
    disk_text: Vec<u16>,
    disk_pending: Vec<u16>,
    disk_problem: String,
    conflict: bool,
    revision: u64,
    disk_signature: String,
    eol_pending: bool,
    dirty_at: Option<Instant>,
    timer: u64,
    idle: u64,
    checking: bool,
}

pub struct Collab {
    files: Arc<dyn Store>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    seq: AtomicU64,
}

fn u16s(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn lf16(text: &str) -> Vec<u16> {
    u16s(&crate::util::lf(text))
}

fn find16(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() || hay.len() - from < needle.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

impl State {
    fn people(&self) -> J {
        J::Arr(
            self.clients
                .iter()
                .filter(|c| !c.name.is_empty())
                .map(|c| {
                    let mut f = vec![
                        ("id", J::from(c.id)),
                        ("name", J::from(c.name.as_str())),
                        ("color", J::from(c.color.as_str())),
                        ("pos", J::from(c.pos)),
                    ];
                    if c.agent {
                        f.push(("agent", J::Bool(true)));
                    }
                    J::obj(f)
                })
                .collect(),
        )
    }
    fn all(&self, msg: &J) {
        let data = msg.to_json();
        for c in &self.clients {
            if let Some(ws) = &c.ws {
                ws.text(data.clone());
            }
        }
    }
    fn all_people(&self) {
        self.all(&J::obj(vec![("type", "people".into()), ("people", self.people())]));
    }
    fn disk_message(&self) -> J {
        J::obj(vec![
            ("type", "disk".into()),
            ("conflict", self.conflict.into()),
            ("text", J::Str(self.disk_pending.clone())),
            ("problem", self.disk_problem.as_str().into()),
            ("revision", self.revision.into()),
        ])
    }
    fn eol(&self) -> &'static str {
        if self.crlf {
            "\r\n"
        } else {
            "\n"
        }
    }
}

impl Collab {
    pub fn new(files: Arc<dyn Store>) -> Arc<Collab> {
        Collab::watching(files, Duration::from_millis(300))
    }

    /// sessions whose files are looked at every `every` for changes made outside them
    pub fn watching(files: Arc<dyn Store>, every: Duration) -> Arc<Collab> {
        let c = Arc::new(Collab { files, sessions: Mutex::new(HashMap::new()), seq: AtomicU64::new(0) });
        // the disk looked at for every file someone has open
        let weak = Arc::downgrade(&c);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let Some(c) = weak.upgrade() else { break };
                c.check_disk().await;
            }
        });
        c
    }

    pub async fn attach(self: &Arc<Self>, ws: &Ws, share: &str, rel: &str) -> Res<(Arc<Session>, u64)> {
        let key = format!("{share}\n{rel}");
        let s = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(&key) {
                Some(s) => s.clone(),
                None => {
                    let file = self.files.read(share, rel).await?;
                    if file.get("binary").is_some() {
                        return fail_at("a binary file, not text", 415);
                    }
                    if file.get("tooBig").is_some() {
                        return fail_at("over 16MB, too big to edit here", 413);
                    }
                    let raw = file["text"].as_str().unwrap_or("");
                    let text = lf16(raw);
                    let s = Arc::new(Session {
                        key: key.clone(),
                        share: share.to_owned(),
                        rel: rel.to_owned(),
                        st: Mutex::new(State {
                            text: text.clone(),
                            crlf: raw.contains("\r\n"),
                            v: 0,
                            saved: 0,
                            history: VecDeque::new(),
                            clients: Vec::new(),
                            disk_text: text,
                            disk_pending: Vec::new(),
                            disk_problem: String::new(),
                            conflict: false,
                            revision: 0,
                            disk_signature: String::new(),
                            eol_pending: false,
                            dirty_at: None,
                            timer: 0,
                            idle: 0,
                            checking: false,
                        }),
                    });
                    sessions.insert(key, s.clone());
                    s
                }
            }
        };
        let perms = self.files.perms(share)?;
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut st = s.st.lock().await;
        st.idle += 1;
        st.clients.push(Client { id, ws: Some(ws.clone()), name: String::new(), color: String::new(), pos: 0, agent: false });
        ws.text(
            J::obj(vec![
                ("type", "init".into()),
                ("text", J::Str(st.text.clone())),
                ("v", st.v.into()),
                ("saved", st.saved.into()),
                ("eol", st.eol().into()),
                ("people", st.people()),
                ("you", id.into()),
                ("perms", perms.as_str().into()),
            ])
            .to_json(),
        );
        if st.conflict {
            ws.text(st.disk_message().to_json());
        }
        drop(st);
        Ok((s, id))
    }

    fn commit(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, ops: Vec<Op>, id: J, by: u64) {
        st.text = ot::apply(&st.text, &ops);
        st.v += 1;
        for c in st.clients.iter_mut() {
            if c.id != by {
                c.pos = ot::map(&ops, c.pos);
            }
        }
        let (name, agent) = st
            .clients
            .iter()
            .find(|c| c.id == by)
            .map(|c| (c.name.clone(), c.agent))
            .unwrap_or_else(|| (if by == 0 { "disk".into() } else { String::new() }, false));
        let mut f = vec![("type", J::from("op")), ("v", st.v.into()), ("ops", ot::ops_j(&ops))];
        if id != J::Null {
            f.push(("id", id));
        }
        f.extend([("by", J::from(name)), ("agent", agent.into()), ("agentEdit", by.into())]);
        st.history.push_back(ops);
        if st.history.len() > HISTORY {
            st.history.pop_front();
        }
        st.all(&J::obj(f));
        self.save_soon(s, st);
    }

    /// a page's message, after any before it on the same file
    pub async fn message(self: &Arc<Self>, s: &Arc<Session>, me: u64, ws: &Ws, text: &str) -> Res<()> {
        let msg = json16::parse(text).map_err(|_| Fail::new("invalid json", 400))?;
        let mut st = s.st.lock().await;
        let kind = msg.string("type").unwrap_or_default();
        match kind.as_str() {
            "join" => {
                let name: String = msg.string("name").unwrap_or_else(|| "anon".into()).chars().take(32).collect();
                let color: String = msg.string("color").unwrap_or_default().chars().take(16).collect();
                if let Some(c) = st.clients.iter_mut().find(|c| c.id == me) {
                    c.name = if name.is_empty() { "anon".into() } else { name };
                    c.color = color;
                }
                st.all_people();
            }
            "cursor" => {
                let len = st.text.len();
                let pos = msg.num("pos").filter(|n| n.is_finite()).unwrap_or(0.0).max(0.0) as usize;
                if let Some(c) = st.clients.iter_mut().find(|c| c.id == me) {
                    c.pos = pos.min(len);
                }
                st.all_people();
            }
            "save" => {
                let by = st.clients.iter().find(|c| c.id == me).map(|c| c.name.clone()).unwrap_or_default();
                self.save_now(s, &mut st, &by, false).await?;
            }
            "eol" => {
                let eol = msg.string("eol").unwrap_or_default();
                st.crlf = eol == "\r\n" || eol == "CRLF";
                st.eol_pending = true;
                let m = J::obj(vec![("type", "eol".into()), ("eol", st.eol().into())]);
                st.all(&m);
                let by = st.clients.iter().find(|c| c.id == me).map(|c| c.name.clone()).unwrap_or_default();
                self.save_now(s, &mut st, &by, false).await?;
            }
            "resolveDisk" => {
                if !self.observe(s, &mut st, true).await {
                    return fail_at("file is changing on disk; saving will retry", 409);
                }
                if !st.conflict {
                    return Ok(());
                }
                if msg.num("revision") != Some(st.revision as f64) {
                    ws.text(st.disk_message().to_json());
                    return Ok(());
                }
                match msg.string("choice").as_deref() {
                    Some("reload") => {
                        let pending = st.disk_pending.clone();
                        self.apply_disk(s, &mut st, pending);
                    }
                    Some("overwrite" | "keep") => {
                        let by = st.clients.iter().find(|c| c.id == me).map(|c| c.name.clone()).unwrap_or_default();
                        self.save_now(s, &mut st, &by, true).await?;
                    }
                    _ => {}
                }
            }
            "op" => {
                let oldest = st.v - st.history.len() as u64;
                let resync = |st: &State| {
                    let mut f = vec![
                        ("type", J::from("resync")),
                        ("text", J::Str(st.text.clone())),
                        ("v", st.v.into()),
                        ("saved", st.saved.into()),
                    ];
                    if let Some(id) = msg.get("id") {
                        f.push(("id", id.clone()));
                    }
                    ws.text(J::obj(f).to_json());
                };
                let base = msg.num("base").filter(|b| b.fract() == 0.0 && *b >= 0.0).map(|b| b as u64);
                let ops = msg.get("ops").and_then(ot::parse_ops);
                let (Some(base), Some(mut ops)) = (base, ops) else {
                    resync(&st);
                    return Ok(());
                };
                if base < oldest || base > st.v {
                    resync(&st);
                    return Ok(());
                }
                let mut ok = true;
                for h in st.history.iter().skip((base - oldest) as usize) {
                    match ot::transform(&ops, h) {
                        Ok((a, _)) => ops = a,
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    }
                }
                // (the length worked out from the ops: the text itself is made once, on commit)
                if !ok || !ot::valid(&ops, st.text.len(), MAX_TEXT) || ot::applied_len(st.text.len(), &ops) > MAX_TEXT {
                    resync(&st);
                    return Ok(());
                }
                let id = msg.get("id").cloned().unwrap_or(J::Null);
                self.commit(s, &mut st, ops, id, me);
            }
            _ => {}
        }
        Ok(())
    }

    fn save_soon(self: &Arc<Self>, s: &Arc<Session>, st: &mut State) {
        if st.conflict {
            return;
        }
        st.timer += 1;
        let generation = st.timer;
        let dirty = *st.dirty_at.get_or_insert_with(Instant::now);
        let wait = Duration::from_millis(1500).min((dirty + Duration::from_secs(10)).saturating_duration_since(Instant::now()));
        let (me, s) = (self.clone(), s.clone());
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let mut st = s.st.lock().await;
            if st.timer != generation {
                return;
            }
            if let Err(e) = me.save_now(&s, &mut st, "", false).await {
                st.all(&J::obj(vec![("type", "error".into()), ("error", e.message.as_str().into())]));
            }
        });
    }

    async fn save_now(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, by: &str, reviewed: bool) -> Res<Value> {
        st.timer += 1;
        st.dirty_at = None;
        if st.saved == st.v && !st.eol_pending && !st.conflict {
            return Ok(json!({ "path": s.rel }));
        }
        let reviewed_revision = st.revision;
        if !self.observe(s, st, true).await {
            self.save_soon(s, st);
            return fail_at("file is changing on disk; saving will retry", 409);
        }
        if reviewed && reviewed_revision != st.revision {
            return fail_at("file changed again on disk; review both versions before saving", 409);
        }
        if st.conflict && !reviewed {
            return fail_at("file changed on disk; resolve the conflict before saving", 409);
        }
        let text = st.text.clone();
        let version = st.v;
        let mut out = String::from_utf16_lossy(&text);
        if st.crlf {
            out = out.replace('\n', "\r\n");
        }
        let saved = self.files.save(&s.share, &s.rel, Some(out), None, None).await?;
        st.disk_text = text;
        st.saved = version;
        st.conflict = false;
        st.disk_pending.clear();
        st.disk_problem.clear();
        st.disk_signature.clear();
        st.eol_pending = false;
        st.all(&J::obj(vec![("type", "saved".into()), ("v", version.into()), ("by", by.into())]));
        st.all(&st.disk_message());
        Ok(saved)
    }

    /// a write from outside the page (an agent, a mesh tool): typed into the
    /// open editor where one is, else saved straight to disk
    pub async fn write(self: &Arc<Self>, share: &str, rel: &str, p: &Value) -> Res<Value> {
        let text = p.get("text").and_then(Value::as_str).map(str::to_owned);
        let old = p.get("old").and_then(Value::as_str).map(str::to_owned);
        let new = p.get("new").and_then(Value::as_str).map(str::to_owned);
        let s = self.sessions.lock().await.get(&format!("{share}\n{rel}")).cloned();
        let Some(s) = s else {
            return self.files.save(share, rel, text, old, new).await;
        };
        let by = p.get("by").and_then(|b| b.get("name")).and_then(Value::as_str).unwrap_or("phosphorus");
        let color = p.get("by").and_then(|b| b.get("color")).and_then(Value::as_str).unwrap_or("");
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let typed: Vec<u16>;
        {
            let mut st = s.st.lock().await;
            if st.clients.is_empty() {
                drop(st);
                return self.files.save(share, rel, text, old, new).await;
            }
            let target = match (old, new) {
                (Some(old), Some(new)) => {
                    let old = lf16(&old);
                    let Some(at) = find16(&st.text, &old, 0).filter(|_| !old.is_empty()) else {
                        return fail_at("old text not found", 409);
                    };
                    if find16(&st.text, &old, at + 1).is_some() {
                        return fail_at("old text found more than once, give more of it", 409);
                    }
                    let mut t = st.text[..at].to_vec();
                    t.extend(lf16(&new));
                    t.extend_from_slice(&st.text[at + old.len()..]);
                    t
                }
                _ => match text {
                    Some(t) => lf16(&t),
                    None => return fail("text, or old and new"),
                },
            };
            if target.len() > MAX_TEXT {
                return fail_at("over 16MB", 413);
            }
            let ops = ot::disk_diff(&st.text, &target);
            let (mut at, mut gone) = (0usize, 0usize);
            let mut ins = Vec::new();
            for o in &ops {
                match o {
                    Op::S(s) => ins.extend_from_slice(s),
                    Op::N(n) if *n < 0 => gone += n.unsigned_abs() as usize,
                    Op::N(n) => {
                        if ins.is_empty() && gone == 0 {
                            at += *n as usize;
                        }
                    }
                }
            }
            typed = ins;
            let len = st.text.len();
            st.clients.push(Client {
                id,
                ws: None,
                name: by.chars().take(32).collect(),
                color: color.chars().take(16).collect(),
                pos: at.min(len),
                agent: true,
            });
            st.idle += 1;
            st.all_people();
            if gone > 0 {
                self.put(&s, &mut st, id, gone, &[]);
            }
        }
        let result = async {
            let step = typed.len().div_ceil(24).max(1);
            let mut i = 0;
            while i < typed.len() {
                tokio::time::sleep(Duration::from_millis(40)).await;
                let mut end = (i + step).min(typed.len());
                if end < typed.len() && (0xDC00..=0xDFFF).contains(&typed[end]) {
                    end += 1;
                }
                let mut st = s.st.lock().await;
                self.put(&s, &mut st, id, 0, &typed[i..end]);
                i = end;
            }
            let mut st = s.st.lock().await;
            let name: String = by.chars().take(32).collect();
            let mut out = self.save_now(&s, &mut st, &name, false).await?;
            out["live"] = json!(true);
            out["note"] = json!("typed into the open editor and saved");
            Res::Ok(out)
        }
        .await;
        let s2 = s.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let mut st = s2.st.lock().await;
            st.clients.retain(|c| c.id != id);
            st.all_people();
        });
        result
    }

    fn put(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, by: u64, gone: usize, text: &[u16]) {
        let len = st.text.len();
        let pos = st.clients.iter().find(|c| c.id == by).map(|c| c.pos).unwrap_or(0);
        let at = pos.min(len);
        let gone = gone.min(len - at);
        let mut b = ot::Builder::default();
        b.retain(at as i64);
        b.insert(text);
        b.del(gone as i64);
        b.retain((len - at - gone) as i64);
        if let Some(c) = st.clients.iter_mut().find(|c| c.id == by) {
            c.pos = at + text.len();
        }
        let id = J::text(&format!(
            "agent-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
        ));
        self.commit(s, st, b.ops, id, by);
        st.all_people();
    }

    fn apply_disk(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, text: Vec<u16>) {
        let ops = ot::disk_diff(&st.text, &text);
        self.commit(s, st, ops, J::Null, 0);
        st.timer += 1;
        st.saved = st.v;
        st.disk_text = text;
        st.conflict = false;
        st.disk_pending.clear();
        st.disk_problem.clear();
        st.all(&J::obj(vec![("type", "saved".into()), ("v", st.v.into()), ("by", "disk".into())]));
        st.all(&st.disk_message());
    }

    /// the file on disk compared with the session; false while it's still changing
    async fn observe(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, force: bool) -> bool {
        match self.observe_disk(s, st, force).await {
            Ok(settled) => settled,
            Err(e) => {
                if st.disk_problem != e.message {
                    st.disk_problem = e.message;
                    st.conflict = true;
                    st.revision += 1;
                    st.timer += 1;
                    st.all(&st.disk_message());
                }
                true
            }
        }
    }

    async fn observe_disk(self: &Arc<Self>, s: &Arc<Session>, st: &mut State, force: bool) -> Res<bool> {
        let (sig, changing) = self.files.stat(&s.share, &s.rel).await?;
        if changing {
            return Ok(false);
        }
        if !force && sig == st.disk_signature {
            return Ok(true);
        }
        let file = self.files.read(&s.share, &s.rel).await?;
        if file.get("binary").is_some() || file.get("tooBig").is_some() {
            return Err(Fail::new(
                "The disk file is binary or too large to reload. The editor version has been preserved.",
                400,
            ));
        }
        let (after, _) = self.files.stat(&s.share, &s.rel).await?;
        if after != sig {
            return Ok(false);
        }
        let raw = file["text"].as_str().unwrap_or("");
        let text = lf16(raw);
        st.disk_signature = sig;
        if text == st.disk_text || text == st.text {
            if text == st.text && st.saved != st.v {
                st.saved = st.v;
                st.all(&J::obj(vec![("type", "saved".into()), ("v", st.v.into()), ("by", "disk".into())]));
            }
            if st.conflict {
                st.conflict = false;
                st.disk_pending.clear();
                st.disk_problem.clear();
                st.revision += 1;
                st.all(&st.disk_message());
                if st.saved != st.v {
                    self.save_soon(s, st);
                }
            }
            return Ok(true);
        }
        if st.saved != st.v {
            if st.conflict && st.disk_pending == text && st.disk_problem.is_empty() {
                return Ok(true);
            }
            st.conflict = true;
            st.disk_pending = text;
            st.disk_problem.clear();
            st.revision += 1;
            st.timer += 1;
            st.all(&st.disk_message());
        } else {
            st.crlf = raw.contains("\r\n");
            self.apply_disk(s, st, text);
        }
        Ok(true)
    }

    async fn check_disk(self: &Arc<Self>) {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().await.values().cloned().collect();
        for s in sessions {
            let Ok(mut st) = s.st.try_lock() else { continue };
            if st.clients.is_empty() || st.checking {
                continue;
            }
            st.checking = true;
            drop(st);
            let (me, s) = (self.clone(), s.clone());
            tokio::spawn(async move {
                let mut st = s.st.lock().await;
                me.observe(&s, &mut st, false).await;
                st.checking = false;
            });
        }
    }

    /// a page gone from a file: the session saved and dropped a minute after the last
    pub async fn close(self: &Arc<Self>, s: &Arc<Session>, me: u64) {
        let mut st = s.st.lock().await;
        st.clients.retain(|c| c.id != me);
        st.all_people();
        if !st.clients.is_empty() {
            return;
        }
        st.idle += 1;
        let generation = st.idle;
        drop(st);
        let (c, s) = (self.clone(), s.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut st = s.st.lock().await;
            if st.idle != generation || !st.clients.is_empty() {
                return;
            }
            if c.save_now(&s, &mut st, "", false).await.is_ok() {
                drop(st);
                let mut sessions = c.sessions.lock().await;
                if sessions.get(&s.key).is_some_and(|x| Arc::ptr_eq(x, &s)) {
                    sessions.remove(&s.key);
                }
            }
        });
    }

    /// every unsaved session written before the app exits
    pub async fn flush(self: &Arc<Self>) {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().await.values().cloned().collect();
        for s in sessions {
            let mut st = s.st.lock().await;
            st.timer += 1;
            if st.saved != st.v && !st.conflict {
                let _ = self.save_now(&s, &mut st, "", false).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{Machine, Share};

    async fn fixture() -> (tempfile::TempDir, Arc<Collab>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let files = Files::new(Machine {
            user: "me".into(),
            host: "test".into(),
            platform: "linux".into(),
            shell: "sh".into(),
            shares: vec![Share { id: "0".into(), label: root.to_string_lossy().into(), root, perms: "rwd".into(), home: false }],
        });
        (dir, Collab::new(files))
    }

    fn settle(p: &std::path::Path) {
        let then = std::time::SystemTime::now() - Duration::from_secs(1);
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(then).unwrap();
    }

    async fn text(s: &Arc<Session>) -> String {
        String::from_utf16(&s.st.lock().await.text).unwrap()
    }

    #[tokio::test]
    async fn concurrent_clients_share_one_session_and_rebase_in_utf16() {
        let (dir, c) = fixture().await;
        let file = dir.path().join("a");
        std::fs::write(&file, "a😀b").unwrap();
        settle(&file);
        let (left, right) = (crate::ws::Ws::detached(), crate::ws::Ws::detached());
        let (s1, l) = c.attach(&left, "0", "a").await.unwrap();
        let (s2, r) = c.attach(&right, "0", "a").await.unwrap();
        assert!(Arc::ptr_eq(&s1, &s2));
        c.message(&s1, l, &left, r#"{"type":"op","base":0,"id":"l","ops":[1,"X",3]}"#).await.unwrap();
        c.message(&s1, r, &right, r#"{"type":"op","base":0,"id":"r","ops":[4,"Y"]}"#).await.unwrap();
        assert_eq!(text(&s1).await, "aX😀bY");
        c.message(&s1, l, &left, r#"{"type":"save"}"#).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "aX😀bY");
        // a lone surrogate in one op, its pair in the next
        let v = s1.st.lock().await.v;
        c.message(&s1, l, &left, &format!(r#"{{"type":"op","base":{v},"id":"h","ops":[6,"\ud83d"]}}"#)).await.unwrap();
        c.message(&s1, l, &left, &format!(r#"{{"type":"op","base":{},"id":"t","ops":[7,"\ude03"]}}"#, v + 1)).await.unwrap();
        assert_eq!(text(&s1).await, "aX😀bY😃");
    }

    #[tokio::test]
    async fn agents_type_live_and_a_dirty_editor_never_overwrites_disk() {
        let (dir, c) = fixture().await;
        let file = dir.path().join("a");
        std::fs::write(&file, "abc").unwrap();
        settle(&file);
        let ws = crate::ws::Ws::detached();
        let (s, me) = c.attach(&ws, "0", "a").await.unwrap();
        let out = c.write("0", "a", &json!({ "old": "b", "new": "XYZ", "by": { "name": "Agent" } })).await.unwrap();
        assert_eq!(out["live"], true);
        assert_eq!(text(&s).await, "aXYZc");
        settle(&file);
        let v = s.st.lock().await.v;
        c.message(&s, me, &ws, &format!(r#"{{"type":"op","base":{v},"id":"e","ops":[5,"!"]}}"#)).await.unwrap();
        std::fs::write(&file, "external").unwrap();
        settle(&file);
        let e = c.message(&s, me, &ws, r#"{"type":"save"}"#).await.unwrap_err();
        assert!(e.message.contains("conflict"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "external");
        assert_eq!(text(&s).await, "aXYZc!");
        let revision = s.st.lock().await.revision;
        c.message(&s, me, &ws, &format!(r#"{{"type":"resolveDisk","choice":"reload","revision":{}}}"#, revision - 1)).await.unwrap();
        assert_eq!(text(&s).await, "aXYZc!");
        c.message(&s, me, &ws, &format!(r#"{{"type":"resolveDisk","choice":"reload","revision":{revision}}}"#)).await.unwrap();
        assert_eq!(text(&s).await, "external");
    }
}
