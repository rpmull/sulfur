//! Language servers on this computer: installed into ~/.sulfur/languages from
//! their own sources, started in a project, their LSP messages carried over
//! the page's socket with every document held inside the project.
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use serde_json::{json, Map, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::ChildStdin,
    sync::Mutex,
};

use crate::{
    json16,
    registry::{fetch_vsix, https_get, platform, sha256_hex},
    util::{atomic_json, canonical, command, fail, hidden, home_dir, inside, random_id, read_json, safe_path, which, Fail, Res},
};

pub const IPC_BRIDGE: &str = include_str!("../../../server/lsp-ipc.cjs");
const SUFFIX: &str = if cfg!(windows) { ".exe" } else { "" };

pub fn language_home() -> PathBuf {
    std::env::var_os("SULFUR_LANGUAGE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home_dir().join(".sulfur/languages"))
}

pub fn catalog() -> Vec<Value> {
    let npm = |id: &str, name: &str, server: &str, packages: &[&str], entry: &str, pre: &str| {
        json!({ "id": id, "name": name, "server": server, "packages": packages, "entry": entry, "prerequisites": pre })
    };
    let native = |id: &str, name: &str, server: &str, pre: &str| json!({ "id": id, "name": name, "server": server, "prerequisites": pre });
    vec![
        npm("typescript", "TypeScript", "TypeScript Language Server", &["typescript-language-server", "typescript"], "typescript-language-server/lib/cli.mjs", "Node.js 22+ and npm"),
        npm("python", "Python", "Pyright", &["pyright"], "pyright/langserver.index.js", "Node.js 22+ and npm; select a project virtual environment in pyrightconfig.json"),
        npm("javascript", "JavaScript", "TypeScript Language Server", &["typescript-language-server", "typescript"], "typescript-language-server/lib/cli.mjs", "Node.js 22+ and npm"),
        native("java", "Java", "Eclipse JDT LS", "JDK 21+ (JAVA_HOME or java on PATH)"),
        native("csharp", "C#", "csharp-ls", ".NET 10 SDK"),
        npm("php", "PHP", "Intelephense", &["intelephense"], "intelephense/lib/intelephense.js", "Node.js 22+ and npm"),
        npm("shell", "Shell (Bash)", "Bash Language Server", &["bash-language-server"], "bash-language-server/out/cli.js", "Node.js 22+, npm and Bash"),
        native("cpp", "C / C++", "clangd", "C/C++ toolchain and compile_commands.json"),
        native("hcl", "HCL / Terraform", "terraform-ls", "Terraform CLI recommended"),
        native("go", "Go", "gopls", "current Go SDK; installation compiles gopls"),
    ]
}

fn valid_id(id: &str) -> bool {
    const BUILT_IN: &[&str] = &["typescript", "javascript", "python", "java", "csharp", "php", "shell", "cpp", "hcl", "go"];
    if BUILT_IN.contains(&id) {
        return true;
    }
    let Some(rest) = id.strip_prefix("vsx.") else { return false };
    !rest.is_empty()
        && rest.len() <= 121
        && rest.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && rest.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
}

/// where the LSP's messages and the host's own notes go: a page's socket or a helper's stdout
#[derive(Clone)]
pub struct Out {
    pub send: Arc<dyn Fn(String) + Send + Sync>,
    pub close: Arc<dyn Fn() + Send + Sync>,
}

impl Out {
    pub fn emit(&self, kind: &str, value: Value) {
        let mut v = json!({ "_sulfur": kind });
        if let Value::Object(o) = value {
            for (k, x) in o {
                v[k] = x;
            }
        }
        (self.send)(v.to_string());
    }
}

/// a started server: its input, project, manifest and the virtual documents it named
pub struct Lsp {
    stdin: Mutex<ChildStdin>,
    root: PathBuf,
    manifest: Value,
    folder: PathBuf,
    virtual_docs: StdMutex<HashSet<String>>,
    kill: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Lsp {
    pub fn stop(&self) {
        if let Some(k) = self.kill.lock().unwrap().take() {
            let _ = k.send(());
        }
    }
}

/// what's read from a server: Content-Length framed JSON, split anywhere
#[derive(Default)]
pub struct Framer {
    buffer: Vec<u8>,
    size: Option<usize>,
}

impl Framer {
    pub fn push(&mut self, data: &[u8], mut receive: impl FnMut(&[u8])) -> Res<()> {
        self.buffer.extend_from_slice(data);
        loop {
            if self.size.is_none() {
                let Some(i) = self.buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if self.buffer.len() > 65536 {
                        return fail("Invalid LSP Content-Length");
                    }
                    return Ok(());
                };
                let head = String::from_utf8_lossy(&self.buffer[..i]).to_lowercase();
                let size = head
                    .split("\r\n")
                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>()))
                    .and_then(Result::ok)
                    .filter(|n| *n <= 32 << 20);
                let Some(size) = size else { return fail("Invalid LSP Content-Length") };
                self.size = Some(size);
                self.buffer.drain(..i + 4);
            }
            let size = self.size.expect("a frame size");
            if self.buffer.len() < size {
                return Ok(());
            }
            let body: Vec<u8> = self.buffer.drain(..size).collect();
            self.size = None;
            receive(&body);
        }
    }
}

pub fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out
}

fn remember_uris(v: &Value, set: &mut HashSet<String>) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                match x.as_str() {
                    Some(s) if (k == "uri" || k == "targetUri") && s.starts_with("csharp:") => {
                        set.insert(s.to_owned());
                    }
                    _ => remember_uris(x, set),
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| remember_uris(x, set)),
        _ => {}
    }
}

/// an archive unpacked under `dest`: zip or tar.gz, no links, 512 MiB at most
pub fn unpack(data: &[u8], dest: &Path) -> Res<()> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    if data.starts_with(b"PK") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|_| Fail::new("invalid archive", 400))?;
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|_| Fail::new("invalid archive", 400))?;
            total += f.size();
            if f.size() > 128 << 20 || total > 512 << 20 {
                return fail("archive exceeds size limit");
            }
            let name = f.name().to_owned();
            if name.ends_with('/') {
                continue;
            }
            let mut buf = Vec::with_capacity(f.size() as usize);
            (&mut f).take(128 << 20).read_to_end(&mut buf).map_err(|_| Fail::new("invalid archive", 400))?;
            entries.push((name, buf));
        }
    } else {
        let gz = flate2::read::GzDecoder::new(data).take((512 << 20) + 1);
        let mut archive = tar::Archive::new(gz);
        let mut total = 0u64;
        for entry in archive.entries().map_err(|_| Fail::new("invalid archive", 400))? {
            let mut entry = entry.map_err(|_| Fail::new("invalid archive", 400))?;
            let kind = entry.header().entry_type();
            if kind.is_dir() {
                continue;
            }
            if !kind.is_file() {
                return fail("archive links are not accepted");
            }
            let name = entry.path().map_err(|_| Fail::new("invalid archive", 400))?.to_string_lossy().into_owned();
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|_| Fail::new("invalid archive", 400))?;
            total += buf.len() as u64;
            if total > 512 << 20 {
                return fail("archive exceeds size limit");
            }
            entries.push((name, buf));
        }
    }
    for (name, buf) in entries {
        let target = safe_path(dest, &name, true)?;
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&target, &buf)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

fn find_file(root: &Path, pred: &dyn Fn(&str) -> bool) -> Option<String> {
    let mut ents: Vec<_> = std::fs::read_dir(root).ok()?.filter_map(Result::ok).collect();
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        let name = e.file_name().to_string_lossy().into_owned();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            if let Some(found) = find_file(&e.path(), pred) {
                return Some(format!("{name}/{found}"));
            }
        } else if pred(&name) {
            return Some(name);
        }
    }
    None
}

fn node_path() -> Res<PathBuf> {
    which("node").ok_or_else(|| Fail::new("Node.js is not on PATH", 400))
}

fn java_path() -> PathBuf {
    match std::env::var_os("JAVA_HOME") {
        Some(home) => PathBuf::from(home).join(format!("bin/java{SUFFIX}")),
        None => which("java").unwrap_or_else(|| PathBuf::from("java")),
    }
}

/// a staging folder removed however its install ends, cancelled included
struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct LanguageHost {
    pub home: PathBuf,
}

impl Default for LanguageHost {
    fn default() -> Self {
        LanguageHost { home: language_home() }
    }
}

impl LanguageHost {
    fn load(&self, id: &str) -> Option<Value> {
        read_json(&self.home.join(id).join("manifest.json"))
    }

    pub fn status(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for mut item in catalog() {
            let id = item["id"].as_str().unwrap_or("").to_owned();
            let manifest = self.load(&id);
            item["installed"] = json!(manifest.is_some());
            item["enabled"] = json!(manifest.as_ref().is_some_and(|m| m["enabled"] == true));
            item["manifest"] = manifest.unwrap_or(Value::Null);
            out.push(item);
        }
        let mut dirs: Vec<String> = std::fs::read_dir(&self.home)
            .map(|rd| rd.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        dirs.sort();
        for id in dirs {
            if !id.starts_with("vsx.") || !valid_id(&id) {
                continue;
            }
            let Some(m) = self.load(&id).filter(|m| m["custom"] == true) else { continue };
            out.push(json!({
                "id": id,
                "name": m["name"],
                "server": m["server"],
                "prerequisites": if m["runtime"] == "node" { "Node.js on PATH" } else { "" },
                "installed": true,
                "enabled": m["enabled"].as_bool().unwrap_or(false),
                "manifest": m,
                "custom": true,
                "extensions": m["extensions"],
                "filenames": m["filenames"],
                "languageIds": m["languageIds"],
            }));
        }
        out
    }

    /// a status, an install or removal, or a server started; `None` when the
    /// socket should end, the started server otherwise
    pub async fn serve(&self, out: &Out, request: &Value) -> Res<Option<Arc<Lsp>>> {
        let op = request["op"].as_str().unwrap_or("");
        if op == "status" {
            out.emit("status", json!({ "extensions": self.status(), "platform": platform() }));
            (out.close)();
            return Ok(None);
        }
        let id = request["language"].as_str().unwrap_or("");
        if !valid_id(id) {
            return fail("Unknown language");
        }
        let item = catalog().into_iter().find(|x| x["id"] == id).unwrap_or_else(|| {
            json!({ "id": id, "name": request["server"]["name"], "server": request["server"]["name"], "custom": true })
        });
        if op == "launch" {
            return self.launch(out, &item, request).await.map(Some);
        }
        std::fs::create_dir_all(&self.home)?;
        let lock = self.home.join(format!(".lock-{id}"));
        if std::fs::create_dir(&lock).is_err() {
            return fail("Another operation is using this extension; retry when it finishes");
        }
        let _lock = Stage(lock);
        let target = self.home.join(id);
        if std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
            return fail("Refusing a symlink installation directory");
        }
        match op {
            "install" => self.install(&item, request.get("server").filter(|s| s.is_object()), out).await?,
            "uninstall" => {
                if target.exists() {
                    std::fs::remove_dir_all(&target)?;
                }
            }
            "enable" | "disable" => {
                let Some(mut m) = self.load(id) else { return fail("Install the extension first") };
                m["enabled"] = json!(op == "enable");
                atomic_json(&target.join("manifest.json"), &m)?;
            }
            _ => return fail("Unknown operation"),
        }
        drop(_lock);
        out.emit("status", json!({ "extensions": self.status(), "platform": platform() }));
        (out.close)();
        Ok(None)
    }

    async fn install(&self, item: &Value, server: Option<&Value>, out: &Out) -> Res<()> {
        let id = item["id"].as_str().unwrap_or("");
        let stage_dir = self.home.join(format!(".install-{}", random_id()));
        std::fs::create_dir_all(&stage_dir)?;
        let stage = Stage(stage_dir);
        let target = self.home.join(id);
        let backup = self.home.join(format!(".old-{id}-{}", random_id()));
        let mut m = Map::new();
        m.insert("enabled".into(), json!(true));
        m.insert("server".into(), item["server"].clone());
        m.insert("platform".into(), json!(platform()));
        let server_name = item["server"].as_str().unwrap_or(id).to_owned();
        let run = |args: Vec<String>, env: Vec<(String, String)>| {
            let out = out.clone();
            let dir = stage.0.clone();
            let name = server_name.clone();
            async move {
                out.emit("log", json!({ "text": format!("Installing {name}") }));
                let r = command(&args, Some(&dir), &env, Duration::from_secs(600)).await?;
                if r.code != 0 {
                    let why = if !r.err.trim().is_empty() { r.err } else if !r.out.trim().is_empty() { r.out } else { "installation failed".into() };
                    return Err(Fail::new(why, 400));
                }
                Res::Ok(())
            }
        };
        let mut artifacts = Vec::new();
        let download = |url: String| {
            let dir = stage.0.clone();
            async move {
                let data = https_get(&url, 256 << 20, Duration::from_secs(900)).await?;
                let sum = sha256_hex(&data);
                tokio::task::spawn_blocking(move || unpack(&data, &dir)).await??;
                Res::Ok(json!({ "url": url, "sha256": sum }))
            }
        };
        if let Some(server) = server {
            let p = platform();
            let dl = [p.as_str(), "universal", "web"].iter().find_map(|k| server["downloads"][*k].as_str()).map(str::to_owned);
            let Some(dl) = dl else { return fail("No server package for this platform") };
            let (data, sum) = fetch_vsix(&dl).await?;
            let dir = stage.0.clone();
            tokio::task::spawn_blocking(move || unpack(&data, &dir)).await??;
            for (k, v) in server.as_object().into_iter().flatten() {
                m.insert(k.clone(), v.clone());
            }
            m.insert("custom".into(), json!(true));
            m.insert("name".into(), server["name"].clone());
            m.insert("server".into(), server["name"].clone());
            m.insert("sha256".into(), json!(sum));
        } else if let Some(packages) = item["packages"].as_array() {
            let packages: Vec<String> = packages.iter().filter_map(Value::as_str).map(str::to_owned).collect();
            std::fs::write(stage.0.join("package.json"), r#"{"private":true}"#)?;
            let npm = which("npm").ok_or_else(|| Fail::new("npm is not on PATH", 400))?;
            let args = if cfg!(windows) {
                vec![
                    "cmd.exe".into(),
                    "/d".into(),
                    "/s".into(),
                    "/c".into(),
                    format!("\"\"{}\" install --no-audit --no-fund {}\"", npm.display(), packages.join(" ")),
                ]
            } else {
                let mut a = vec![npm.to_string_lossy().into_owned(), "install".into(), "--no-audit".into(), "--no-fund".into()];
                a.extend(packages.iter().cloned());
                a
            };
            run(args, vec![]).await?;
            m.insert("entry".into(), json!(format!("node_modules/{}", item["entry"].as_str().unwrap_or(""))));
            let mut versions = Map::new();
            for p in &packages {
                let meta = read_json(&stage.0.join("node_modules").join(p).join("package.json"));
                versions.insert(p.clone(), meta.map(|m| m["version"].clone()).unwrap_or(Value::Null));
            }
            m.insert("packages".into(), Value::Object(versions));
        } else if id == "go" {
            let gobin = stage.0.to_string_lossy().into_owned();
            run(vec!["go".into(), "install".into(), "golang.org/x/tools/gopls@latest".into()], vec![("GOBIN".into(), gobin)]).await?;
            m.insert("entry".into(), json!(format!("gopls{SUFFIX}")));
        } else if id == "csharp" {
            let dir = stage.0.to_string_lossy().into_owned();
            run(vec!["dotnet".into(), "tool".into(), "install".into(), "csharp-ls".into(), "--tool-path".into(), dir], vec![]).await?;
            m.insert("entry".into(), json!(format!("csharp-ls{SUFFIX}")));
        } else if id == "cpp" {
            if let Some(existing) = which("clangd") {
                m.insert("entry".into(), json!(existing));
                m.insert("external".into(), json!(true));
            } else {
                if std::env::consts::ARCH != "x86_64" {
                    return fail("Install a native clangd on PATH for this architecture, then retry");
                }
                let release: Value =
                    serde_json::from_slice(&https_get("https://api.github.com/repos/clangd/clangd/releases/latest", 8 << 20, Duration::from_secs(60)).await?)?;
                let os = match std::env::consts::OS {
                    "windows" => "windows",
                    "macos" => "mac",
                    _ => "linux",
                };
                let asset = release["assets"].as_array().into_iter().flatten().find(|a| {
                    let n = a["name"].as_str().unwrap_or("");
                    n.starts_with(&format!("clangd-{os}-")) && n.ends_with(".zip")
                });
                let Some(url) = asset.and_then(|a| a["browser_download_url"].as_str()) else {
                    return fail("No clangd release for this platform");
                };
                artifacts.push(download(url.to_owned()).await?);
                let name = format!("clangd{SUFFIX}");
                let found = find_file(&stage.0, &|n| n == name).unwrap_or_default();
                m.insert("entry".into(), json!(found));
            }
        } else if id == "hcl" {
            let v: Value = serde_json::from_slice(
                &https_get("https://checkpoint-api.hashicorp.com/v1/check/terraform-ls", 1 << 20, Duration::from_secs(60)).await?,
            )?;
            let v = v["current_version"].as_str().unwrap_or("");
            let os = match std::env::consts::OS {
                "macos" => "darwin",
                o => o,
            };
            let arch = match std::env::consts::ARCH {
                "x86_64" => "amd64",
                "aarch64" => "arm64",
                a => a,
            };
            artifacts.push(download(format!("https://releases.hashicorp.com/terraform-ls/{v}/terraform-ls_{v}_{os}_{arch}.zip")).await?);
            m.insert("entry".into(), json!(format!("terraform-ls{SUFFIX}")));
        } else if id == "java" {
            let java = java_path();
            let ver = command(&[java.to_string_lossy().into_owned(), "-version".into()], None, &[], Duration::from_secs(30)).await?;
            let text = format!("{}{}", ver.err, ver.out);
            let major = regex::Regex::new(r#"version\s+"(\d+)"#).unwrap().captures(&text).and_then(|c| c[1].parse::<u32>().ok()).unwrap_or(0);
            if major < 21 {
                return fail("JDT LS requires JDK 21 or newer");
            }
            let base = "https://download.eclipse.org/jdtls/milestones/";
            let html = String::from_utf8_lossy(&https_get(base, 8 << 20, Duration::from_secs(60)).await?).into_owned();
            let mut versions: Vec<String> =
                regex::Regex::new(r#"href="(\d+\.\d+\.\d+)/"#).unwrap().captures_iter(&html).map(|c| c[1].to_owned()).collect();
            versions.sort_by_key(|v| v.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>());
            let Some(latest) = versions.last() else { return fail("Eclipse JDT LS download service is unavailable") };
            let url = format!("{base}{latest}/");
            let listing = String::from_utf8_lossy(&https_get(&url, 8 << 20, Duration::from_secs(60)).await?).into_owned();
            let Some(artifact) = regex::Regex::new(r"jdt-language-server-[\w.-]+\.tar\.gz").unwrap().find(&listing).map(|m| m.as_str().to_owned()) else {
                return fail("Eclipse JDT LS download service is unavailable");
            };
            artifacts.push(download(format!("{url}{artifact}")).await?);
            m.insert("entry".into(), json!("jdtls"));
        }
        if !artifacts.is_empty() {
            m.insert("artifacts".into(), Value::Array(artifacts));
        }
        if server.is_some_and(|s| s["transport"] == "ipc") {
            std::fs::write(stage.0.join("sulfur-ipc-bridge.cjs"), IPC_BRIDGE)?;
        }
        atomic_json(&stage.0.join("manifest.json"), &Value::Object(m))?;
        let mut moved = false;
        if target.exists() {
            std::fs::rename(&target, &backup)?;
            moved = true;
        }
        if let Err(e) = std::fs::rename(&stage.0, &target) {
            if moved {
                let _ = std::fs::rename(&backup, &target);
            }
            return Err(e.into());
        }
        if moved {
            let _ = std::fs::remove_dir_all(&backup);
        }
        Ok(())
    }

    async fn launch(&self, out: &Out, item: &Value, request: &Value) -> Res<Arc<Lsp>> {
        let id = item["id"].as_str().unwrap_or("");
        let Some(m) = self.load(id).filter(|m| m["enabled"] == true) else {
            return fail("Extension is not installed and enabled");
        };
        let root_raw = request["root"].as_str().unwrap_or("");
        if !crate::util::is_absolute_str(root_raw) || !std::fs::metadata(root_raw).is_ok_and(|x| x.is_dir()) {
            return fail("Open an existing absolute project folder on this host");
        }
        let root = canonical(Path::new(root_raw))?;
        let folder = self.home.join(id);
        let entry_rel = m["entry"].as_str().unwrap_or("");
        let entry = if id == "java" {
            PathBuf::new()
        } else if m["external"] == true {
            PathBuf::from(entry_rel)
        } else {
            safe_path(&folder, entry_rel, false)?
        };
        let custom = item["custom"] == true || m["custom"] == true;
        let mut argv: Vec<std::ffi::OsString> = Vec::new();
        let args_of = |v: &Value| v.as_array().into_iter().flatten().filter_map(Value::as_str).map(std::ffi::OsString::from).collect::<Vec<_>>();
        if custom {
            if m["runtime"] == "node" {
                argv.push(node_path()?.into());
                if m["transport"] == "ipc" {
                    argv.push(folder.join("sulfur-ipc-bridge.cjs").into());
                }
                argv.push(entry.into());
            } else {
                argv.push(entry.into());
            }
            argv.extend(args_of(&m["args"]));
        } else if item["packages"].is_array() {
            argv.push(node_path()?.into());
            argv.push(entry.into());
            if ["typescript", "javascript", "python", "php"].contains(&id) {
                argv.push("--stdio".into());
                if id == "typescript" || id == "javascript" {
                    argv.push("--tsserver-path".into());
                    argv.push(folder.join("node_modules/typescript/lib/tsserver.js").into());
                }
            } else if id == "shell" {
                argv.push("start".into());
            }
        } else if id == "java" {
            let jar = find_file(&folder, &|n| n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar"))
                .ok_or_else(|| Fail::new("The JDT LS launcher is missing; reinstall the extension", 400))?;
            let system = match std::env::consts::OS {
                "windows" => "win",
                "macos" => "mac",
                _ => "linux",
            };
            let arm = if std::env::consts::ARCH == "aarch64" { "_arm" } else { "" };
            let mut config = folder.join(format!("config_{system}{arm}"));
            if !config.exists() {
                config = folder.join(format!("config_{system}"));
            }
            let key = format!("{root_raw}{}", request["configuration"].as_str().unwrap_or(""));
            let cache = self.home.join(".workspaces").join(&sha256_hex(key.as_bytes())[..24]);
            argv.push(java_path().into());
            for a in [
                "-Declipse.application=org.eclipse.jdt.ls.core.id1",
                "-Dosgi.bundles.defaultStartLevel=4",
                "-Declipse.product=org.eclipse.jdt.ls.core.product",
                "-Xmx1G",
                "--add-modules=ALL-SYSTEM",
                "--add-opens",
                "java.base/java.util=ALL-UNNAMED",
                "--add-opens",
                "java.base/java.lang=ALL-UNNAMED",
                "-jar",
            ] {
                argv.push(a.into());
            }
            argv.push(folder.join(jar).into());
            argv.push("-configuration".into());
            argv.push(config.into());
            argv.push("-data".into());
            argv.push(cache.into());
        } else {
            argv.push(entry.into());
            if id == "cpp" {
                argv.push("--background-index".into());
                if let Some(b) = request["buildDirectory"].as_str().filter(|s| !s.is_empty()) {
                    argv.push(format!("--compile-commands-dir={b}").into());
                }
            } else if id == "hcl" {
                argv.push("serve".into());
            }
        }
        let mut cmd = hidden(&argv[0]);
        cmd.args(&argv[1..]).current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| Fail::new(format!("couldn't start {}: {e}", Path::new(&argv[0]).display()), 400))?;
        let stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let (kill_tx, kill_rx) = tokio::sync::oneshot::channel();
        let lsp = Arc::new(Lsp {
            stdin: Mutex::new(stdin),
            root: root.clone(),
            manifest: m,
            folder,
            virtual_docs: StdMutex::new(HashSet::new()),
            kill: StdMutex::new(Some(kill_tx)),
        });
        let root_uri = url::Url::from_directory_path(&root).map(|u| u.as_str().trim_end_matches('/').to_owned()).unwrap_or_default();
        out.emit("ready", json!({ "rootUri": root_uri }));
        let (o, l) = (out.clone(), lsp.clone());
        tokio::spawn(async move {
            let mut framer = Framer::default();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let pushed = framer.push(&buf[..n], |body| {
                    if body.windows(7).any(|w| w == b"csharp:") {
                        if let Ok(v) = serde_json::from_slice::<Value>(body) {
                            remember_uris(&v, &mut l.virtual_docs.lock().unwrap());
                        }
                    }
                    (o.send)(String::from_utf8_lossy(body).into_owned());
                });
                if let Err(e) = pushed {
                    o.emit("error", json!({ "error": e.message }));
                    l.stop();
                    break;
                }
            }
        });
        let o = out.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => o.emit("log", json!({ "text": String::from_utf8_lossy(&buf[..n]) })),
                }
            }
        });
        let o = out.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill_rx => {
                    let _ = child.kill().await;
                    child.wait().await.ok()
                }
            };
            o.emit("stopped", json!({ "code": status.map(|s| crate::util::exit_code(&s)) }));
            (o.close)();
        });
        Ok(lsp)
    }
}

/// a page's LSP message to the server, its document held inside the project
pub async fn lsp_message(lsp: &Lsp, text: &str) -> Res<()> {
    let msg = json16::parse(text).map_err(|_| Fail::new("invalid json", 400))?;
    let method = msg.string("method").unwrap_or_default();
    let doc = msg.get("params").and_then(|p| p.get("textDocument")).and_then(|d| d.string("uri"));
    if let Some(doc) = doc {
        let virtual_read = lsp.virtual_docs.lock().unwrap().contains(&doc)
            && [
                "csharp/metadata",
                "textDocument/semanticTokens/full",
                "textDocument/definition",
                "textDocument/hover",
                "textDocument/documentSymbol",
            ]
            .contains(&method.as_str());
        if !virtual_read {
            let outside = || Fail::new("document is outside this project", 400);
            let uri = url::Url::parse(&doc).map_err(|_| outside())?;
            if uri.scheme() != "file" || uri.host_str().is_some_and(|h| !h.is_empty()) {
                return Err(outside());
            }
            let file = uri.to_file_path().map_err(|_| outside())?;
            if !inside(&lsp.root, &file) {
                return Err(outside());
            }
            let rel = file.strip_prefix(&lsp.root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            safe_path(&lsp.root, &rel, true).map_err(|_| outside())?;
        }
    }
    let mut body = text.as_bytes().to_vec();
    if method == "initialize" && lsp.manifest["initializationOptions"].is_object() {
        if let Ok(mut v) = serde_json::from_str::<Value>(text) {
            let ext = lsp.folder.join("extension").to_string_lossy().into_owned();
            fn expand(v: &Value, ext: &str) -> Value {
                match v {
                    Value::String(s) => json!(s.replace("${extensionPath}", ext)),
                    Value::Array(a) => Value::Array(a.iter().map(|x| expand(x, ext)).collect()),
                    Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), expand(x, ext))).collect()),
                    v => v.clone(),
                }
            }
            let mut options = expand(&lsp.manifest["initializationOptions"], &ext);
            for (k, x) in v["params"]["initializationOptions"].as_object().into_iter().flatten() {
                options[k] = x.clone();
            }
            if !v["params"].is_object() {
                v["params"] = json!({});
            }
            v["params"]["initializationOptions"] = options;
            body = serde_json::to_vec(&v)?;
        }
    }
    let mut stdin = lsp.stdin.lock().await;
    stdin.write_all(&frame(&body)).await.map_err(|e| Fail::new(e.to_string(), 500))?;
    stdin.flush().await.map_err(|e| Fail::new(e.to_string(), 500))?;
    Ok(())
}

/// the mesh host helper: `sulfur sulfur-language <base64 request>`, its replies
/// as lines on stdout, LSP messages as lines on stdin
pub async fn helper_main(arg: &str) -> i32 {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let say = |line: String| {
        use std::io::Write;
        let mut o = std::io::stdout().lock();
        let _ = writeln!(o, "{line}");
        let _ = o.flush();
    };
    let out = Out { send: Arc::new(say), close: Arc::new(|| {}) };
    let request: Value = match STANDARD.decode(arg.trim()).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(v) => v,
        None => {
            out.emit("error", json!({ "error": "invalid language request" }));
            return 1;
        }
    };
    let host = LanguageHost::default();
    let lsp = match host.serve(&out, &request).await {
        Ok(Some(l)) => l,
        Ok(None) => return 0,
        Err(e) => {
            out.emit("error", json!({ "error": e.message }));
            return 1;
        }
    };
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    use tokio::io::AsyncBufReadExt;
    loop {
        line.clear();
        match lines.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let t = line.trim_end_matches(['\r', '\n']);
                if t.is_empty() {
                    continue;
                }
                if let Err(e) = lsp_message(&lsp, t).await {
                    out.emit("error", json!({ "error": e.message }));
                    lsp.stop();
                    return 1;
                }
            }
        }
    }
    lsp.stop();
    tokio::time::sleep(Duration::from_millis(50)).await;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_at_any_byte() {
        let body = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "method": "x", "params": { "text": "😀𝌆" } })).unwrap();
        let packet = frame(&body);
        let mut got = Vec::new();
        let mut f = Framer::default();
        for b in &packet {
            f.push(std::slice::from_ref(b), |m| got.push(m.to_vec())).unwrap();
        }
        assert_eq!(got, vec![body]);
        assert!(Framer::default().push(b"Content-Length: 999999999\r\n\r\n", |_| {}).is_err());
    }

    #[tokio::test]
    async fn documents_stay_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let mut child = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "cat" })
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let lsp = Lsp {
            stdin: Mutex::new(child.stdin.take().unwrap()),
            root: root.clone(),
            manifest: json!({}),
            folder: root.clone(),
            virtual_docs: StdMutex::new(["csharp:/a".to_owned()].into()),
            kill: StdMutex::new(None),
        };
        let open = |p: PathBuf| json!({ "method": "textDocument/didOpen", "params": { "textDocument": { "uri": url::Url::from_file_path(p).unwrap().as_str() } } }).to_string();
        lsp_message(&lsp, &open(root.join("new.txt"))).await.unwrap();
        assert!(lsp_message(&lsp, &open(root.join("../x"))).await.unwrap_err().message.contains("outside"));
        lsp_message(&lsp, r#"{"method":"textDocument/hover","params":{"textDocument":{"uri":"csharp:/a"}}}"#).await.unwrap();
        assert!(lsp_message(&lsp, r#"{"method":"textDocument/didChange","params":{"textDocument":{"uri":"csharp:/a"}}}"#)
            .await
            .unwrap_err()
            .message
            .contains("outside"));
    }

    #[test]
    fn the_catalog_has_ten_servers() {
        let dir = tempfile::tempdir().unwrap();
        let host = LanguageHost { home: dir.path().join("languages") };
        assert_eq!(host.status().len(), 10);
        assert!(valid_id("vsx.a.b-c"));
        assert!(!valid_id("vsx.../x"));
        assert!(!valid_id("rust"));
    }
}
