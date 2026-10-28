//! A converted Node extension in its own process: the Node.js (or Bun) on PATH
//! runs Sulfur's extension host script, the page's VS Code bridge on the other
//! end of the socket. It has the user's filesystem and process permissions.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::{oneshot, Mutex},
};

use crate::{
    files::Files,
    util::{canonical, fail, hidden, home_dir, inside, read_json, safe_path, which, Fail, Res},
    ws::Ws,
};

/// the JavaScript runtime extensions run on: Node.js first, Bun as well
pub fn runtime() -> Option<PathBuf> {
    which("node").or_else(|| which("bun"))
}

/// the host script on disk: the build's bundle, written once beside the extensions
fn host_script(bundle: Option<&[u8]>) -> Res<PathBuf> {
    if let Some(data) = bundle {
        let hash = crate::registry::sha256_hex(data);
        let dir = home_dir().join(".sulfur/runtime");
        let file = dir.join(format!("extension-host-{}.mjs", &hash[..16]));
        if !file.exists() {
            std::fs::create_dir_all(&dir)?;
            let temp = dir.join(format!(".{}.tmp", crate::util::random_id()));
            std::fs::write(&temp, data)?;
            std::fs::rename(&temp, &file)?;
        }
        return Ok(file);
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/extension-host.js");
    if dev.exists() {
        return Ok(dev);
    }
    fail("This build has no extension host script")
}

pub struct Extension {
    stdin: Mutex<Option<ChildStdin>>,
    stop: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl Extension {
    pub async fn send(&self, line: &str) {
        let mut guard = self.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                *guard = None;
            }
        }
    }
    pub fn stop(&self) {
        if let Some(s) = self.stop.lock().unwrap().take() {
            let _ = s.send(());
        }
    }
}

pub async fn start(ws: &Ws, text: &str, files: &Arc<Files>, bundle: Option<&[u8]>) -> Res<Arc<Extension>> {
    let mut message: Value = serde_json::from_str(text).map_err(|_| Fail::new("invalid extension initialization", 400))?;
    let path = message["context"]["extensionPath"].as_str().unwrap_or("").to_owned();
    if message["t"] != "init" || path.is_empty() {
        return fail("invalid extension initialization");
    }
    let root = files.resolve("home", &path, false).await?;
    let allowed = home_dir().join(".sulfur/extensions");
    let real = canonical(&root)?;
    if !inside(&canonical(&allowed)?, &real) {
        return fail("extension is not installed in the local extension directory");
    }
    let manifest = read_json(&real.join("package.json")).unwrap_or(Value::Null);
    if manifest["sulfur"]["vscode"]["runtime"] != "bun" {
        return fail("this extension does not use the native JavaScript runtime");
    }
    let main = safe_path(&real, manifest["main"].as_str().unwrap_or(""), false)?;
    let loc = &message["context"]["workspaceLocation"];
    if let Some(host) = loc["host"].as_str().filter(|h| !h.is_empty() && *h != "*") {
        if host != files.machine.host {
            return fail("A native workspace extension needs a JS host on the project machine");
        }
    }
    let workspace = files
        .resolve(loc["share"].as_str().filter(|s| !s.is_empty()).unwrap_or("home"), message["context"]["workspace"].as_str().unwrap_or(""), false)
        .await?;
    let shim = safe_path(&real, &format!("{}/node_modules/vscode", manifest["sulfur"]["vscode"]["root"].as_str().unwrap_or("vscode")), true)?;
    std::fs::create_dir_all(&shim)?;
    std::fs::write(shim.join("index.js"), "module.exports = globalThis.__sulfurVSCode;\n")?;
    std::fs::write(
        shim.join("package.json"),
        json!({ "name": "vscode", "version": "1.95.0", "type": "commonjs", "main": "index.js" }).to_string(),
    )?;
    let Some(node) = runtime() else {
        return fail("Node extensions run on Node.js: install Node.js 18 or newer and put it on PATH");
    };
    let script = host_script(bundle)?;
    let mut child = hidden(&node)
        .arg(&script)
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Fail::new(format!("couldn't start {}: {e}", node.display()), 500))?;
    let (stop_tx, stop_rx) = oneshot::channel();
    let ext = Arc::new(Extension { stdin: Mutex::new(child.stdin.take()), stop: std::sync::Mutex::new(Some(stop_tx)) });
    message["context"]["nativeHomeRoot"] = json!(files.share("home")?.root);
    message["context"]["nativeEntry"] = json!(main);
    message["context"]["nativeExtensionRoot"] = json!(real);
    ext.send(&message.to_string()).await;
    let stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let out = ws.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match lines.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if line.len() > 32 << 20 {
                        out.json(&json!({ "t": "fail", "e": "extension host output exceeds limit" }));
                        break;
                    }
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim_end_matches(['\n', '\r']);
                    if !text.is_empty() {
                        out.text(text.to_owned());
                    }
                }
            }
        }
    });
    let out = ws.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => out.json(&json!({
                    "t": "call", "id": -1, "m": "output.append",
                    "a": ["Runtime", String::from_utf8_lossy(&buf[..n])],
                })),
            }
        }
    });
    let out = ws.clone();
    let owner = ext.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            s = child.wait() => s.ok(),
            _ = stop_rx => {
                let _ = child.kill().await;
                None
            }
        };
        owner.stdin.lock().await.take();
        if let Some(code) = status.map(|s| crate::util::exit_code(&s)).filter(|c| *c != 0) {
            out.json(&json!({ "t": "fail", "e": format!("Extension host exited ({code})") }));
        }
        out.close(1000);
    });
    Ok(ext)
}
