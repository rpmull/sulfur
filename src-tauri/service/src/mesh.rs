//! A linked mesh's API under /api/mesh/: its requests and sockets passed through
//! as if its server were this page's own, its cookies kept by this origin.
use std::{sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::ws::{CloseFrame, Message as PageMessage, WebSocket},
    http::{HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{
    self,
    client::IntoClientRequest,
    protocol::{frame::coding::CloseCode, CloseFrame as UpCloseFrame, WebSocketConfig},
    Message as UpMessage,
};
use url::Url;

use crate::util::{fail, Fail, Res};

/// a mesh kind: the services it implements, beyond being reachable
pub struct Provider {
    pub kind: &'static str,
    pub version: u32,
    pub caps: &'static [&'static str],
}

pub const PROVIDERS: &[Provider] = &[Provider {
    kind: "phosphorus",
    version: 1,
    caps: &[
        "hosts", "files", "home", "sessions", "terminals", "toolchains", "runs", "languages", "git", "sqlite", "vsx",
        "people", "agents", "models", "forgejo",
    ],
}];

pub fn provider(kind: &str) -> Res<&'static Provider> {
    let kind = if kind.is_empty() { "phosphorus" } else { kind };
    PROVIDERS.iter().find(|p| p.kind == kind).ok_or_else(|| Fail::new("unknown mesh kind", 400))
}

pub fn mesh_info(kind: &str) -> Value {
    match provider(kind) {
        Ok(p) => json!({ "kind": p.kind, "version": p.version, "caps": p.caps }),
        Err(_) => Value::Null,
    }
}

/// what's typed as a server: a bare tailnet name or address taken as http, a
/// bare domain (mulab.dev) as https, through the mesh's public side
pub fn server_url(input: &str) -> Res<String> {
    let mut value = input.trim().to_owned();
    let bad = || Fail::new("that isn't a host name or address", 400);
    if value.is_empty() {
        return Err(bad());
    }
    if !value.contains("://") {
        let host = regex::Regex::new(r":\d+$").unwrap().replace(&value, "").into_owned();
        let ipv4 = regex::Regex::new(r"^\d+\.\d+\.\d+\.\d+$").unwrap().is_match(&host);
        let https = host.contains('.') && !ipv4 && !host.to_lowercase().ends_with(".ts.net");
        value = format!("{}{value}", if https { "https://" } else { "http://" });
    }
    let url = Url::parse(&value).map_err(|_| bad())?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none_or(str::is_empty) {
        return Err(bad());
    }
    Ok(url.origin().ascii_serialization())
}

/// whether the server answers at all, said plainly when it doesn't
pub async fn reach(server: &str) -> Res<()> {
    let url = Url::parse(server).map_err(|_| Fail::new("that isn't a host name or address", 400))?;
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = url.port_or_known_default().unwrap_or(80);
    let connect = tokio::net::TcpStream::connect((host.as_str(), port));
    match tokio::time::timeout(Duration::from_secs(5), connect).await {
        Ok(Ok(_)) => Ok(()),
        _ if url.scheme() == "https" => Err(Fail::new(
            format!("{} didn't answer: is the address right, and this computer online?", url.authority()),
            502,
        )),
        _ => Err(Fail::new(
            format!(
                "{} didn't answer: is this computer on your tailnet, and Phosphorus running there? Off the tailnet, use your mesh's own address, like https://mulab.dev",
                url.authority()
            ),
            502,
        )),
    }
}

/// a server's cookie as plain http on 127.0.0.1 keeps it
pub fn local_cookie(c: &str) -> String {
    let attrs = regex::Regex::new(r"(?i);\s*(secure|domain=[^;]*|partitioned)\s*").unwrap();
    let c = attrs.replace_all(c, "");
    regex::Regex::new(r"(?i)samesite=none").unwrap().replace_all(&c, "SameSite=Lax").into_owned()
}

const HOP: &[&str] = &[
    "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade",
];

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("an HTTP client")
}

/// one request through to the mesh, its answer streamed back
pub async fn proxy(
    http: &reqwest::Client,
    server: &str,
    origin: &str,
    method: Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: Body,
) -> Res<Response<Body>> {
    let target = Url::parse(server)
        .and_then(|u| u.join(path_and_query))
        .map_err(|_| Fail::new("invalid mesh address", 400))?;
    let mut out = reqwest::header::HeaderMap::new();
    for (k, v) in headers {
        if HOP.contains(&k.as_str()) {
            continue;
        }
        out.append(k.clone(), v.clone());
    }
    let target_origin = target.origin().ascii_serialization();
    if out.contains_key("origin") {
        out.insert("origin", HeaderValue::from_str(&target_origin).map_err(|_| Fail::new("bad origin", 400))?);
    }
    if let Some(referer) = headers.get("referer").and_then(|r| r.to_str().ok()) {
        if let Some(rest) = referer.strip_prefix(origin) {
            if let Ok(v) = HeaderValue::from_str(&format!("{target_origin}{rest}")) {
                out.insert("referer", v);
            }
        }
    }
    let mut req = http.request(method.clone(), target.clone()).headers(out);
    if method != Method::GET && method != Method::HEAD {
        req = req.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    let upstream = req.send().await.map_err(|e| {
        let why = Fail::from(e).message;
        Fail::new(format!("{} didn't answer: {why}", target.authority()), 502)
    })?;
    let mut res = Response::builder().status(StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    let h = res.headers_mut().expect("a response under construction");
    for (k, v) in upstream.headers() {
        let name = k.as_str();
        if name == "set-cookie" || name == "transfer-encoding" || name == "connection" || name == "keep-alive" {
            continue;
        }
        if name == "location" {
            if let Some(rest) = v.to_str().ok().and_then(|l| l.strip_prefix(server)) {
                if let Ok(v) = HeaderValue::from_str(rest) {
                    h.append(k.clone(), v);
                    continue;
                }
            }
        }
        h.append(HeaderName::from(k), v.clone());
    }
    for cookie in upstream.headers().get_all("set-cookie") {
        if let Ok(v) = HeaderValue::from_str(&local_cookie(&String::from_utf8_lossy(cookie.as_bytes()))) {
            h.append("set-cookie", v);
        }
    }
    res.body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|e| Fail::new(e.to_string(), 502))
}

/// a page's socket joined to the mesh's: frames both ways, close codes kept
pub async fn proxy_socket(page: WebSocket, target: String, headers: HeaderMap) {
    let (mut page_tx, mut page_rx) = page.split();
    let upstream = match connect(&target, &headers).await {
        Ok(s) => s,
        Err(e) => {
            let _ = page_tx.send(PageMessage::Text(json!({ "type": "error", "error": e.message }).to_string().into())).await;
            let _ = page_tx.send(PageMessage::Close(Some(CloseFrame { code: 1011, reason: "".into() }))).await;
            return;
        }
    };
    let (mut up_tx, mut up_rx) = upstream.split();
    let down = async {
        while let Some(m) = up_rx.next().await {
            let out = match m {
                Ok(UpMessage::Text(t)) => PageMessage::Text(t.as_str().into()),
                Ok(UpMessage::Binary(b)) => PageMessage::Binary(b),
                Ok(UpMessage::Close(frame)) => {
                    let code = frame.map(|f| u16::from(f.code)).unwrap_or(1005);
                    let code = if [1005, 1006, 1015].contains(&code) { 1011 } else { code };
                    let _ = page_tx.send(PageMessage::Close(Some(CloseFrame { code, reason: "".into() }))).await;
                    return;
                }
                Ok(_) => continue,
                Err(_) => {
                    let _ = page_tx.send(PageMessage::Close(Some(CloseFrame { code: 1011, reason: "".into() }))).await;
                    return;
                }
            };
            if page_tx.send(out).await.is_err() {
                return;
            }
        }
        let _ = page_tx.send(PageMessage::Close(Some(CloseFrame { code: 1011, reason: "".into() }))).await;
    };
    let up = async {
        while let Some(m) = page_rx.next().await {
            let out = match m {
                Ok(PageMessage::Text(t)) => UpMessage::Text(t.as_str().into()),
                Ok(PageMessage::Binary(b)) => UpMessage::Binary(b),
                Ok(PageMessage::Close(frame)) => {
                    let code = frame.map(|f| f.code).filter(|c| ![1005, 1006, 1015].contains(c)).unwrap_or(1000);
                    let _ = up_tx.send(UpMessage::Close(Some(UpCloseFrame { code: CloseCode::from(code), reason: "".into() }))).await;
                    return;
                }
                Ok(_) => continue,
                Err(_) => break,
            };
            if up_tx.send(out).await.is_err() {
                return;
            }
        }
        let _ = up_tx.send(UpMessage::Close(None)).await;
    };
    tokio::select! {
        _ = down => {}
        _ = up => {}
    }
}

type Upstream = tokio_tungstenite::WebSocketStream<Box<dyn Stream>>;
pub trait Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Stream for T {}

fn tls() -> Arc<rustls::ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            use rustls_platform_verifier::BuilderVerifierExt;
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let config = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .and_then(|b| b.with_platform_verifier())
                .map(|b| b.with_no_client_auth())
                .expect("the system's certificate verifier");
            Arc::new(config)
        })
        .clone()
}

async fn connect(target: &str, headers: &HeaderMap) -> Res<Upstream> {
    let url = Url::parse(target).map_err(|_| Fail::new("invalid mesh address", 400))?;
    let host = url.host_str().unwrap_or("").to_owned();
    let port = url.port_or_known_default().unwrap_or(80);
    let mut request = target.into_client_request().map_err(|e| Fail::new(e.to_string(), 400))?;
    for (k, v) in headers {
        let name = k.as_str();
        if HOP.contains(&name) || name.starts_with("sec-websocket-") || name == "origin" {
            continue;
        }
        request.headers_mut().append(k.clone(), v.clone());
    }
    let origin = url.origin().ascii_serialization().replacen("ws", "http", 1);
    if let Ok(v) = HeaderValue::from_str(&origin) {
        request.headers_mut().insert("origin", v);
    }
    let tcp = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect((host.trim_start_matches('[').trim_end_matches(']'), port)),
    )
    .await
    .map_err(|_| Fail::new(format!("{host} didn't answer"), 502))?
    .map_err(|e| Fail::new(format!("{host} didn't answer: {e}"), 502))?;
    let _ = tcp.set_nodelay(true);
    let stream: Box<dyn Stream> = if url.scheme() == "wss" {
        let name = rustls::pki_types::ServerName::try_from(host.trim_start_matches('[').trim_end_matches(']').to_owned())
            .map_err(|_| Fail::new("invalid mesh host", 400))?;
        let tls = tokio_rustls::TlsConnector::from(tls())
            .connect(name, tcp)
            .await
            .map_err(|e| Fail::new(format!("{host}: {e}"), 502))?;
        Box::new(tls)
    } else {
        Box::new(tcp)
    };
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(32 << 20);
    let (ws, _) = tokio_tungstenite::client_async_with_config(request, stream, Some(config))
        .await
        .map_err(|e| match e {
            tungstenite::Error::Http(r) => Fail::new(format!("the mesh refused the socket ({})", r.status()), 502),
            e => Fail::new(e.to_string(), 502),
        })?;
    Ok(ws)
}

/// the mesh socket's address for a page path under /api/mesh/
pub fn socket_target(server: &str, path_and_query: &str) -> Res<String> {
    let mut url = Url::parse(server).and_then(|u| u.join(path_and_query)).map_err(|_| Fail::new("invalid mesh address", 400))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    if url.set_scheme(scheme).is_err() {
        return fail("invalid mesh address");
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_addresses_and_cookies() {
        assert_eq!(server_url("example.com").unwrap(), "https://example.com");
        assert_eq!(server_url("workstation").unwrap(), "http://workstation");
        assert_eq!(server_url("node.ts.net").unwrap(), "http://node.ts.net");
        assert_eq!(server_url("10.0.0.2:8080").unwrap(), "http://10.0.0.2:8080");
        assert_eq!(server_url("https://mesh.dev/x?y").unwrap(), "https://mesh.dev");
        assert!(server_url("ftp://x").is_err());
        assert!(server_url(" ").is_err());
        assert_eq!(
            local_cookie("phosphorus=session; Secure; Domain=mesh.test; SameSite=None"),
            "phosphorus=session; SameSite=Lax"
        );
        assert!(mesh_info("").get("caps").unwrap().as_array().unwrap().contains(&json!("home")));
        assert!(provider("unknown").is_err());
        assert_eq!(socket_target("https://m.dev", "/api/state?x=1").unwrap(), "wss://m.dev/api/state?x=1");
    }
}
