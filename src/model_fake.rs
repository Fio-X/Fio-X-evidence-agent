//! A fake model server for tests: listens on 127.0.0.1 only, replays what a test scripts, and records what it was sent.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the fake server does with one connection.
pub(crate) enum Script {
    Reply {
        status: u16,
        content_type: &'static str,
        body: String,
    },
    /// Sends each segment after its pause (milliseconds), then closes: a stream that arrives piece by piece.
    Paced(Vec<(u64, String)>),
    /// Sends the prefix, then keeps the connection open until the client closes it.
    Hold(String),
}

pub(crate) struct Seen {
    pub(crate) headers: String,
    pub(crate) body: Value,
}

pub(crate) struct Fake {
    pub(crate) base: String,
    pub(crate) seen: Arc<Mutex<Vec<Seen>>>,
}

/// Every address a test talks to goes through here: anything but 127.0.0.1 fails the test.
pub(crate) fn loopback_only(base: &str) -> &str {
    assert!(
        base.starts_with("http://127.0.0.1:"),
        "tests may only talk to 127.0.0.1, got {base}"
    );
    base
}

pub(crate) fn serve(scripts: Vec<Script>) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let log = seen.clone();
    std::thread::spawn(move || {
        for script in scripts {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let mut raw = Vec::new();
            let mut byte = [0u8; 1];
            while !raw.ends_with(b"\r\n\r\n") {
                if socket.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                raw.push(byte[0]);
            }
            let headers = String::from_utf8_lossy(&raw).to_ascii_lowercase();
            let length = headers
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let mut body = vec![0u8; length];
            socket.read_exact(&mut body).ok();
            log.lock().unwrap().push(Seen {
                headers,
                body: serde_json::from_slice(&body).unwrap_or(Value::Null),
            });
            match script {
                Script::Reply {
                    status,
                    content_type,
                    body,
                } => {
                    let head = format!("HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n");
                    socket.write_all(head.as_bytes()).ok();
                    socket.write_all(body.as_bytes()).ok();
                }
                Script::Paced(segments) => {
                    socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").ok();
                    for (pause, text) in segments {
                        std::thread::sleep(Duration::from_millis(pause));
                        socket.write_all(text.as_bytes()).ok();
                        socket.flush().ok();
                    }
                }
                Script::Hold(prefix) => {
                    socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").ok();
                    socket.write_all(prefix.as_bytes()).ok();
                    socket
                        .set_read_timeout(Some(Duration::from_millis(50)))
                        .ok();
                    for _ in 0..200 {
                        match socket.read(&mut byte) {
                            Ok(0) => break,
                            Err(e)
                                if e.kind() == std::io::ErrorKind::WouldBlock
                                    || e.kind() == std::io::ErrorKind::TimedOut => {}
                            _ => {}
                        }
                    }
                }
            }
        }
    });
    Fake { base, seen }
}

pub(crate) fn sse(events: &[(&str, Value)]) -> String {
    events
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
}

/// The stream split at event boundaries into pieces the fake sends 250 ms apart.
pub(crate) fn paced(whole: &str) -> Script {
    let events: Vec<String> = whole.split_inclusive("\n\n").map(str::to_string).collect();
    Script::Paced(
        events
            .into_iter()
            .enumerate()
            .map(|(i, text)| (if i == 0 { 0 } else { 250 }, text))
            .collect(),
    )
}
