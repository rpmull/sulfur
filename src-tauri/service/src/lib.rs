//! Sulfur's own server on this computer, run inside its desktop app (or alone,
//! headless). It serves this computer's files, terminals, builds and compilers
//! at all times; a remembered mesh is reachable beside them under /api/mesh/.
//! Saved SSH hosts are served beside them under /api/ssh/<name>/.
//! Only on loopback, and only to its own page: every request's Host and Origin
//! are held to it, so no other site in a browser reaches it.
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use axum::{
    body::Body,
    extract::{ws::WebSocketUpgrade, FromRequestParts, Request, State},
    http::{header, HeaderValue, Method, Response, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tokio::sync::oneshot;

pub mod askpass;
pub mod bundle;
pub mod collab;
pub mod extensions;
pub mod files;
pub mod json16;
pub mod languages;
pub mod mesh;
pub mod ot;
pub mod processes;
pub mod registry;
pub mod sqlite;
pub mod ssh;
pub mod updates;
pub mod util;
pub mod vsix;
pub mod ws;

mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}

use files::{read_body, Files, Machine};
use util::{error_response, fail, fail_at, json, Fail, Res};
use ws::{next_frame, Frame, Ws};

/// a compiled-in web asset: its content type, whether it's gzip, and its bytes
pub fn asset(path: &str) -> Option<(&'static str, bool, &'static [u8])> {
    assets::ASSETS
        .binary_search_by(|(p, ..)| (*p).cmp(path))
        .ok()
        .map(|i| (assets::ASSETS[i].1, assets::ASSETS[i].2, assets::ASSETS[i].3))
}

fn asset_bytes(path: &str) -> Option<Vec<u8>> {
    let (_, gz, data) = asset(path)?;
    if !gz {
        return Some(data.to_vec());
    }
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(data), &mut out).ok()?;
    Some(out)
}

pub struct Options {
    /// where to listen; loopback only
    pub addr: String,
    /// the app's settings file; the user's config folder's Sulfur/sulfur.json if none
    pub config: Option<PathBuf>,
    /// the web build on disk, in place of the compiled-in one
    pub dist: Option<PathBuf>,
    pub version: String,
    /// inside the desktop app, whose updater installs releases
    pub native: bool,
    pub machine: Option<Machine>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            addr: "127.0.0.1:47615".into(),
            config: None,
            dist: None,
            version: env!("CARGO_PKG_VERSION").into(),
            native: false,
            machine: None,
        }
    }
}

struct App {
    origin: String,
    host: String,
    machine: Machine,
    files: Arc<Files>,
    collab: Arc<collab::Collab>,
    terms: Arc<processes::Terminals>,
    toolchains: processes::Toolchains,
    languages: languages::LanguageHost,
    sqlite: sqlite::SQLite,
    updates: updates::Updates,
    cfg: StdMutex<Value>,
    config_file: PathBuf,
    dist: Option<PathBuf>,
    native: bool,
    http: reqwest::Client,
    ssh: ssh::SshHosts,
    asks: Arc<askpass::Asks>,
}

pub struct Service {
    pub origin: String,
    app: Arc<App>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Debug)]
pub enum StartError {
    /// another program (perhaps another Sulfur) already listens there
    InUse(String),
    Other(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::InUse(a) => write!(f, "{a} is already in use"),
            StartError::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for StartError {}

pub fn default_config() -> PathBuf {
    util::config_home().join("Sulfur").join("sulfur.json")
}

/// the address's host and port, held to loopback
pub fn parse_addr(address: &str) -> Result<(String, u16), StartError> {
    let bad = || StartError::Other("-addr must be a loopback address and port".into());
    let i = address.rfind(':').ok_or_else(bad)?;
    let host = address[..i].trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = address[i + 1..].parse::<u16>().map_err(|_| bad())?;
    if !["127.0.0.1", "localhost", "::1"].contains(&host.as_str()) {
        return Err(bad());
    }
    Ok((host, port))
}

/// whether the server at `addr` is a Sulfur, and its origin if so
pub async fn existing(addr: &str) -> Option<String> {
    let (host, port) = parse_addr(addr).ok()?;
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let origin = format!("http://{authority}");
    let r = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(800))
        .build()
        .ok()?
        .get(format!("{origin}/api/sidecar/info"))
        .send()
        .await
        .ok()?;
    let v: Value = serde_json::from_slice(&r.bytes().await.ok()?).ok()?;
    (v["app"] == "sulfur").then_some(origin)
}

pub async fn start(opts: Options) -> Result<Service, StartError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (host, port) = parse_addr(&opts.addr)?;
    let bind: SocketAddr = match host.as_str() {
        "::1" => SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        _ => SocketAddr::from(([127, 0, 0, 1], port)),
    };
    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return Err(StartError::InUse(opts.addr.clone())),
        Err(e) => return Err(StartError::Other(e.to_string())),
    };
    let local = listener.local_addr().map_err(|e| StartError::Other(e.to_string()))?;
    let name = if host == "localhost" { "localhost".to_owned() } else if local.is_ipv6() { "[::1]".into() } else { "127.0.0.1".into() };
    let authority = format!("{name}:{}", local.port());
    let machine = match opts.machine {
        Some(m) => m,
        None => tokio::task::spawn_blocking(Machine::local).await.map_err(|e| StartError::Other(e.to_string()))?,
    };
    let files = Files::new(machine.clone());
    let config_file = opts.config.unwrap_or_else(default_config);
    let mut cfg = util::read_json(&config_file).filter(Value::is_object).unwrap_or_else(|| json!({}));
    if cfg.get("servers").is_none() {
        cfg["servers"] = json!([]);
    }
    cfg["mode"] = json!("local");
    if let Some(s) = cfg["server"].as_str().filter(|s| !s.is_empty()) {
        cfg["server"] = json!(mesh::server_url(s).unwrap_or_default());
    }
    let dist = opts.dist.or_else(|| {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist");
        (cfg!(debug_assertions) && dev.join("sulfur/index.html").exists()).then_some(dev)
    });
    let ssh_hosts = ssh::SshHosts::new(&cfg);
    let app = Arc::new(App {
        origin: format!("http://{authority}"),
        host: authority,
        collab: collab::Collab::new(files.clone()),
        files,
        machine,
        terms: Arc::new(processes::Terminals::default()),
        toolchains: processes::Toolchains::default(),
        languages: languages::LanguageHost::default(),
        sqlite: sqlite::SQLite::default(),
        updates: updates::Updates::new(&opts.version),
        cfg: StdMutex::new(cfg),
        config_file,
        dist,
        native: opts.native,
        http: mesh::client(),
        ssh: ssh_hosts,
        asks: Arc::new(askpass::Asks::default()),
    });
    let router = Router::new().fallback(handle).with_state(app.clone());
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });
    Ok(Service { origin: app.origin.clone(), app, stop: Some(stop), task })
}

impl Service {
    /// every open file saved, every shell and upload ended, then the server
    pub async fn stop(mut self) {
        self.app.collab.flush().await;
        self.app.ssh.dispose().await;
        self.app.terms.dispose();
        self.app.files.dispose().await;
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        // open sockets never finish on their own: the server's given a moment, then ended
        if tokio::time::timeout(Duration::from_millis(500), &mut self.task).await.is_err() {
            self.task.abort();
        }
    }

    pub fn version(&self) -> &str {
        &self.app.updates.version
    }
}

fn header_str<'a>(req: &'a Request, name: header::HeaderName) -> &'a str {
    req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

async fn body_json(body: Body, max: usize) -> Res<Value> {
    let data = read_body(body, max).await?;
    serde_json::from_slice(&data).map_err(|_| Fail::new("invalid json", 400))
}

fn query(req: &Request) -> HashMap<String, String> {
    url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes()).into_owned().collect()
}

fn query_has(req: &Request, key: &str) -> bool {
    url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes()).any(|(k, _)| k == key)
}

async fn handle(State(app): State<Arc<App>>, req: Request) -> Response<Body> {
    match route(&app, req).await {
        Ok(r) => r,
        Err(e) => error_response(&e),
    }
}

async fn route(app: &Arc<App>, req: Request) -> Res<Response<Body>> {
    if header_str(&req, header::HOST) != app.host {
        return Ok(text_response(StatusCode::MISDIRECTED_REQUEST, "not this server"));
    }
    let upgrade = header_str(&req, header::UPGRADE).eq_ignore_ascii_case("websocket");
    let method = req.method().clone();
    if (upgrade || (method != Method::GET && method != Method::HEAD)) && header_str(&req, header::ORIGIN) != app.origin {
        return Ok(text_response(StatusCode::FORBIDDEN, "not from Sulfur's page"));
    }
    let path = percent_path(req.uri().path());
    if path.starts_with("/api/mesh/") {
        return mesh_route(app, req, upgrade).await;
    }
    if let Some(rest) = path.strip_prefix("/api/ssh/") {
        let rest = rest.to_owned();
        return ssh_route(app, req, &rest, upgrade).await;
    }
    if path.starts_with("/api/sidecar/") {
        return sidecar(app, req, &path).await;
    }
    let local = path.strip_prefix("/api/local").filter(|r| r.starts_with("/api/")).unwrap_or(&path).to_owned();
    if upgrade {
        return socket(app, req, &local).await;
    }
    let q = query(&req);
    match (local.as_str(), &method) {
        ("/api/me", _) => return Ok(json(&json!({ "user": app.machine.user, "admin": true, "boot": false, "local": true }))),
        ("/api/model/v1/models", _) => return Ok(json(&json!({ "data": [] }))),
        ("/api/md", &Method::POST) => return fail_at("markdown is drawn by Sulfur's page", 501),
        ("/api/sulfur/toolchains", _) => return Ok(json(&app.toolchains.probe(&app.machine.host, q.contains_key("fresh")).await)),
        ("/api/sulfur/git", &Method::POST) => {
            let p: processes::GitRequest = serde_json::from_value(body_json(req.into_body(), 1 << 20).await?)?;
            return Ok(json(&processes::git_asking(p, &app.asks).await?));
        }
        ("/api/sulfur/sqlite", &Method::POST) => {
            let p: sqlite::Request = serde_json::from_value(body_json(req.into_body(), (1 << 20) + 4096).await?)?;
            return Ok(json(&app.sqlite.run(p).await?));
        }
        ("/api/sulfur/vsx/search", _) => return Ok(json(&registry::search(&q).await?)),
        ("/api/sulfur/vsx/convert", &Method::POST) => {
            let p = body_json(req.into_body(), 1 << 20).await?;
            return Ok(json(&registry::convert(&p).await?));
        }
        _ => {}
    }
    if let Some(rest) = local.strip_prefix("/api/files/") {
        let mut parts = rest.splitn(2, '/');
        let (host, op) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        const OPS: &[&str] = &["info", "list", "tree", "search", "read", "download", "upload", "save", "mkdir", "rename", "delete"];
        if valid_host(host) && OPS.contains(&op) {
            if host != app.machine.host {
                return fail_at(format!("{host} isn't this computer: use the linked mesh API for its machines"), 404);
            }
            return files_route(app, req, op, &q).await;
        }
    }
    if local.starts_with("/api/") {
        return fail_at(format!("This computer has no {local}"), 404);
    }
    if path == "/" {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::FOUND;
        r.headers_mut().insert(header::LOCATION, HeaderValue::from_str(&format!("{}/sulfur/", app.origin)).expect("an origin"));
        return Ok(r);
    }
    let gzip_ok = header_str(&req, header::ACCEPT_ENCODING).contains("gzip");
    static_asset(app, gzip_ok, &path).await
}

fn valid_host(h: &str) -> bool {
    !h.is_empty() && h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// a request path with its %-escapes decoded, as the routes and assets name it
fn percent_path(p: &str) -> String {
    let bytes = p.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&p[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn text_response(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut r = Response::new(Body::from(text));
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

async fn static_asset(app: &Arc<App>, gzip_ok: bool, path: &str) -> Res<Response<Body>> {
    let rel = if path == "/sulfur" || path == "/sulfur/" { "sulfur/index.html".to_owned() } else { path.trim_start_matches('/').to_owned() };
    if rel.split('/').any(|p| p == "..") || rel.contains('\0') || rel.contains('\\') {
        return fail("invalid path");
    }
    let hashed = regex_immutable(&rel);
    let (kind, gz, data): (String, bool, Vec<u8>) = match &app.dist {
        Some(dist) => {
            let file = util::safe_path(dist, &rel, false).map_err(|_| Fail::new("no such file", 404))?;
            let data = tokio::fs::read(&file).await.map_err(|_| Fail::new("no such file", 404))?;
            (guess_type(&rel).into(), false, data)
        }
        None => {
            let Some((kind, gz, data)) = asset(&rel) else { return fail_at("no such file", 404) };
            if gz && !gzip_ok {
                (kind.into(), false, asset_bytes(&rel).unwrap_or_default())
            } else {
                // compiled-in bytes are served as they are, never copied
                let mut r = Response::new(Body::from(bytes::Bytes::from_static(data)));
                set_asset_headers(&mut r, kind, gz, hashed);
                return Ok(r);
            }
        }
    };
    let mut r = Response::new(Body::from(data));
    set_asset_headers(&mut r, &kind, gz, hashed);
    Ok(r)
}

fn set_asset_headers(r: &mut Response<Body>, kind: &str, gz: bool, hashed: bool) {
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(kind).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if hashed { "public, max-age=31536000, immutable" } else { "no-cache" }),
    );
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if gz {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
}

/// a content-hashed build file, cached for good
fn regex_immutable(rel: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$").unwrap()).is_match(rel)
}

fn guess_type(rel: &str) -> &'static str {
    match rel.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

async fn sidecar(app: &Arc<App>, req: Request, path: &str) -> Res<Response<Body>> {
    let method = req.method().clone();
    match (path, method) {
        ("/api/sidecar/info", _) => {
            let cfg = app.cfg.lock().unwrap().clone();
            let server = cfg["server"].as_str().unwrap_or("").to_owned();
            let mut info = json!({
                "app": "sulfur",
                "version": app.updates.version,
                "mode": "local",
                "server": server,
                "servers": cfg["servers"],
                "user": app.machine.user,
                "host": app.machine.host,
                "platform": app.machine.platform,
                "shell": app.machine.shell,
                "info": app.machine.info(),
                "nodeExtensions": extensions::runtime().is_some(),
                "md": "page",
                "ssh": app.ssh.info().await,
                // git's prompts can be answered on the page (askpass.rs)
                "asks": askpass::helper().is_some(),
            });
            if !server.is_empty() {
                info["mesh"] = mesh::mesh_info(cfg["kind"].as_str().unwrap_or(""));
            }
            Ok(json(&info))
        }
        ("/api/sidecar/mode", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            let mode = b["mode"].as_str().unwrap_or("");
            if mode.is_empty() || mode == "local" {
                return Ok(json(&json!({ "mode": "local" })));
            }
            if mode != "link" && mode != "mesh" {
                return fail("unknown mesh kind");
            }
            let provider = mesh::provider(b["kind"].as_str().unwrap_or("phosphorus"))?;
            if !provider.linked {
                return fail(format!("{} isn't linked as a mesh: its hosts are added on their own", provider.kind));
            }
            let remote = mesh::server_url(b["server"].as_str().unwrap_or(""))?;
            mesh::reach(&remote).await?;
            let next = {
                let mut cfg = app.cfg.lock().unwrap();
                let mut next = cfg.clone();
                next["mode"] = json!("local");
                next["server"] = json!(remote);
                next["kind"] = json!(provider.kind);
                let mut servers = vec![json!(remote)];
                servers.extend(cfg["servers"].as_array().into_iter().flatten().filter(|s| s.as_str() != Some(&remote)).cloned());
                servers.truncate(8);
                next["servers"] = Value::Array(servers);
                util::atomic_json(&app.config_file, &next)?;
                *cfg = next.clone();
                next
            };
            Ok(json(&json!({ "mode": "local", "server": remote, "mesh": mesh::mesh_info(next["kind"].as_str().unwrap_or("")) })))
        }
        ("/api/sidecar/forget", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            let gone = b["server"].clone();
            let mut cfg = app.cfg.lock().unwrap();
            let mut next = cfg.clone();
            next["servers"] = Value::Array(cfg["servers"].as_array().into_iter().flatten().filter(|s| **s != gone).cloned().collect());
            if next["server"] == gone {
                next["server"] = json!("");
                next["kind"] = json!("");
            }
            util::atomic_json(&app.config_file, &next)?;
            *cfg = next;
            Ok(json(&json!({ "servers": cfg["servers"] })))
        }
        ("/api/sidecar/ssh", Method::GET) => Ok(json(&app.ssh.info().await)),
        ("/api/sidecar/ssh/add", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            let s = |k: &str| b[k].as_str().unwrap_or("").to_owned();
            let (host, path) = app.ssh.add(&s("address"), &s("key"), &s("name"), &app.machine.user, &[app.machine.host.clone()])?;
            save_ssh(app)?;
            Ok(json(&json!({ "host": host, "path": path })))
        }
        ("/api/sidecar/ssh/connect", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            let answers: ssh::Answers = serde_json::from_value(b.clone()).unwrap_or_default();
            match app.ssh.connect(b["name"].as_str().unwrap_or(""), answers, b["remember"] == true).await {
                Ok(host) => Ok(json(&json!({ "ok": true, "host": host }))),
                Err(r) => {
                    let (status, body) = r.answer();
                    Ok(util::json_status(&body, status))
                }
            }
        }
        ("/api/sidecar/ssh/disconnect", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            app.ssh.disconnect(b["name"].as_str().unwrap_or("")).await;
            Ok(json(&app.ssh.info().await))
        }
        ("/api/sidecar/ssh/forget", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            if !app.ssh.forget(b["name"].as_str().unwrap_or("")).await {
                return fail_at("no such SSH host", 404);
            }
            save_ssh(app)?;
            Ok(json(&app.ssh.info().await))
        }
        ("/api/sidecar/update", Method::GET) => Ok(json(&app.updates.info().await)),
        ("/api/sidecar/update", Method::POST) => {
            if app.native {
                match app.updates.check().await? {
                    Some(r) => Ok(json(&json!({ "ok": true, "version": r["version"], "file": "tauri-updater" }))),
                    None => fail_at(format!("Sulfur {} is the latest", app.updates.version), 409),
                }
            } else {
                Ok(json(&app.updates.stage().await?))
            }
        }
        ("/api/sidecar/update", _) => fail_at("method not allowed", 405),
        ("/api/sidecar/reveal", Method::POST) => {
            let b = body_json(req.into_body(), 64 << 10).await?;
            let file = b["path"].as_str().unwrap_or("");
            if !util::is_absolute_str(file) {
                return fail("a full path");
            }
            reveal(file)?;
            Ok(json(&json!({ "ok": true })))
        }
        _ => fail_at("no such call", 404),
    }
}

/// the saved SSH hosts written to the app's settings, never anything typed for them
fn save_ssh(app: &Arc<App>) -> Res<()> {
    let mut cfg = app.cfg.lock().unwrap();
    let mut next = cfg.clone();
    next["ssh"] = json!(app.ssh.specs());
    util::atomic_json(&app.config_file, &next)?;
    *cfg = next;
    Ok(())
}

/// a file shown in the system's own file manager
fn reveal(p: &str) -> Res<()> {
    let mut cmd = if cfg!(windows) {
        let mut c = util::hidden_std("explorer.exe");
        c.arg(format!("/select,{p}"));
        c
    } else if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.args(["-R", p]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        let target = if Path::new(p).is_dir() { PathBuf::from(p) } else { Path::new(p).parent().map(Path::to_path_buf).unwrap_or_else(|| p.into()) };
        c.arg(target);
        c
    };
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| Fail::new(e.to_string(), 500))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

async fn mesh_route(app: &Arc<App>, req: Request, upgrade: bool) -> Res<Response<Body>> {
    let server = app.cfg.lock().unwrap()["server"].as_str().unwrap_or("").to_owned();
    if server.is_empty() {
        return fail_at("no mesh to reach: connect to one once", 404);
    }
    let raw_path = req.uri().path().strip_prefix("/api/mesh").unwrap_or("/").to_owned();
    let pq = match req.uri().query() {
        Some(q) => format!("{raw_path}?{q}"),
        None => raw_path,
    };
    if upgrade {
        let target = mesh::socket_target(&server, &pq)?;
        let headers = req.headers().clone();
        let (mut parts, _) = req.into_parts();
        let up = WebSocketUpgrade::from_request_parts(&mut parts, &()).await.map_err(|_| Fail::new("upgrade failed", 400))?;
        return Ok(up
            .max_message_size(32 << 20)
            .on_upgrade(move |socket| mesh::proxy_socket(socket, target, headers)));
    }
    let (parts, body) = req.into_parts();
    mesh::proxy(&app.http, &server, &app.origin, parts.method, &pq, &parts.headers, body).await
}

async fn files_route(app: &Arc<App>, req: Request, op: &str, q: &HashMap<String, String>) -> Res<Response<Body>> {
    let share = q.get("share").cloned().unwrap_or_else(|| "0".into());
    let rel = q.get("path").cloned().unwrap_or_default();
    if op == "info" {
        return Ok(json(&app.machine.info()["files"]));
    }
    let quiet = query_has(&req, "quiet");
    let inline = query_has(&req, "inline");
    let files = &app.files;
    let method = req.method().clone();
    if method == Method::GET {
        let result = async {
            match op {
                "list" => Ok(json(&files.list(&share, &rel).await?)),
                "tree" => Ok(json(
                    &files
                        .tree(&share, &rel, q.get("depth").map(String::as_str).unwrap_or("1"), q.get("match").map(String::as_str).unwrap_or(""), q.get("skip").map(String::as_str).unwrap_or(""))
                        .await?,
                )),
                "search" => Ok(json(
                    &files
                        .search(
                            &share,
                            &rel,
                            q.get("query").map(String::as_str).unwrap_or(""),
                            q.get("content").map(String::as_str) == Some("true"),
                            q.get("glob").map(String::as_str).unwrap_or(""),
                            q.get("skip").map(String::as_str).unwrap_or(""),
                        )
                        .await?,
                )),
                "read" => Ok(json(&files.read(&share, &rel).await?)),
                "download" => download(files, &share, &rel, inline).await,
                _ => fail_at("method not allowed", 405),
            }
        }
        .await;
        return match result {
            Err(e) if quiet && e.missing => Ok(json(&json!({ "missing": true, "error": util::GONE }))),
            r => r,
        };
    }
    if method == Method::POST {
        if op == "upload" {
            let (id, offset, total) = (q.get("id").cloned(), q.get("offset").cloned(), q.get("total").cloned());
            return Ok(json(&files.upload(&share, &rel, req.into_body(), id.as_deref(), offset.as_deref(), total.as_deref()).await?));
        }
        let b = body_json(req.into_body(), 64 << 20).await?;
        if op == "save" {
            let path = b["path"].as_str().unwrap_or("").to_owned();
            return Ok(json(&app.collab.write(&share, &path, &b).await?));
        }
        return Ok(json(&files.mutate(&share, op, &b).await?));
    }
    fail_at("method not allowed", 405)
}

/// a file streamed as it is, as an attachment unless shown inline
async fn download(files: &Arc<Files>, share: &str, rel: &str, inline: bool) -> Res<Response<Body>> {
    let location = files.resolve(share, rel, false).await?;
    let file = tokio::fs::File::open(&location).await?;
    let meta = file.metadata().await?;
    if !meta.is_file() {
        return fail("not a file");
    }
    let name = location.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(attachment(file, meta.len(), &name, inline))
}

fn attachment<R: tokio::io::AsyncRead + Unpin + Send + 'static>(file: R, len: u64, name: &str, inline: bool) -> Response<Body> {
    let stream = futures_util::stream::unfold(file, |mut f| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 256 * 1024];
        match f.read(&mut buf).await {
            Ok(0) | Err(_) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, std::io::Error>(bytes::Bytes::from(buf)), f))
            }
        }
    });
    let mut r = Response::new(Body::from_stream(stream));
    let name = name.replace('"', "");
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(guess_type_static(&name)));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if !inline {
        let ascii: String = name.chars().map(|c| if c.is_ascii() && !c.is_control() { c } else { '_' }).collect();
        let encoded: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect::<String>().replace('+', "%20");
        if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    r
}

fn guess_type_static(name: &str) -> &'static str {
    match name.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("txt" | "md" | "log") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// a page's socket on one of this computer's live routes
async fn socket(app: &Arc<App>, req: Request, local: &str) -> Res<Response<Body>> {
    let q = query(&req);
    let route = if let Some(h) = local.strip_prefix("/api/code/").filter(|h| valid_host(h)) {
        if h != app.machine.host {
            return fail_at("not this computer", 404);
        }
        "collab"
    } else if let Some(h) = local.strip_prefix("/api/term/").filter(|h| valid_host(h)) {
        if h != app.machine.host {
            return fail_at("not this computer", 404);
        }
        let sid = q.get("sid").cloned().unwrap_or_default();
        if sid.is_empty() || sid.len() > 64 {
            return fail("invalid session");
        }
        "terminal"
    } else {
        match local {
            "/api/sulfur/languages" => "languages",
            "/api/sulfur/run" => "task",
            "/api/sulfur/extensions/host" => "extension",
            // git's prompts, for the page to answer (askpass.rs)
            "/api/sulfur/asks" => "asks",
            "/api/state" => "state",
            _ => return fail_at("no such socket", 404),
        }
    };
    let auto = query_has(&req, "auto");
    let (mut parts, _) = req.into_parts();
    let up = WebSocketUpgrade::from_request_parts(&mut parts, &()).await.map_err(|_| Fail::new("upgrade failed", 400))?;
    let app = app.clone();
    Ok(up.max_message_size(32 << 20).on_upgrade(move |socket| async move {
        let (ws, mut rx) = Ws::start(socket);
        let languages = route == "languages";
        let failed = |ws: &Ws, e: &Fail| {
            let msg = if languages {
                json!({ "_sulfur": "error", "error": e.message })
            } else {
                json!({ "type": "error", "error": e.message })
            };
            ws.json(&msg);
            ws.close(1000);
        };
        match route {
            "collab" => serve_collab(&app.collab, &ws, &mut rx, &q).await,
            "terminal" => serve_term(&app.terms, &ws, &mut rx, &q, auto).await,
            "asks" => {
                app.asks.attach(&ws);
                while let Some(f) = next_frame(&mut rx).await {
                    if let Frame::Text(t) = f {
                        app.asks.message(&t);
                    }
                }
                app.asks.detach(&ws);
            }
            "task" => {
                let mut task: Option<Arc<processes::Pty>> = None;
                while let Some(f) = next_frame(&mut rx).await {
                    let done = (|| -> Res<()> {
                        match f {
                            Frame::Binary(b) => {
                                if let Some(t) = &task {
                                    t.input(&b);
                                }
                            }
                            Frame::Text(text) => {
                                let v: Value = serde_json::from_str(&text)?;
                                match &task {
                                    None => {
                                        let spec = serde_json::from_value(v["task"].clone()).ok();
                                        task = Some(processes::task_start(&ws, spec)?);
                                    }
                                    Some(t) => match v["type"].as_str() {
                                        Some("resize") => t.resize(v["cols"].as_f64().unwrap_or(0.0), v["rows"].as_f64().unwrap_or(0.0)),
                                        Some("kill") => t.stop(),
                                        _ => {}
                                    },
                                }
                            }
                        }
                        Ok(())
                    })();
                    if let Err(e) = done {
                        failed(&ws, &e);
                    }
                }
                if let Some(t) = task {
                    t.stop();
                }
            }
            "languages" => {
                let out = {
                    let (a, b) = (ws.clone(), ws.clone());
                    languages::Out { send: Arc::new(move |s| a.text(s)), close: Arc::new(move || b.close(1000)) }
                };
                let Some(Frame::Text(first)) = next_frame(&mut rx).await else { return };
                let request: Value = match serde_json::from_str(&first) {
                    Ok(v) => v,
                    Err(_) => return failed(&ws, &Fail::new("invalid json", 400)),
                };
                let served = if request["op"] == "launch" {
                    app.languages.serve(&out, &request).await
                } else {
                    // an install ends with its page: its downloads and installers stopped
                    tokio::select! {
                        r = app.languages.serve(&out, &request) => r,
                        _ = async { while next_frame(&mut rx).await.is_some() {} } => Ok(None),
                    }
                };
                let lsp = match served {
                    Ok(Some(l)) => l,
                    Ok(None) => return,
                    Err(e) => return failed(&ws, &e),
                };
                while let Some(f) = next_frame(&mut rx).await {
                    let text = match f {
                        Frame::Text(t) => t,
                        Frame::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    };
                    if let Err(e) = languages::lsp_message(&lsp, &text).await {
                        failed(&ws, &e);
                        break;
                    }
                }
                lsp.stop();
            }
            "extension" => {
                let mut ext: Option<Arc<extensions::Extension>> = None;
                while let Some(f) = next_frame(&mut rx).await {
                    let text = match f {
                        Frame::Text(t) => t,
                        Frame::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    };
                    match &ext {
                        Some(x) => x.send(&text).await,
                        None => match extensions::start(&ws, &text, &app.files, asset_bytes("sulfur-extension-host.mjs").as_deref()).await {
                            Ok(x) => ext = Some(x),
                            Err(e) => failed(&ws, &e),
                        },
                    }
                }
                if let Some(x) = ext {
                    x.stop();
                }
            }
            _ => {
                ws.json(&json!({
                    "self": { "host": app.machine.host },
                    "peers": [{ "name": app.machine.host, "online": true }],
                    "hosts": { app.machine.host.clone(): app.machine.info() },
                }));
                while next_frame(&mut rx).await.is_some() {}
            }
        }
    }))
}

/// a socket's refusal told the page, then the socket ended
fn socket_failed(ws: &Ws, e: &Fail) {
    ws.json(&json!({ "type": "error", "error": e.message }));
    ws.close(1000);
}

type FrameStream = futures_util::stream::SplitStream<axum::extract::ws::WebSocket>;

/// a page editing one file, in its live session (this computer's or an SSH host's)
async fn serve_collab(collab: &Arc<collab::Collab>, ws: &Ws, rx: &mut FrameStream, q: &HashMap<String, String>) {
    let share = q.get("share").cloned().unwrap_or_else(|| "0".into());
    let path = q.get("path").cloned().unwrap_or_default();
    let (s, me) = match collab.attach(ws, &share, &path).await {
        Ok(v) => v,
        Err(e) => return socket_failed(ws, &e),
    };
    while let Some(f) = next_frame(rx).await {
        let text = match f {
            Frame::Text(t) => t,
            Frame::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
        };
        if let Err(e) = collab.message(&s, me, ws, &text).await {
            socket_failed(ws, &e);
        }
    }
    collab.close(&s, me).await;
}

/// a page's terminal, its shell kept for its return
async fn serve_term(terms: &Arc<processes::Terminals>, ws: &Ws, rx: &mut FrameStream, q: &HashMap<String, String>, auto: bool) {
    let since = q.get("since").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let mut t = processes::TermSocket::new(q.get("sid").cloned().unwrap_or_default(), auto);
    terms.attach(ws, &mut t, since);
    while let Some(f) = next_frame(rx).await {
        if let Err(e) = terms.message(ws, &mut t, f).await {
            socket_failed(ws, &e);
        }
    }
    terms.close(ws, &t);
}

/// a saved SSH host's API, as a mesh host's: /api/ssh/<name>/api/files/<name>/…,
/// /api/code/<name> and /api/term/<name> sockets, /api/sulfur/git, run and toolchains
async fn ssh_route(app: &Arc<App>, req: Request, rest: &str, upgrade: bool) -> Res<Response<Body>> {
    let (name, api) = rest.split_once('/').unwrap_or((rest, ""));
    let (name, api) = (name.to_owned(), format!("/{api}"));
    if !valid_host(&name) || app.ssh.find(&name).is_none() {
        return fail_at(format!("no SSH host named {name}"), 404);
    }
    let remote = app.ssh.get(&name).await?;
    let q = query(&req);
    if upgrade {
        let route = if api == format!("/api/code/{name}") {
            "collab"
        } else if api == format!("/api/term/{name}") {
            let sid = q.get("sid").cloned().unwrap_or_default();
            if sid.is_empty() || sid.len() > 64 {
                return fail("invalid session");
            }
            "terminal"
        } else if api == "/api/sulfur/run" {
            "task"
        } else {
            return fail_at(format!("an SSH host has no {api} socket"), 404);
        };
        let auto = query_has(&req, "auto");
        let (mut parts, _) = req.into_parts();
        let up = WebSocketUpgrade::from_request_parts(&mut parts, &()).await.map_err(|_| Fail::new("upgrade failed", 400))?;
        return Ok(up.max_message_size(32 << 20).on_upgrade(move |socket| async move {
            let (ws, mut rx) = Ws::start(socket);
            match route {
                "collab" => serve_collab(&remote.collab, &ws, &mut rx, &q).await,
                "terminal" => serve_term(&remote.terms, &ws, &mut rx, &q, auto).await,
                _ => {
                    let mut task: Option<Arc<dyn processes::Proc>> = None;
                    while let Some(f) = next_frame(&mut rx).await {
                        match f {
                            Frame::Binary(b) => {
                                if let Some(t) = &task {
                                    t.input(&b);
                                }
                            }
                            Frame::Text(text) => {
                                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                                match &task {
                                    None => match remote.task(&ws, serde_json::from_value(v["task"].clone()).ok()).await {
                                        Ok(t) => task = Some(t),
                                        Err(e) => socket_failed(&ws, &e),
                                    },
                                    Some(t) => match v["type"].as_str() {
                                        Some("resize") => t.resize(v["cols"].as_f64().unwrap_or(0.0), v["rows"].as_f64().unwrap_or(0.0)),
                                        Some("kill") => t.stop(),
                                        _ => {}
                                    },
                                }
                            }
                        }
                    }
                    if let Some(t) = task {
                        t.stop();
                    }
                }
            }
        }));
    }
    let method = req.method().clone();
    match (api.as_str(), &method) {
        ("/api/sulfur/git", &Method::POST) => {
            let p: processes::GitRequest = serde_json::from_value(body_json(req.into_body(), 1 << 20).await?)?;
            return Ok(json(&remote.git(p).await?));
        }
        ("/api/sulfur/toolchains", _) => return Ok(json(&remote.toolchains(q.contains_key("fresh")).await)),
        _ => {}
    }
    let Some(op) = api.strip_prefix(&format!("/api/files/{name}/")).map(str::to_owned) else {
        return fail_at(format!("an SSH host has no {api}"), 404);
    };
    let files = &remote.files;
    let share = q.get("share").cloned().unwrap_or_else(|| "0".into());
    let rel = q.get("path").cloned().unwrap_or_default();
    let g = |k: &str| q.get(k).cloned().unwrap_or_default();
    let (quiet, inline) = (query_has(&req, "quiet"), query_has(&req, "inline"));
    if method == Method::GET {
        let result = match op.as_str() {
            "info" => Ok(json(&remote.info["files"])),
            "list" => files.list(&share, &rel).await.map(|v| json(&v)),
            "tree" => files.tree(&share, &rel, q.get("depth").map(String::as_str).unwrap_or("1"), &g("match"), &g("skip")).await.map(|v| json(&v)),
            "search" => files.search(&share, &rel, &g("query"), g("content") == "true", &g("glob"), &g("skip")).await.map(|v| json(&v)),
            "read" => files.read(&share, &rel).await.map(|v| json(&v)),
            "download" => files.open(&share, &rel).await.map(|(f, len, file)| attachment(Box::pin(f), len, &file, inline)),
            _ => fail_at("method not allowed", 405),
        };
        return match result {
            Err(e) if quiet && e.missing => Ok(json(&json!({ "missing": true, "error": util::GONE }))),
            r => r,
        };
    }
    if method == Method::POST {
        if op == "upload" {
            let (id, offset, total) = (q.get("id").cloned(), q.get("offset").cloned(), q.get("total").cloned());
            return Ok(json(&files.upload(&share, &rel, req.into_body(), id.as_deref(), offset.as_deref(), total.as_deref()).await?));
        }
        let b = body_json(req.into_body(), 64 << 20).await?;
        if op == "save" {
            let path = b["path"].as_str().unwrap_or("").to_owned();
            return Ok(json(&remote.collab.write(&share, &path, &b).await?));
        }
        if ["mkdir", "rename", "delete"].contains(&op.as_str()) {
            return Ok(json(&files.mutate(&share, &op, &b).await?));
        }
    }
    fail_at("method not allowed", 405)
}

#[cfg(test)]
mod tests;

