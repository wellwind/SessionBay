//! A tiny loopback HTTP server standing in for GitHub/GitLab APIs.
#![allow(dead_code)]
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub type Handler = dyn Fn(&Seen) -> (u16, Vec<(String, String)>, String) + Send + Sync;

pub struct MockHost {
    pub base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl MockHost {
    pub fn start(handler: Box<Handler>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let handler: Arc<Handler> = Arc::from(handler);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let handler = handler.clone();
                let record = record.clone();
                thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() || line.is_empty() {
                        return;
                    }
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_owned();
                    let path = parts.next().unwrap_or_default().to_owned();
                    let mut headers = Vec::new();
                    let mut length = 0usize;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        let header = header.trim_end().to_owned();
                        if header.is_empty() {
                            break;
                        }
                        if let Some((k, v)) = header.split_once(':') {
                            if k.eq_ignore_ascii_case("content-length") {
                                length = v.trim().parse().unwrap_or(0);
                            }
                            headers.push((k.trim().to_owned(), v.trim().to_owned()));
                        }
                    }
                    let mut body = vec![0u8; length];
                    reader.read_exact(&mut body).unwrap();
                    let seen = Seen {
                        method,
                        path,
                        headers,
                        body: String::from_utf8_lossy(&body).into_owned(),
                    };
                    record.lock().unwrap().push(seen.clone());
                    let (status, extra, body) = handler(&seen);
                    let mut response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
                    for (k, v) in extra {
                        response.push_str(&format!("{k}: {v}\r\n"));
                    }
                    response.push_str("\r\n");
                    response.push_str(&body);
                    let mut stream = stream;
                    let _ = stream.write_all(response.as_bytes());
                });
            }
        });
        Self { base, seen }
    }
    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}
