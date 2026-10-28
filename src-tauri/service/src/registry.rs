//! Open VSX: its search with what each extension would convert to, and a
//! package fetched, checked against the registry's sha256 and converted.
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    util::{fail, Fail, Res},
    vsix,
};

pub fn registry_url() -> Res<String> {
    let raw = std::env::var("SULFUR_VSX_REGISTRY").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "https://open-vsx.org/api".into());
    let url = url::Url::parse(&raw).map_err(|_| Fail::new("invalid registry address", 400))?;
    if url.scheme() != "https" {
        return fail("Open VSX is reached over HTTPS only");
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(9))
            .user_agent("Sulfur-extensions")
            .connect_timeout(Duration::from_secs(20))
            .https_only(true)
            .build()
            .expect("an HTTP client")
    })
}

/// an HTTPS download of at most `limit` bytes
pub async fn https_get(raw: &str, limit: usize, timeout: Duration) -> Res<Vec<u8>> {
    let url = url::Url::parse(raw).map_err(|_| Fail::new(format!("invalid address: {raw}"), 400))?;
    if url.scheme() != "https" {
        return fail("downloads must use HTTPS");
    }
    let host = url.host_str().unwrap_or("").to_owned();
    let get = async {
        let res = http().get(url).header("Accept", "application/json, */*").send().await?;
        if !res.status().is_success() {
            return Err(Fail::new(format!("{host} answered {}", res.status().as_u16()), 502));
        }
        if res.content_length().is_some_and(|n| n as usize > limit) {
            return Err(Fail::new("request too large", 413));
        }
        let mut out = Vec::new();
        let mut body = res.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk?;
            if out.len() + chunk.len() > limit {
                return Err(Fail::new("request too large", 413));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    };
    tokio::time::timeout(timeout, get)
        .await
        .map_err(|_| Fail::new(format!("{host} took too long"), 504))?
}

pub async fn get_json(url: &str) -> Res<Value> {
    Ok(serde_json::from_slice(&https_get(url, 8 << 20, Duration::from_secs(120)).await?)?)
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// a package from the registry, checked against its sha256
pub async fn fetch_vsix(download: &str) -> Res<(Vec<u8>, String)> {
    let base = registry_url()?;
    if !download.starts_with(&format!("{base}/")) {
        return fail(format!("a package is fetched from {base} only"));
    }
    let mut url = url::Url::parse(download).map_err(|_| Fail::new("invalid package address", 400))?;
    if !url.path().ends_with(".vsix") {
        return fail("the registry package has no .vsix checksum location");
    }
    let data = https_get(download, 512 << 20, Duration::from_secs(600)).await?;
    let path = url.path().to_owned();
    url.set_path(&format!("{}.sha256", &path[..path.len() - 5]));
    let sum = sha256_hex(&data);
    let expected = String::from_utf8_lossy(&https_get(url.as_str(), 4096, Duration::from_secs(60)).await?)
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) || expected != sum {
        return fail("the package doesn't match the registry's sha256");
    }
    Ok((data, sum))
}

/// this computer as Open VSX names targets: win32-x64, darwin-arm64, linux-x64
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        a => a,
    };
    format!("{os}-{arch}")
}

pub fn pick_download(meta: &Value) -> (String, String) {
    for key in [platform().as_str(), "universal", "web"] {
        if let Some(d) = meta["downloads"][key].as_str() {
            return (d.to_owned(), key.to_owned());
        }
    }
    (
        meta["files"]["download"].as_str().unwrap_or("").to_owned(),
        meta["targetPlatform"].as_str().unwrap_or("").to_owned(),
    )
}

/// recent extensions' manifests, 128 or 16 MiB at most
struct Cache {
    order: VecDeque<String>,
    entries: HashMap<String, (usize, Value)>,
    bytes: usize,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache { order: VecDeque::new(), entries: HashMap::new(), bytes: 0 }))
}

async fn manifest_of(e: &Value) -> Res<Value> {
    let key = format!(
        "{}/{}/{}/{}",
        registry_url()?,
        e["namespace"].as_str().unwrap_or(""),
        e["name"].as_str().unwrap_or(""),
        e["version"].as_str().unwrap_or("")
    );
    {
        let mut c = cache().lock().unwrap();
        if let Some((_, m)) = c.entries.get(&key).cloned() {
            c.order.retain(|k| k != &key);
            c.order.push_back(key);
            return Ok(m);
        }
    }
    let meta = get_json(&key).await?;
    let manifest = match meta["files"]["manifest"].as_str() {
        Some(m) => serde_json::from_slice(&https_get(m, 4 << 20, Duration::from_secs(60)).await?)?,
        None => {
            let (data, _) = fetch_vsix(&pick_download(&meta).0).await?;
            vsix::open(&data)?.manifest
        }
    };
    let size = manifest.to_string().len();
    let mut c = cache().lock().unwrap();
    if !c.entries.contains_key(&key) {
        c.bytes += size;
        c.entries.insert(key.clone(), (size, manifest.clone()));
        c.order.push_back(key);
        while !c.order.is_empty() && (c.order.len() > 128 || c.bytes > 16 << 20) {
            if let Some(old) = c.order.pop_front() {
                if let Some((n, _)) = c.entries.remove(&old) {
                    c.bytes -= n;
                }
            }
        }
    }
    Ok(manifest)
}

pub async fn search(q: &HashMap<String, String>) -> Res<Value> {
    let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
    let size = get("size").parse::<f64>().ok().filter(|n| *n >= 1.0).map(|n| n.min(50.0) as u32).unwrap_or(20);
    let offset = get("offset").parse::<f64>().ok().filter(|n| *n > 0.0).map(|n| n as u64).unwrap_or(0);
    let query = {
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params
        .append_pair("query", get("q"))
        .append_pair("offset", &offset.to_string())
        .append_pair("size", &size.to_string())
        .append_pair("includeAllVersions", "false");
    let sort = match get("sort") {
        "relevance" => "relevance",
        "downloads" => "downloadCount",
        "rating" => "averageRating",
        "updated" => "timestamp",
        _ if get("q").is_empty() => "downloadCount",
        _ => "",
    };
    if !sort.is_empty() {
        params.append_pair("sortBy", sort).append_pair("sortOrder", "desc");
    }
    if !get("category").is_empty() {
        params.append_pair("category", get("category"));
    }
    params.finish()
    };
    let mut page = get_json(&format!("{}/-/search?{query}", registry_url()?)).await?;
    let extensions = page["extensions"].as_array().cloned().unwrap_or_default();
    let planned = futures_util::stream::iter(extensions.into_iter().map(|mut e| async move {
        e["icon"] = json!(e["files"]["icon"].as_str().unwrap_or(""));
        e["plan"] = json!([]);
        match tokio::time::timeout(Duration::from_secs(6), manifest_of(&e)).await {
            Ok(Ok(m)) => {
                e["plan"] = json!(vsix::plan(&m));
                e["manifest"] = json!({
                    "name": m["name"],
                    "publisher": m["publisher"],
                    "version": m["version"],
                    "displayName": m["displayName"],
                    "contributes": m["contributes"],
                    "extensionDependencies": m["extensionDependencies"],
                    "extensionPack": m["extensionPack"],
                });
            }
            Ok(Err(err)) => e["planError"] = json!(err.message),
            Err(_) => e["planError"] = json!("The operation timed out."),
        }
        e
    }))
    .buffered(8)
    .collect::<Vec<_>>()
    .await;
    Ok(json!({ "offset": page["offset"].take(), "totalSize": page["totalSize"].take(), "extensions": planned }))
}

pub async fn convert(request: &Value) -> Res<Value> {
    let field = |k: &str| request[k].as_str().unwrap_or("").to_owned();
    for k in ["namespace", "name", "version"] {
        let v = field(k);
        if !v.is_empty() && !(v.len() <= 128 && v.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))) {
            return fail(format!("invalid {k}"));
        }
    }
    let parts: Vec<String> = ["namespace", "name", "version"]
        .iter()
        .map(|k| field(k))
        .filter(|v| !v.is_empty())
        .map(|v| url::form_urlencoded::byte_serialize(v.as_bytes()).collect())
        .collect();
    let meta = get_json(&format!("{}/{}", registry_url()?, parts.join("/"))).await?;
    if let Some(e) = meta["error"].as_str() {
        return fail(e.to_owned());
    }
    let (download, target) = pick_download(&meta);
    if download.is_empty() {
        return fail(format!("{}.{} has nothing to download", field("namespace"), field("name")));
    }
    if !target.is_empty() && ![platform().as_str(), "universal", "web"].contains(&target.as_str()) {
        return fail(format!("no package for {} (the registry offered {target})", platform()));
    }
    let (data, sum) = fetch_vsix(&download).await?;
    let source = json!({
        "registry": registry_url()?,
        "namespace": meta["namespace"],
        "name": meta["name"],
        "version": meta["version"],
        "download": download,
        "targetPlatform": target,
        "sha256": sum,
    });
    let commands: Vec<String> = match &request["commands"] {
        Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        Value::Object(o) => o.keys().cloned().collect(),
        _ => vec![],
    };
    let mut result = tokio::task::spawn_blocking(move || {
        let mut r = vsix::convert(&data, source, &vsix::Options { commands, prefer_node: false })?;
        crate::bundle::bundle_browser_extension(&mut r)?;
        Res::Ok(r)
    })
    .await??;
    let downloads = if meta["downloads"].is_object() { meta["downloads"].clone() } else { json!({ target: download }) };
    if let Some(servers) = result.manifest["contributes"]["languageServers"].as_array_mut() {
        for s in servers {
            s["downloads"] = downloads.clone();
        }
    }
    result.files.insert("package.json".into(), json!(format!("{}\n", serde_json::to_string_pretty(&result.manifest)?)));
    Ok(result.to_json())
}
