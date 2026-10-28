//! The service end to end, on a loopback port of its own.
use super::*;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

fn machine(root: &Path) -> Machine {
    Machine {
        user: "me".into(),
        host: "test-machine".into(),
        platform: "linux".into(),
        shell: "sh".into(),
        shares: vec![files::Share { id: "0".into(), label: root.to_string_lossy().into(), root: root.into(), perms: "rwd".into(), home: false }],
    }
}

async fn service(root: &Path, config: Value) -> Service {
    let file = root.join("sulfur.json");
    std::fs::write(&file, config.to_string()).unwrap();
    start(Options { addr: "127.0.0.1:0".into(), config: Some(file), machine: Some(machine(root)), ..Default::default() }).await.unwrap()
}

/// a stand-in mesh: echoes what it was asked, sets a cross-site cookie, and echoes socket frames
async fn fake_mesh() -> String {
    use axum::{extract::ws::Message as M, routing::get};
    let app = Router::new()
        .route(
            "/api/state",
            get(|req: Request| async move {
                let origin = header_str(&req, header::ORIGIN).to_owned();
                let (mut parts, _) = req.into_parts();
                let up = WebSocketUpgrade::from_request_parts(&mut parts, &()).await.unwrap();
                if !origin.starts_with("http://127.0.0.1:") {
                    return text_response(StatusCode::FORBIDDEN, "bad origin");
                }
                up.on_upgrade(|mut s| async move {
                    while let Some(Ok(m)) = s.recv().await {
                        if let M::Text(_) | M::Binary(_) = m {
                            let _ = s.send(m).await;
                        }
                    }
                })
            }),
        )
        .route(
            "/api/compressed",
            get(|| async {
                let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                std::io::Write::write_all(&mut enc, br#"{"compressed":true}"#).unwrap();
                let mut r = Response::new(Body::from(enc.finish().unwrap()));
                r.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
                r
            }),
        )
        .fallback(|req: Request| async move {
            let body = json!({
                "path": req.uri().path(),
                "query": req.uri().query().map(|q| format!("?{q}")).unwrap_or_default(),
                "cookie": header_str(&req, header::COOKIE),
                "origin": header_str(&req, header::ORIGIN),
                "method": req.method().as_str(),
                "body": String::from_utf8_lossy(&read_body(req.into_body(), 1 << 20).await.unwrap()),
            });
            let mut r = json(&body);
            r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("phosphorus=session; Secure; Domain=mesh.test; SameSite=None"));
            r
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().no_gzip().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

async fn body(r: reqwest::Response) -> Value {
    serde_json::from_slice(&r.bytes().await.unwrap()).unwrap()
}

#[tokio::test]
async fn requests_are_held_to_the_page_and_the_mesh_is_passed_through() {
    let dir = tempfile::tempdir().unwrap();
    let mesh = fake_mesh().await;
    let svc = service(dir.path(), json!({ "server": mesh, "servers": [mesh], "custom": 1 })).await;
    let o = svc.origin.clone();
    let http = client();
    let info = body(http.get(format!("{o}/api/sidecar/info")).send().await.unwrap()).await;
    assert_eq!(info["app"], "sulfur");
    assert_eq!(info["host"], "test-machine");
    assert!(info["mesh"]["caps"].as_array().unwrap().contains(&json!("home")));
    assert_eq!(info["md"], "page");

    // another site's page, or another name for this server, is refused
    let foreign = http.post(format!("{o}/api/sidecar/mode")).body("{}").send().await.unwrap();
    assert_eq!(foreign.status(), 403);
    let renamed = http.get(format!("{o}/api/me")).header("host", "evil.test").send().await.unwrap();
    assert_eq!(renamed.status(), 421);

    let proxied = http
        .get(format!("{o}/api/mesh/api/files/mesh/list?share=home&path=shared"))
        .header("cookie", "phosphorus=session")
        .send()
        .await
        .unwrap();
    assert_eq!(proxied.headers()["set-cookie"], "phosphorus=session; SameSite=Lax");
    let v = body(proxied).await;
    assert_eq!(v["path"], "/api/files/mesh/list");
    assert_eq!(v["query"], "?share=home&path=shared");
    assert_eq!(v["cookie"], "phosphorus=session");
    let posted = http.post(format!("{o}/api/mesh/api/x")).header("origin", &o).body("payload").send().await.unwrap();
    let v = body(posted).await;
    assert_eq!(v["origin"], mesh);
    assert_eq!(v["body"], "payload");
    let packed = http.get(format!("{o}/api/mesh/api/compressed")).send().await.unwrap();
    assert_eq!(packed.headers()["content-encoding"], "gzip");
    let mut text = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&packed.bytes().await.unwrap()[..]), &mut text).unwrap();
    assert_eq!(text, r#"{"compressed":true}"#);

    let mut req = format!("{}/api/mesh/api/state", o.replace("http:", "ws:")).into_client_request().unwrap();
    req.headers_mut().insert("origin", HeaderValue::from_str(&o).unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(Message::Text("mesh-shared-home".into())).await.unwrap();
    let echoed = ws.next().await.unwrap().unwrap();
    assert_eq!(echoed.into_text().unwrap().as_str(), "mesh-shared-home");

    // forgetting the mesh keeps unknown settings
    let forgot = http.post(format!("{o}/api/sidecar/forget")).header("origin", &o).body(json!({ "server": mesh }).to_string()).send().await.unwrap();
    assert_eq!(body(forgot).await["servers"], json!([]));
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.path().join("sulfur.json")).unwrap()).unwrap();
    assert_eq!(saved["custom"], 1);
    assert_eq!(saved["server"], "");
    svc.stop().await;
}

#[tokio::test]
async fn files_and_terminals_over_the_wire() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
    let svc = service(dir.path(), json!({})).await;
    let o = svc.origin.clone();
    let http = client();
    let list = body(http.get(format!("{o}/api/local/api/files/test-machine/list?share=0&path=")).send().await.unwrap()).await;
    assert!(list["entries"].as_array().unwrap().iter().any(|e| e["name"] == "a.txt"));
    let quiet = body(http.get(format!("{o}/api/files/test-machine/read?share=0&path=gone.txt&quiet")).send().await.unwrap()).await;
    assert_eq!(quiet["missing"], true);
    let other = http.get(format!("{o}/api/files/other-host/list?share=0")).send().await.unwrap();
    assert_eq!(other.status(), 404);
    let down = http.get(format!("{o}/api/files/test-machine/download?share=0&path=a.txt")).send().await.unwrap();
    assert!(down.headers()["content-disposition"].to_str().unwrap().contains("a.txt"));
    assert_eq!(&down.bytes().await.unwrap()[..], b"hello");
    let saved = http
        .post(format!("{o}/api/files/test-machine/save?share=0"))
        .header("origin", &o)
        .body(json!({ "path": "b.txt", "text": "written" }).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(body(saved).await["ok"], true);
    assert_eq!(std::fs::read_to_string(dir.path().join("b.txt")).unwrap(), "written");
    assert_eq!(http.get(format!("{o}/api/nothing")).send().await.unwrap().status(), 404);
    let home = http.get(format!("{o}/")).send().await.unwrap();
    assert_eq!(home.status(), 302);

    if cfg!(unix) {
        let mut req = format!("{}/api/term/test-machine?sid=t1", o.replace("http:", "ws:")).into_client_request().unwrap();
        req.headers_mut().insert("origin", HeaderValue::from_str(&o).unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        ws.send(Message::Text(json!({ "type": "resize", "cols": 80, "rows": 24 }).to_string().into())).await.unwrap();
        ws.send(Message::Binary(b"echo sulfur-$((40+2))\r".to_vec().into())).await.unwrap();
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !seen.contains("sulfur-42") {
            let m = tokio::time::timeout_at(deadline, ws.next()).await.expect("terminal output").unwrap().unwrap();
            if let Message::Binary(b) = m {
                seen.push_str(&String::from_utf8_lossy(&b));
            }
        }
        ws.send(Message::Text(json!({ "type": "close" }).to_string().into())).await.unwrap();
    }
    svc.stop().await;
}

#[tokio::test]
async fn a_task_streams_and_reports_its_exit() {
    if !cfg!(unix) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let svc = service(dir.path(), json!({})).await;
    let o = svc.origin.clone();
    let mut req = format!("{}/api/sulfur/run", o.replace("http:", "ws:")).into_client_request().unwrap();
    req.headers_mut().insert("origin", HeaderValue::from_str(&o).unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let task = json!({ "task": { "command": "printf built; exit 3", "dir": dir.path() } });
    ws.send(Message::Text(task.to_string().into())).await.unwrap();
    let (mut out, mut code) = (String::new(), None);
    while let Some(Ok(m)) = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap() {
        match m {
            Message::Binary(b) => out.push_str(&String::from_utf8_lossy(&b)),
            Message::Text(t) => code = serde_json::from_str::<Value>(t.as_str()).ok().map(|v| v["code"].clone()),
            Message::Close(f) => {
                assert_eq!(f.map(|f| u16::from(f.code)), Some(4000));
                break;
            }
            _ => {}
        }
    }
    assert!(out.contains("built"));
    assert_eq!(code, Some(json!(3)));
    svc.stop().await;
}
