//! A page's socket as every route uses it: sent to from any task, closed with a
//! code, and dropped when a slow page lets 32 MiB pile up unread.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc,
};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use bytes::Bytes;
use futures_util::{stream::SplitStream, SinkExt, StreamExt};
use tokio::sync::mpsc;

const BACKLOG_MAX: usize = 32 << 20;

enum Out {
    Message(Message),
    Close(u16),
}

#[derive(Clone)]
pub struct Ws {
    inner: Arc<Inner>,
}

struct Inner {
    id: u64,
    tx: mpsc::UnboundedSender<Out>,
    queued: AtomicUsize,
    closed: AtomicBool,
}

impl PartialEq for Ws {
    fn eq(&self, other: &Self) -> bool {
        self.inner.id == other.inner.id
    }
}

impl Ws {
    /// the socket's writer started; its reader handed back for the route
    pub fn start(socket: WebSocket) -> (Ws, SplitStream<WebSocket>) {
        static IDS: AtomicU64 = AtomicU64::new(1);
        let (mut sink, stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let inner = Arc::new(Inner {
            id: IDS.fetch_add(1, Ordering::Relaxed),
            tx,
            queued: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
        });
        let writer = inner.clone();
        tokio::spawn(async move {
            while let Some(out) = rx.recv().await {
                match out {
                    Out::Message(m) => {
                        let size = message_len(&m);
                        let sent = sink.send(m).await;
                        writer.queued.fetch_sub(size, Ordering::Relaxed);
                        if sent.is_err() {
                            break;
                        }
                    }
                    Out::Close(code) => {
                        let _ = sink
                            .send(Message::Close(Some(CloseFrame { code, reason: "".into() })))
                            .await;
                        break;
                    }
                }
            }
            writer.closed.store(true, Ordering::Release);
            let _ = sink.close().await;
        });
        (Ws { inner }, stream)
    }

    /// a socket with no page behind it: what's sent to it goes nowhere
    pub fn detached() -> Ws {
        static IDS: AtomicU64 = AtomicU64::new(1 << 62);
        let (tx, _) = mpsc::unbounded_channel::<Out>();
        Ws {
            inner: Arc::new(Inner {
                id: IDS.fetch_add(1, Ordering::Relaxed),
                tx,
                queued: AtomicUsize::new(0),
                closed: AtomicBool::new(false),
            }),
        }
    }

    pub fn id(&self) -> u64 {
        self.inner.id
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }

    fn push(&self, m: Message) {
        if self.is_closed() {
            return;
        }
        let size = message_len(&m);
        if self.inner.queued.fetch_add(size, Ordering::Relaxed) + size > BACKLOG_MAX {
            self.close(1008);
            return;
        }
        if self.inner.tx.send(Out::Message(m)).is_err() {
            self.inner.queued.fetch_sub(size, Ordering::Relaxed);
        }
    }

    pub fn text(&self, s: impl Into<String>) {
        self.push(Message::Text(s.into().into()));
    }

    pub fn json(&self, v: &serde_json::Value) {
        self.text(v.to_string());
    }

    pub fn binary(&self, b: impl Into<Bytes>) {
        self.push(Message::Binary(b.into()));
    }

    pub fn close(&self, code: u16) {
        if !self.inner.closed.swap(true, Ordering::AcqRel) {
            let _ = self.inner.tx.send(Out::Close(code));
        }
    }
}

fn message_len(m: &Message) -> usize {
    match m {
        Message::Text(t) => t.len(),
        Message::Binary(b) => b.len(),
        _ => 0,
    }
}

/// the next frame a page sent: text or binary; None when it's gone
pub enum Frame {
    Text(String),
    Binary(Bytes),
}

pub async fn next_frame(stream: &mut SplitStream<WebSocket>) -> Option<Frame> {
    while let Some(m) = stream.next().await {
        match m {
            Ok(Message::Text(t)) => return Some(Frame::Text(t.as_str().to_owned())),
            Ok(Message::Binary(b)) => return Some(Frame::Binary(b)),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => continue,
        }
    }
    None
}
