//! Git's and ssh's prompts (an SSH password, a key's passphrase, a host key to
//! accept, an HTTPS login), answered on the page. Git runs with Sulfur's own
//! executable as its askpass program; that program hands the prompt to this
//! service over loopback with its run's token, the service to every page
//! listening on /api/sulfur/asks, and the first answer goes back to ssh. With no
//! page listening nothing is asked and ssh fails at once instead of waiting.
//! Answers are kept only when the page says to, in memory, until Sulfur quits.
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, OnceCell},
};

use crate::ws::Ws;

/// the variable telling Sulfur's executable it runs as an askpass program: port:token
pub const ENV: &str = "SULFUR_ASKPASS";
/// how long a prompt waits for its answer on the page
const WAIT: Duration = Duration::from_secs(180);

static HELPER: OnceLock<PathBuf> = OnceLock::new();

/// the program ssh and git run for a prompt: the app's own executable, set by its main
pub fn set_helper(exe: PathBuf) {
    let _ = HELPER.set(exe);
}

pub fn helper() -> Option<&'static PathBuf> {
    HELPER.get()
}

/// run as an askpass program (ssh and git give the prompt as the one argument): the
/// prompt asked of the service that started git, its answer printed on stdout; None
/// when this process wasn't started as one
pub fn helper_main() -> Option<i32> {
    let spec = std::env::var(ENV).ok().filter(|s| !s.is_empty())?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() > 1 {
        return None;
    }
    let prompt = args.into_iter().next().unwrap_or_default();
    Some(match ask_service(&spec, &prompt) {
        Some(answer) => {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
            0
        }
        None => 1,
    })
}

fn ask_service(spec: &str, prompt: &str) -> Option<String> {
    let (port, token) = spec.split_once(':')?;
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().ok()?)).ok()?;
    let line = json!({ "token": token, "prompt": prompt }).to_string();
    s.write_all(format!("{line}\n").as_bytes()).ok()?;
    let mut answer = String::new();
    BufReader::new(s).read_line(&mut answer).ok()?;
    let v: Value = serde_json::from_str(&answer).ok()?;
    v["answer"].as_str().map(str::to_owned)
}

/// whether a prompt's answer is a secret the page masks: a password, passphrase or
/// code, never a yes/no or a user name
pub fn secret(prompt: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let p = prompt.to_lowercase();
    !p.contains("(yes/no")
        && RE
            .get_or_init(|| regex::Regex::new(r"password|passphrase|passcode|\bpin\b|token|verification code|one-time").unwrap())
            .is_match(&p)
}

#[derive(Default)]
struct Inner {
    pages: Vec<Ws>,
    pending: HashMap<String, oneshot::Sender<Option<(String, bool)>>>,
    /// each running git's token, and the prompts it was given from memory
    runs: HashMap<String, HashSet<String>>,
    /// answers the page asked to keep, by prompt, until Sulfur quits
    kept: HashMap<String, String>,
    seq: u64,
}

/// the prompts of git runs and the pages that answer them
#[derive(Default)]
pub struct Asks {
    inner: StdMutex<Inner>,
    port: OnceCell<Option<u16>>,
}

/// one git run's part in the asking: the variables that point its prompts here,
/// its token forgotten once it ends
pub struct Run {
    asks: Arc<Asks>,
    token: String,
    pub env: Vec<(String, String)>,
}

impl Drop for Run {
    fn drop(&mut self) {
        self.asks.inner.lock().unwrap().runs.remove(&self.token);
    }
}

/// a token nobody else can guess
fn token() -> String {
    use ring::rand::SecureRandom;
    let mut b = [0u8; 16];
    if ring::rand::SystemRandom::new().fill(&mut b).is_err() {
        return format!("{}{}", crate::util::random_id(), crate::util::random_id());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// the askpass program as ssh takes it: forward slashes, which the MSYS ssh in
/// Git for Windows reads as well as Windows' own
fn program(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s
    }
}

impl Asks {
    /// a page listening for prompts
    pub fn attach(&self, ws: &Ws) {
        self.inner.lock().unwrap().pages.push(ws.clone());
    }

    pub fn detach(&self, ws: &Ws) {
        self.inner.lock().unwrap().pages.retain(|p| p != ws);
    }

    pub fn listening(&self) -> bool {
        !self.inner.lock().unwrap().pages.is_empty()
    }

    /// a page's answer `{type:'answer', id, value, remember}` or `{type:'cancel', id}`
    pub fn message(&self, text: &str) {
        let Ok(m) = serde_json::from_str::<Value>(text) else { return };
        let id = m["id"].as_str().unwrap_or("").to_owned();
        let Some(tx) = self.inner.lock().unwrap().pending.remove(&id) else { return };
        let answer = match (m["type"].as_str(), m["value"].as_str()) {
            (Some("answer"), Some(v)) => Some((v.to_owned(), m["remember"] == true)),
            _ => None,
        };
        let _ = tx.send(answer);
    }

    /// a git run's prompts pointed here; None when nothing can answer them (no
    /// askpass program, or no page listening), so ssh is told not to ask
    pub async fn run(self: &Arc<Self>) -> Option<Run> {
        let exe = helper()?;
        if !self.listening() {
            return None;
        }
        let port = (*self.port.get_or_init(|| self.clone().listen()).await)?;
        let token = token();
        self.inner.lock().unwrap().runs.insert(token.clone(), HashSet::new());
        let exe = program(exe);
        Some(Run {
            asks: self.clone(),
            env: vec![
                ("SSH_ASKPASS".into(), exe.clone()),
                ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
                ("GIT_ASKPASS".into(), exe),
                (ENV.into(), format!("{port}:{token}")),
            ],
            token,
        })
    }

    async fn listen(self: Arc<Self>) -> Option<u16> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.ok()?;
        let port = listener.local_addr().ok()?.port();
        let weak = Arc::downgrade(&self);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let Some(asks) = weak.upgrade() else { break };
                tokio::spawn(async move { asks.serve(stream).await });
            }
        });
        Some(port)
    }

    /// one askpass program's prompt: its line read, its answer written back
    async fn serve(&self, stream: tokio::net::TcpStream) {
        let (read, mut write) = stream.into_split();
        let mut line = String::new();
        let mut reader = tokio::io::BufReader::new(read.take(64 << 10));
        let read = tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await;
        if !matches!(read, Ok(Ok(n)) if n > 0) {
            return;
        }
        let Ok(m) = serde_json::from_str::<Value>(&line) else { return };
        let (token, prompt) = (m["token"].as_str().unwrap_or(""), m["prompt"].as_str().unwrap_or(""));
        let answer = self.answer(token, prompt).await;
        let reply = match answer {
            Some(a) => json!({ "answer": a }),
            None => json!({}),
        };
        let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
    }

    /// a prompt's answer: kept from before (once per run, as a wrong one is asked
    /// again), else asked of every page; None if refused, unanswered or unknown
    pub async fn answer(&self, token: &str, prompt: &str) -> Option<String> {
        let (id, rx) = {
            let mut guard = self.inner.lock().unwrap();
            let g = &mut *guard;
            let given = g.runs.get_mut(token)?;
            if let Some(a) = g.kept.get(prompt).cloned() {
                if given.insert(prompt.to_owned()) {
                    return Some(a);
                }
                // asked again in the same run: the kept answer was refused
                g.kept.remove(prompt);
            }
            if g.pages.is_empty() {
                return None;
            }
            g.seq += 1;
            let id = format!("ask-{}", g.seq);
            let (tx, rx) = oneshot::channel();
            g.pending.insert(id.clone(), tx);
            let msg = json!({ "type": "ask", "id": id, "prompt": prompt, "secret": secret(prompt) });
            for p in &g.pages {
                p.json(&msg);
            }
            (id, rx)
        };
        let got = tokio::time::timeout(WAIT, rx).await.ok().and_then(Result::ok).flatten();
        let mut guard = self.inner.lock().unwrap();
        let g = &mut *guard;
        g.pending.remove(&id);
        for p in &g.pages {
            p.json(&json!({ "type": "done", "id": id }));
        }
        let (answer, remember) = got?;
        if remember {
            g.kept.insert(prompt.to_owned(), answer.clone());
            if let Some(given) = g.runs.get_mut(token) {
                given.insert(prompt.to_owned());
            }
        }
        Some(answer)
    }

    #[cfg(test)]
    fn register(&self, token: &str) {
        self.inner.lock().unwrap().runs.insert(token.into(), HashSet::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_masked_and_questions_are_not() {
        assert!(secret("rpm@172.18.220.63's password: "));
        assert!(secret("Enter passphrase for key '/home/u/.ssh/id_ed25519': "));
        assert!(secret("Password for 'https://u@git.example.com': "));
        assert!(secret("Verification code: "));
        assert!(!secret("Are you sure you want to continue connecting (yes/no/[fingerprint])? "));
        assert!(!secret("Username for 'https://git.example.com': "));
        assert!(!secret("Username for 'https://spinnaker.example.com': "));
    }

    #[tokio::test]
    async fn a_prompt_is_asked_once_and_kept_only_when_the_page_says() {
        let asks = Arc::new(Asks::default());
        let page = Ws::detached();
        assert!(asks.answer("nobody", "password: ").await.is_none(), "an unknown token is never asked");
        asks.register("run1");
        assert!(asks.answer("run1", "password: ").await.is_none(), "no page, no answer");
        asks.attach(&page);
        let ask = |asks: &Arc<Asks>, token: &'static str, value: &'static str, remember: bool| {
            let a = asks.clone();
            let task = tokio::spawn(async move { a.answer(token, "password: ").await });
            let b = asks.clone();
            async move {
                // the page answers whichever ask is pending
                for _ in 0..200 {
                    let id = b.inner.lock().unwrap().pending.keys().next().cloned();
                    if let Some(id) = id {
                        b.message(&json!({ "type": "answer", "id": id, "value": value, "remember": remember }).to_string());
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                task.await.unwrap()
            }
        };
        assert_eq!(ask(&asks, "run1", "first", false).await.as_deref(), Some("first"));
        assert!(asks.inner.lock().unwrap().kept.is_empty(), "nothing kept unless asked");
        assert_eq!(ask(&asks, "run1", "second", true).await.as_deref(), Some("second"));
        asks.register("run2");
        // a later run takes the kept answer without asking
        assert_eq!(asks.answer("run2", "password: ").await.as_deref(), Some("second"));
        // asked again in that run: the kept one was wrong, so it's dropped and asked anew
        assert_eq!(ask(&asks, "run2", "third", false).await.as_deref(), Some("third"));
        assert!(asks.inner.lock().unwrap().kept.is_empty());
        // a cancel answers nothing
        let a = asks.clone();
        let task = tokio::spawn(async move { a.answer("run2", "Enter passphrase: ").await });
        loop {
            let id = asks.inner.lock().unwrap().pending.keys().next().cloned();
            if let Some(id) = id {
                asks.message(&json!({ "type": "cancel", "id": id }).to_string());
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(task.await.unwrap().is_none());
    }

    #[tokio::test]
    async fn the_askpass_wire_carries_a_prompt_and_its_answer() {
        let asks = Arc::new(Asks::default());
        let port = asks.clone().listen().await.unwrap();
        asks.register("tok");
        asks.inner.lock().unwrap().kept.insert("pw: ".into(), "hunter2".into());
        let got = tokio::task::spawn_blocking(move || ask_service(&format!("{port}:tok"), "pw: ")).await.unwrap();
        assert_eq!(got.as_deref(), Some("hunter2"));
        let refused = tokio::task::spawn_blocking(move || ask_service(&format!("{port}:wrong"), "pw: ")).await.unwrap();
        assert!(refused.is_none());
    }
}
