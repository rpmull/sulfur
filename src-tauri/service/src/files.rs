//! This computer's files as a host's files API: the folder holding the user's
//! home and every drive, each request held inside its share.
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::util::{
    contains_ci, text_matches,
    fail, fail_at, glob_match, home_dir, locale_compare, safe_path, skipper, Fail, Res, MAX_TEXT,
};

pub(crate) const LIST_MAX: usize = 5000;
pub(crate) const TREE_MAX: usize = 60000;
pub(crate) const UPLOAD_PREFIX: &str = ".phosphorus-upload-";
pub const UPLOAD_MAX: u64 = 64 << 30;

#[derive(Debug, Clone, Serialize)]
pub struct Share {
    pub id: String,
    pub label: String,
    #[serde(skip)]
    pub root: PathBuf,
    pub perms: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub home: bool,
}

/// this computer as Sulfur sees it: one host, its user's home and its drives
#[derive(Debug, Clone)]
pub struct Machine {
    pub user: String,
    pub host: String,
    pub platform: String,
    pub shell: String,
    pub shares: Vec<Share>,
}

pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    }
}

impl Machine {
    pub fn local() -> Machine {
        let home = home_dir();
        let host = host_name();
        let parent = home.parent().map(Path::to_path_buf).unwrap_or_else(|| home.clone());
        let mut shares = vec![Share {
            id: "home".into(),
            label: parent.to_string_lossy().into_owned(),
            root: parent,
            perms: "rwd".into(),
            home: true,
        }];
        let roots: Vec<String> = if cfg!(windows) {
            (b'A'..=b'Z')
                .map(|d| format!("{}:\\", d as char))
                .filter(|p| Path::new(p).exists())
                .collect()
        } else {
            vec!["/".into()]
        };
        for (i, root) in roots.into_iter().enumerate() {
            shares.push(Share {
                id: i.to_string(),
                label: root.clone(),
                root: PathBuf::from(root),
                perms: "rwd".into(),
                home: false,
            });
        }
        let shell = if cfg!(windows) { "powershell" } else { "sh" };
        Machine {
            user: home
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "me".into()),
            host,
            platform: platform().into(),
            shell: shell.into(),
            shares,
        }
    }

    pub fn info(&self) -> Value {
        json!({
            "platform": self.platform,
            "shell": self.shell,
            "files": { "shares": self.shares },
        })
    }
}

fn host_name() -> String {
    let raw = raw_host_name();
    let first = raw.split('.').next().unwrap_or("").to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in first.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_matches('-').to_owned();
    if out.is_empty() {
        "this-computer".into()
    } else {
        out
    }
}

fn raw_host_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length and gethostname writes within it
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
        std::env::var("HOSTNAME").unwrap_or_default()
    }
    #[cfg(not(unix))]
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub link: bool,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub empty: Option<bool>,
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// a folder's entries, each as its link's target says, by ICU root order
fn entries_at(dir: &Path) -> Res<Vec<Entry>> {
    let mut out = Vec::new();
    for ent in fs::read_dir(dir)? {
        let Ok(ent) = ent else { continue };
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with(UPLOAD_PREFIX) {
            continue;
        }
        let file = ent.path();
        let Ok(info) = fs::symlink_metadata(&file) else { continue };
        let link = info.file_type().is_symlink();
        let target = if link { fs::metadata(&file).ok() } else { Some(info) };
        let dir_ = target.as_ref().is_some_and(fs::Metadata::is_dir);
        let mut e = Entry {
            name,
            dir: dir_,
            link,
            size: target.as_ref().filter(|t| t.is_file()).map(fs::Metadata::len),
            mtime: target.as_ref().map(|t| mtime_ms(t).round() as i64),
            empty: None,
        };
        if dir_ && !link {
            if let Ok(mut rd) = fs::read_dir(&file) {
                e.empty = Some(rd.next().is_none());
            }
        }
        out.push(e);
    }
    out.sort_by(|a, b| locale_compare(&a.name, &b.name));
    Ok(out)
}

struct Upload {
    file: fs::File,
    temp: PathBuf,
    offset: u64,
    total: u64,
    generation: u64,
}

pub struct Files {
    pub machine: Machine,
    uploads: Mutex<HashMap<String, Arc<StdMutex<Option<Upload>>>>>,
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> impl std::future::Future<Output = Res<T>> {
    async move { tokio::task::spawn_blocking(f).await? }
}

impl Files {
    pub fn new(machine: Machine) -> Arc<Files> {
        Arc::new(Files { machine, uploads: Mutex::new(HashMap::new()) })
    }

    pub fn share(&self, id: &str) -> Res<&Share> {
        self.machine
            .shares
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| Fail::new("no such folder here", 404))
    }

    pub async fn resolve(&self, id: &str, rel: &str, write: bool) -> Res<PathBuf> {
        let root = self.share(id)?.root.clone();
        let rel = rel.to_owned();
        blocking(move || safe_path(&root, &rel, write)).await
    }

    pub async fn read(&self, id: &str, rel: &str) -> Res<Value> {
        let p = self.resolve(id, rel, false).await?;
        let rel = rel.to_owned();
        blocking(move || read_file(&p, &rel)).await
    }

    pub async fn entries(&self, id: &str, rel: &str) -> Res<Vec<Entry>> {
        let dir = self.resolve(id, rel, false).await?;
        blocking(move || entries_at(&dir)).await
    }

    pub async fn list(&self, id: &str, rel: &str) -> Res<Value> {
        let mut entries = self.entries(id, rel).await?;
        entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| locale_compare(&a.name, &b.name)));
        let truncated = entries.len() > LIST_MAX;
        entries.truncate(LIST_MAX);
        Ok(json!({ "path": rel, "entries": entries, "truncated": truncated }))
    }

    /// a folder's tree breadth first, `depth` levels down, bounded at 60,000 entries
    pub async fn tree(&self, id: &str, rel: &str, depth: &str, matching: &str, skip: &str) -> Res<Value> {
        let root = self.resolve(id, rel, false).await?;
        let max_depth = depth.trim().parse::<f64>().ok().filter(|d| d.is_finite()).map(|d| d.trunc() as i64).unwrap_or(1);
        let max_depth = max_depth.clamp(1, 8);
        let (rel, matching, skip) = (rel.to_owned(), matching.to_owned(), skip.to_owned());
        blocking(move || {
            let skipped = skipper(&skip);
            let mut entries = Vec::new();
            let mut level = vec![(String::from(rel.as_str()), root)];
            let mut truncated = false;
            let mut lv = 1;
            while lv <= max_depth && !level.is_empty() && !truncated {
                let mut next = Vec::new();
                for (i, (dir, abs)) in level.iter().enumerate() {
                    let children = match entries_at(abs) {
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
                            next.push((p.clone(), abs.join(&e.name)));
                        }
                        if !matching.is_empty() && !glob_match(&matching, &e.name) {
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
        })
        .await
    }

    /// names, or text inside files of up to 1 MiB, under a folder; 200 results at most
    pub async fn search(&self, id: &str, rel: &str, query: &str, content: bool, glob: &str, skip: &str) -> Res<Value> {
        let q = query.trim().to_lowercase();
        if q.is_empty() && glob.is_empty() {
            return fail("a query or a glob");
        }
        let root = self.resolve(id, rel, false).await?;
        let (rel, glob, skip) = (rel.to_owned(), glob.to_owned(), skip.to_owned());
        blocking(move || {
            let skipped = skipper(&skip);
            let mut results = Vec::new();
            let mut scanned = 0usize;
            let mut truncated = false;
            fn walk(
                dir: &str,
                abs: &Path,
                st: &mut (Vec<Value>, usize, bool),
                q: &str,
                content: bool,
                glob: &str,
                skipped: &dyn Fn(&str) -> bool,
            ) {
                let Ok(children) = entries_at(abs) else { return };
                for e in children {
                    if e.dir && skipped(&e.name) {
                        continue;
                    }
                    st.1 += 1;
                    if st.1 > 50000 || st.0.len() >= 200 {
                        st.2 = true;
                        return;
                    }
                    let p = posix_join(dir, &e.name);
                    let file = abs.join(&e.name);
                    if glob.is_empty() || glob_match(glob, &e.name) {
                        if !content && contains_ci(&e.name, q) {
                            st.0.push(json!({ "path": if e.dir { format!("{p}/") } else { p.clone() } }));
                        } else if content && !e.dir && !e.link && e.size.unwrap_or(u64::MAX) <= 1 << 20 {
                            if let Ok(data) = fs::read(&file) {
                                if !data.contains(&0) {
                                    let matches = text_matches(&data, q);
                                    if !matches.is_empty() {
                                        st.0.push(json!({ "path": p, "matches": matches }));
                                    }
                                }
                            }
                        }
                    }
                    if e.dir && !e.link {
                        walk(&p, &file, st, q, content, glob, skipped);
                    }
                    if st.2 {
                        return;
                    }
                }
            }
            let mut st = (std::mem::take(&mut results), scanned, truncated);
            walk(&rel, &root, &mut st, &q, content, &glob, &skipped);
            (results, scanned, truncated) = st;
            let _ = scanned;
            let mut out = json!({ "path": rel, "results": results });
            if truncated {
                out["truncated"] = json!(true);
            }
            Ok(out)
        })
        .await
    }

    /// a whole text, or one unique `old` replaced by `new`
    pub async fn save(&self, id: &str, rel: &str, text: Option<String>, old: Option<String>, new: Option<String>) -> Res<Value> {
        let target = self.resolve(id, rel, true).await?;
        let rel = rel.to_owned();
        blocking(move || {
            let text = match (old, new) {
                (Some(old), Some(new)) => {
                    let current = String::from_utf8_lossy(&fs::read(&target)?).into_owned();
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
            if let Some(dir) = target.parent() {
                fs::create_dir_all(dir)?;
            }
            // the same inode, so its permissions and open editors' handles stay
            fs::write(&target, text.as_bytes())?;
            Ok(json!({ "ok": true, "path": rel, "size": text.len() }))
        })
        .await
    }

    /// a whole body, or one chunk of an upload at its offset; the file appears whole
    pub async fn upload(self: &Arc<Self>, id: &str, rel: &str, body: axum::body::Body, upload: Option<&str>, offset: Option<&str>, total: Option<&str>) -> Res<Value> {
        let target = self.resolve(id, rel, true).await?;
        if let Some(dir) = target.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let Some(upload) = upload.filter(|u| !u.is_empty()) else {
            let data = read_body(body, 64 << 20).await?;
            let len = data.len();
            tokio::fs::write(&target, data).await?;
            return Ok(json!({ "ok": true, "path": rel, "size": len }));
        };
        let size = parse_count(total.unwrap_or(""));
        let offset = parse_count(offset.unwrap_or("0"));
        let valid_id = upload.len() <= 80 && upload.chars().all(|c| c.is_ascii_alphanumeric());
        let (Some(size), Some(offset)) = (size, offset) else { return fail("invalid upload") };
        if !valid_id || size > UPLOAD_MAX {
            return fail("invalid upload");
        }
        let key = format!("{id}\n{rel}\n{upload}");
        let slot = {
            let mut uploads = self.uploads.lock().await;
            match uploads.get(&key) {
                Some(s) => s.clone(),
                None => {
                    if offset != 0 {
                        return fail_at("upload offset mismatch", 409);
                    }
                    let temp = target.with_file_name(format!("{UPLOAD_PREFIX}{upload}"));
                    let mut options = fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                    let file = options.open(&temp)?;
                    let slot = Arc::new(StdMutex::new(Some(Upload { file, temp, offset: 0, total: size, generation: 0 })));
                    uploads.insert(key.clone(), slot.clone());
                    slot
                }
            }
        };
        {
            let guard = slot.lock().unwrap();
            match guard.as_ref() {
                Some(u) if u.offset == offset && u.total == size => {}
                _ => return fail_at("upload offset mismatch", 409),
            }
        }
        let data = read_body(body, 8 << 20).await?;
        let files = self.clone();
        let rel_ = rel.to_owned();
        let key_ = key.clone();
        let slot_ = slot.clone();
        let done = blocking(move || {
            let mut guard = slot_.lock().unwrap();
            let Some(u) = guard.as_mut() else { return fail_at("upload offset mismatch", 409) };
            if u.offset != offset {
                return fail_at("upload offset mismatch", 409);
            }
            if offset + data.len() as u64 > size {
                let gone = guard.take();
                drop_upload(gone);
                return fail("upload exceeds total");
            }
            let written = (|| -> std::io::Result<()> {
                use std::io::{Seek, SeekFrom};
                u.file.seek(SeekFrom::Start(offset))?;
                u.file.write_all(&data)?;
                Ok(())
            })();
            if let Err(e) = written {
                let gone = guard.take();
                drop_upload(gone);
                return Err(e.into());
            }
            u.offset += data.len() as u64;
            u.generation += 1;
            if u.offset == size {
                let u = guard.take().expect("present");
                u.file.sync_all().ok();
                drop(u.file);
                if let Err(e) = fs::rename(&u.temp, &target) {
                    let _ = fs::remove_file(&u.temp);
                    return Err(e.into());
                }
                return Ok((true, size, 0));
            }
            Ok((false, u.offset, u.generation))
        })
        .await;
        match done {
            Ok((true, _, _)) => {
                files.uploads.lock().await.remove(&key_);
                Ok(json!({ "ok": true, "path": rel_ }))
            }
            Ok((false, next, generation)) => {
                // an upload left unfinished for ten minutes is dropped
                let files = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(600)).await;
                    let mut uploads = files.uploads.lock().await;
                    let stale = uploads.get(&key).is_some_and(|s| {
                        s.lock().unwrap().as_ref().is_none_or(|u| u.generation == generation)
                    });
                    if stale {
                        if let Some(s) = uploads.remove(&key) {
                            drop_upload(s.lock().unwrap().take());
                        }
                    }
                });
                Ok(json!({ "ok": true, "next": next }))
            }
            Err(e) => {
                files.uploads.lock().await.remove(&key_);
                Err(e)
            }
        }
    }

    pub async fn dispose(&self) {
        let mut uploads = self.uploads.lock().await;
        for (_, slot) in uploads.drain() {
            drop_upload(slot.lock().unwrap().take());
        }
    }

    pub async fn mutate(&self, id: &str, op: &str, p: &Value) -> Res<Value> {
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let target = self.resolve(id, &if op == "rename" { s("from") } else { s("path") }, true).await?;
        let root = self.share(id)?.root.clone();
        if crate::util::normalize(&target) == crate::util::normalize(&root) {
            return fail("can't modify the share itself");
        }
        let dest = if op == "rename" { Some(self.resolve(id, &s("to"), true).await?) } else { None };
        let shown = if op == "rename" { s("to") } else { s("path") };
        let op = op.to_owned();
        blocking(move || {
            match op.as_str() {
                "mkdir" => fs::create_dir_all(&target)?,
                "rename" => {
                    let dest = dest.expect("rename has a destination");
                    if fs::symlink_metadata(&dest).is_ok() {
                        return fail_at("destination exists", 409);
                    }
                    // a first extension moves into an extensions folder that isn't there yet
                    if let Some(dir) = dest.parent() {
                        fs::create_dir_all(dir)?;
                    }
                    fs::rename(&target, &dest)?;
                }
                "delete" => {
                    let meta = fs::symlink_metadata(&target)?;
                    if meta.is_dir() {
                        fs::remove_dir_all(&target)?;
                    } else {
                        fs::remove_file(&target)?;
                    }
                }
                _ => return fail_at("method not allowed", 405),
            }
            Ok(())
        })
        .await?;
        Ok(json!({ "ok": true, "path": shown }))
    }
}

fn drop_upload(u: Option<Upload>) {
    if let Some(u) = u {
        drop(u.file);
        let _ = fs::remove_file(&u.temp);
    }
}

/// a byte offset or size as Number() reads it: blank is 0
pub(crate) fn parse_count(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return Some(0);
    }
    let n: f64 = s.parse().ok()?;
    (n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0).then_some(n as u64)
}

pub fn read_file(p: &Path, rel: &str) -> Res<Value> {
    let info = fs::metadata(p)?;
    if !info.is_file() {
        return fail("not a file");
    }
    if info.len() > MAX_TEXT as u64 {
        return Ok(json!({ "path": rel, "size": info.len(), "tooBig": true }));
    }
    let data = fs::read(p)?;
    if data.contains(&0) {
        return Ok(json!({ "path": rel, "size": info.len(), "binary": true }));
    }
    let text = match String::from_utf8(data) {
        Ok(t) => t,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    Ok(json!({ "path": rel, "size": info.len(), "text": text }))
}

/// where `needle` next occurs in `hay` at or after byte `from`
pub fn find_from(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() || hay.len() - from < needle.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

pub fn posix_join(dir: &str, name: &str) -> String {
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() || dir == "." {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// a request body, refused past `max` bytes
pub async fn read_body(body: axum::body::Body, max: usize) -> Res<bytes::Bytes> {
    axum::body::to_bytes(body, max).await.map_err(|e| {
        let mut source: Option<&dyn std::error::Error> = Some(&e);
        while let Some(s) = source {
            if s.to_string().contains("length limit") {
                return Fail::new("request too large", 413);
            }
            source = s.source();
        }
        Fail::new("request too large", 413)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Arc<Files>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let machine = Machine {
            user: "me".into(),
            host: "test-machine".into(),
            platform: "linux".into(),
            shell: "sh".into(),
            shares: vec![Share { id: "0".into(), label: root.to_string_lossy().into(), root, perms: "rwd".into(), home: false }],
        };
        (dir, Files::new(machine))
    }

    #[tokio::test]
    async fn files_keep_list_tree_search_text_and_upload_contracts() {
        let (dir, files) = fixture();
        let root = dir.path();
        fs::create_dir_all(root.join("dir/empty")).unwrap();
        fs::write(root.join("dir/a.js"), "Hello\r\nhello\nother").unwrap();
        fs::write(root.join("binary"), [1u8, 0, 2]).unwrap();
        fs::write(root.join(".phosphorus-upload-hidden"), "pending").unwrap();
        let names: Vec<String> = files.list("0", "").await.unwrap()["entries"]
            .as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["dir", "binary"]);
        let listed = files.list("0", "dir").await.unwrap();
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries[0]["name"], "empty");
        assert_eq!(entries[0]["empty"], true);
        assert_eq!(entries[0]["size"], Value::Null);
        assert_eq!(entries[1]["size"], 18);
        let paths = |v: Value| -> Vec<String> {
            v["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_owned()).collect()
        };
        assert_eq!(paths(files.tree("0", "", "1", "", "").await.unwrap()), ["binary", "dir/"]);
        assert_eq!(paths(files.tree("0", "", "8", "*.JS", "").await.unwrap()), ["dir/a.js"]);
        assert_eq!(paths(files.tree("0", "", "8", "", "dir").await.unwrap()), ["binary"]);
        let found = files.search("0", "", "hello", true, "", "").await.unwrap();
        assert_eq!(
            found["results"],
            json!([{ "path": "dir/a.js", "matches": [{ "line": 1, "text": "Hello" }, { "line": 2, "text": "hello" }] }])
        );
        // case-blind for names and text, ASCII or not
        fs::write(root.join("dir/Ünïcode.txt"), "straße\nSTRASSE\nÜnïcode here").unwrap();
        assert_eq!(files.search("0", "", "HELLO", true, "", "").await.unwrap()["results"].as_array().unwrap().len(), 1);
        let text = files.search("0", "", "ünïcode", true, "", "").await.unwrap();
        assert_eq!(text["results"], json!([{ "path": "dir/Ünïcode.txt", "matches": [{ "line": 3, "text": "Ünïcode here" }] }]));
        let names: Vec<String> = files.search("0", "", "ünï", false, "", "").await.unwrap()["results"]
            .as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["dir/Ünïcode.txt"]);
        assert!(files.search("0", "", "nothere", true, "", "").await.unwrap()["results"].as_array().unwrap().is_empty());
        assert_eq!(files.read("0", "binary").await.unwrap()["binary"], true);
        assert_eq!(files.read("0", "dir/a.js").await.unwrap()["text"], "Hello\r\nhello\nother");
        files.save("0", "dir/a.js", None, Some("other".into()), Some("world".into())).await.unwrap();
        let missing = files.save("0", "dir/a.js", None, Some("missing".into()), Some("x".into())).await.unwrap_err();
        assert!(missing.message.contains("old text not found"));
        let twice = files.save("0", "dir/a.js", None, Some("ello".into()), Some("x".into())).await.unwrap_err();
        assert!(twice.message.contains("more than once"));
        let up = |offset: &'static str, body: &'static str| {
            let files = files.clone();
            async move { files.upload("0", "out.bin", axum::body::Body::from(body), Some("fixture"), Some(offset), Some("5")).await }
        };
        assert_eq!(up("0", "abc").await.unwrap(), json!({ "ok": true, "next": 3 }));
        assert!(up("1", "xy").await.unwrap_err().message.contains("offset"));
        assert_eq!(up("3", "de").await.unwrap(), json!({ "ok": true, "path": "out.bin" }));
        assert_eq!(fs::read_to_string(root.join("out.bin")).unwrap(), "abcde");
        files.mutate("0", "rename", &json!({ "from": "dir/empty", "to": "new/parents/moved" })).await.unwrap();
        assert!(root.join("new/parents/moved").is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_paths_refuse_traversal_and_link_escapes() {
        let (dir, files) = fixture();
        assert!(files.resolve("0", "../escape", true).await.unwrap_err().message.contains("invalid path"));
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        let e = files.resolve("0", "link/new/file.txt", true).await.unwrap_err();
        assert!(e.message.contains("leaves its share"));
        assert!(files.resolve("0", "fresh/new.txt", true).await.is_ok());
    }
}
