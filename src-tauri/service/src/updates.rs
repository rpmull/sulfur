//! Sulfur's own updates: the signed feed's newer release, checked against the
//! release key. The desktop app installs through Tauri's updater; a headless
//! service stages the verified package for a manual install.
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{
    registry::https_get,
    util::{fail_at, Fail, Res},
};

/// a key or signature as text, whether given whole, base64'd whole, or bare
fn unwrap(value: &str) -> Vec<String> {
    let mut s = value.trim().to_owned();
    if !s.starts_with("untrusted comment:") {
        if let Ok(decoded) = STANDARD.decode(s.as_bytes()) {
            let text = String::from_utf8_lossy(&decoded).into_owned();
            if text.starts_with("untrusted comment:") {
                s = text;
            }
        }
    }
    let mut lines: Vec<String> = s.replace("\r\n", "\n").trim().split('\n').map(str::to_owned).collect();
    if !lines[0].starts_with("untrusted comment:") {
        lines.insert(0, "untrusted comment:".into());
    }
    lines
}

pub fn verify_minisign(data: &[u8], signature: &str, key: &str) -> Res<()> {
    let bad = |m: &str| Fail::new(format!("minisign: {m}"), 400);
    let key = unwrap(key);
    let pk = minisign_verify::PublicKey::from_base64(key.get(1).map(String::as_str).unwrap_or(""))
        .map_err(|_| bad("malformed signature or another key"))?;
    let sig = minisign_verify::Signature::decode(&unwrap(signature).join("\n"))
        .map_err(|_| bad("malformed signature or another key"))?;
    pk.verify(data, &sig, true).map_err(|e| match e {
        minisign_verify::Error::UnexpectedKeyId => bad("malformed signature or another key"),
        _ => bad("bad signature"),
    })
}

/// whether version a is newer than b, part by numeric part
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| v.split('.').map(|x| x.parse::<f64>().unwrap_or(f64::NAN)).collect::<Vec<_>>();
    let (x, y) = (parse(a), parse(b));
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (x.get(i).copied().unwrap_or(0.0), y.get(i).copied().unwrap_or(0.0));
        if p != q {
            return p > q;
        }
    }
    false
}

pub struct Updates {
    pub version: String,
    url: String,
    key: String,
    busy: Mutex<()>,
}

pub fn target() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "aarch64" } else { "x86_64" };
    format!("{os}-{arch}")
}

impl Updates {
    pub fn new(version: &str) -> Updates {
        let url = std::env::var("SULFUR_UPDATE_FEED")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| option_env!("SULFUR_UPDATE_FEED").unwrap_or("").to_owned());
        let key = std::env::var("SULFUR_UPDATE_PUBKEY")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| option_env!("SULFUR_UPDATE_PUBKEY").unwrap_or("").to_owned());
        Updates { version: version.to_owned(), url, key, busy: Mutex::new(()) }
    }

    pub fn on(&self) -> bool {
        !self.url.is_empty() && !self.key.is_empty()
    }

    pub async fn check(&self) -> Res<Option<Value>> {
        if !self.on() {
            return Ok(None);
        }
        let url = format!("{}/sulfur-{}.json", self.url.trim_end_matches('/'), target());
        let release: Value = match https_get(&url, 8 << 20, Duration::from_secs(30)).await {
            Ok(b) => serde_json::from_slice(&b)?,
            Err(e) if e.message.ends_with("404") => return Ok(None),
            Err(e) => return Err(e),
        };
        let version = release["version"].as_str().unwrap_or("");
        Ok((release["url"].is_string() && newer(version, &self.version)).then_some(release))
    }

    pub async fn info(&self) -> Value {
        let mut out = json!({ "version": self.version, "on": self.on() });
        match self.check().await {
            Ok(Some(r)) => out["latest"] = r["version"].clone(),
            Ok(None) => {}
            Err(e) => out["error"] = json!(e.message),
        }
        out
    }

    /// the newer release downloaded and verified, left for the user to install
    pub async fn stage(&self) -> Res<Value> {
        let Ok(_busy) = self.busy.try_lock() else { return fail_at("already updating", 409) };
        let Some(release) = self.check().await? else {
            return fail_at(format!("Sulfur {} is the latest", self.version), 409);
        };
        let url = release["url"].as_str().unwrap_or("");
        let data = https_get(url, 1 << 30, Duration::from_secs(900)).await?;
        verify_minisign(&data, release["signature"].as_str().unwrap_or(""), &self.key)?;
        let dir = std::env::temp_dir().join(format!("sulfur-update-{}", crate::util::random_id()));
        std::fs::create_dir_all(&dir)?;
        let name = url::Url::parse(url)
            .ok()
            .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_owned)))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "sulfur-update".into());
        let file = dir.join(name);
        std::fs::write(&file, &data)?;
        Ok(json!({ "ok": true, "version": release["version"], "file": file, "prepared": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minisign_signatures_and_versions() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
        let data = std::fs::read(root.join("data.bin")).unwrap();
        let sig = std::fs::read_to_string(root.join("data.e.sig")).unwrap();
        let key = std::fs::read_to_string(root.join("e.pub")).unwrap();
        verify_minisign(&data, &sig, &key).unwrap();
        verify_minisign(&data, &STANDARD.encode(&sig), &STANDARD.encode(&key)).unwrap();
        verify_minisign(&data, &sig, key.lines().nth(1).unwrap()).unwrap();
        let mut changed = data.clone();
        changed.push(b'x');
        assert!(verify_minisign(&changed, &sig, &key).unwrap_err().message.contains("signature"));
        assert!(newer("1.108.0", "1.107"));
        assert!(!newer("1.107", "1.107.0"));
        assert!(newer("1.0.250", "1.0.243"));
    }
}
