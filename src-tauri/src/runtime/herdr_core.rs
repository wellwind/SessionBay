//! Experimental backend that runs terminals in herdr-core (`hc`,
//! https://github.com/herdrdev/herdr-core) instead of an owned PTY.
//!
//! Each terminal gets its own `hc connect` child, which speaks herdr-core's
//! protocol (generation 1) on stdin/stdout and finds the local core itself.
//! The connection starts as line-delimited JSON-RPC; `hello {framed: true}`
//! switches it to frames of `[channel u32 LE][kind u8][len u32 LE][payload]`.
//! `terminal.run` starts the program and `terminal.attach` opens a stream:
//! the core's first paint, then the program's output, minus the queries the
//! core already answered. Input goes back as DATA on that stream.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// Protocol generation this client speaks.
pub const GENERATION: u32 = 1;
const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_LINE: u64 = 1024 * 1024;

pub const KIND_DATA: u8 = 0;
pub const KIND_CREDIT: u8 = 1;
pub const KIND_CLOSE: u8 = 2;
pub const KIND_RESIZE: u8 = 3;

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub channel: u32,
    pub kind: u8,
    pub payload: Vec<u8>,
}

pub fn encode(channel: u32, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(9 + payload.len());
    frame.extend(channel.to_le_bytes());
    frame.push(kind);
    frame.extend((payload.len() as u32).to_le_bytes());
    frame.extend(payload);
    frame
}

/// Read one frame; `Ok(None)` at a clean end of stream.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<Frame>, String> {
    let mut header = [0u8; 9];
    match reader.read_exact(&mut header[..1]) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    reader
        .read_exact(&mut header[1..])
        .map_err(|error| error.to_string())?;
    let channel = u32::from_le_bytes(header[0..4].try_into().expect("four bytes"));
    let kind = header[4];
    let len = u32::from_le_bytes(header[5..9].try_into().expect("four bytes")) as usize;
    if len > MAX_FRAME {
        return Err("herdr-core sent an oversized frame".into());
    }
    let mut payload = vec![0; len];
    reader
        .read_exact(&mut payload)
        .map_err(|error| error.to_string())?;
    Ok(Some(Frame {
        channel,
        kind,
        payload,
    }))
}

/// How a stream ended, from the core's CLOSE payload.
#[derive(Debug, PartialEq, Eq)]
pub struct Closed {
    pub reason: String,
    pub exit_code: Option<i32>,
}

pub fn parse_close(payload: &[u8]) -> Closed {
    let value: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    Closed {
        reason: value["reason"].as_str().unwrap_or("closed").to_string(),
        exit_code: value["exit_code"]
            .as_i64()
            .and_then(|code| i32::try_from(code).ok()),
    }
}

/// What the stream reader hands to the runtime.
pub enum StreamEvent {
    Output(Vec<u8>),
    Closed(Closed),
    Failed(String),
}

pub struct Launch<'a> {
    pub executable: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub pane_id: &'a str,
}

/// Requests on channel 0 before any stream exists, read synchronously.
struct Handshake {
    writer: Box<dyn Write + Send>,
    next_id: u64,
}

impl Handshake {
    fn call(
        &mut self,
        reader: &mut impl Read,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.writer
            .write_all(&encode(0, KIND_DATA, message.to_string().as_bytes()))
            .and_then(|()| self.writer.flush())
            .map_err(|error| format!("herdr-core connection failed: {error}"))?;
        loop {
            let frame = read_frame(reader)?.ok_or("herdr-core closed the connection")?;
            if frame.channel != 0 || frame.kind != KIND_DATA {
                continue;
            }
            let reply: Value = serde_json::from_slice(&frame.payload)
                .map_err(|_| "herdr-core sent an invalid reply".to_string())?;
            if reply["id"].as_u64() == Some(id) {
                return rpc_result(reply);
            }
        }
    }
}

/// One attached herdr-core terminal.
pub struct Link {
    writer: Mutex<Box<dyn Write + Send>>,
    channel: u32,
    address: String,
    child: Mutex<Option<Child>>,
    next_id: Mutex<u64>,
}

impl Link {
    /// Start `hc connect` and attach a new terminal running `launch`.
    pub fn spawn(hc: &str, launch: &Launch) -> Result<(Arc<Link>, Box<dyn Read + Send>), String> {
        if hc.is_empty() || hc.contains('\0') {
            return Err("A valid herdr-core executable is required".into());
        }
        // Executable and arguments are passed separately; never through a shell.
        let mut child = Command::new(hc)
            .arg("connect")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Cannot start herdr-core ({hc} connect): {error}"))?;
        let stdin = child.stdin.take().ok_or("herdr-core has no input")?;
        let stdout = child.stdout.take().ok_or("herdr-core has no output")?;
        match Self::handshake(Box::new(stdin), Box::new(stdout), launch) {
            Ok((link, reader)) => {
                *lock(&link.child) = Some(child);
                Ok((link, reader))
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }

    /// Run the protocol over any byte streams (tests use in-memory pipes).
    pub fn handshake(
        writer: Box<dyn Write + Send>,
        reader: Box<dyn Read + Send>,
        launch: &Launch,
    ) -> Result<(Arc<Link>, Box<dyn Read + Send>), String> {
        let mut reader = BufReader::new(reader);
        let mut writer = writer;
        let hello = json!({"jsonrpc": "2.0", "id": 0, "method": "hello",
            "params": {"framed": true, "generation": GENERATION}});
        writeln!(writer, "{hello}").map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        let mut line = String::new();
        (&mut reader)
            .take(MAX_LINE)
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        let reply: Value = serde_json::from_str(&line)
            .map_err(|_| "herdr-core did not answer hello".to_string())?;
        let result = rpc_result(reply)?;
        if result["generation"].as_u64() != Some(u64::from(GENERATION)) {
            return Err(format!(
                "herdr-core speaks protocol generation {}, but Session Bay needs {GENERATION}",
                result["generation"]
            ));
        }
        if result["framed"] != Value::Bool(true) {
            return Err("herdr-core did not switch to framed mode".into());
        }
        let mut handshake = Handshake { writer, next_id: 0 };
        let mut argv = vec![launch.executable.to_string()];
        argv.extend(launch.args.iter().cloned());
        let run = handshake.call(
            &mut reader,
            "terminal.run",
            json!({
                "argv": argv,
                "cwd": launch.cwd.to_string_lossy(),
                "env": launch.env,
                "size": {"cols": launch.cols, "rows": launch.rows},
                "labels": {"sessionbay.pane": launch.pane_id},
                "no_parent": true,
                "no_notify": true,
            }),
        )?;
        let address = run["address"]
            .as_str()
            .ok_or("herdr-core did not return a terminal address")?
            .to_string();
        let attach = handshake.call(
            &mut reader,
            "terminal.attach",
            json!({"terminal": address, "cols": launch.cols, "rows": launch.rows}),
        )?;
        let channel = attach["channel"]
            .as_u64()
            .and_then(|channel| u32::try_from(channel).ok())
            .filter(|channel| *channel != 0)
            .ok_or("herdr-core did not open a terminal stream")?;
        let link = Arc::new(Link {
            writer: Mutex::new(handshake.writer),
            channel,
            address,
            child: Mutex::new(None),
            next_id: Mutex::new(handshake.next_id),
        });
        Ok((link, Box::new(reader)))
    }

    fn request(&self, method: &str, params: Value) -> Result<u64, String> {
        let id = {
            let mut next = lock(&self.next_id);
            *next += 1;
            *next
        };
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.send(0, KIND_DATA, message.to_string().as_bytes())?;
        Ok(id)
    }

    fn send(&self, channel: u32, kind: u8, payload: &[u8]) -> Result<(), String> {
        let mut writer = lock(&self.writer);
        writer
            .write_all(&encode(channel, kind, payload))
            .and_then(|()| writer.flush())
            .map_err(|error| format!("herdr-core connection failed: {error}"))
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.send(self.channel, KIND_DATA, data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let mut payload = cols.to_le_bytes().to_vec();
        payload.extend(rows.to_le_bytes());
        self.send(self.channel, KIND_RESIZE, &payload)
    }

    /// Return flow-control credit for bytes the broker has consumed.
    pub fn credit(&self, bytes: usize) -> Result<(), String> {
        self.send(
            self.channel,
            KIND_CREDIT,
            &(bytes.min(u32::MAX as usize) as u32).to_le_bytes(),
        )
    }

    /// End the program. The stream then closes with the reason `killed`.
    pub fn kill(&self) -> Result<(), String> {
        self.request("terminal.kill", json!({"terminal": self.address}))
            .map(|_| ())
    }

    /// Stop the `hc connect` child once the stream is over.
    pub fn close(&self) {
        let _ = self.send(self.channel, KIND_CLOSE, &[]);
        if let Some(mut child) = lock(&self.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Read the attached stream until it closes, handing output to `on_event`.
pub fn pump(link: &Link, mut reader: impl Read, mut on_event: impl FnMut(StreamEvent)) {
    loop {
        match read_frame(&mut reader) {
            Ok(Some(frame)) if frame.channel == link.channel => match frame.kind {
                KIND_DATA if !frame.payload.is_empty() => {
                    let len = frame.payload.len();
                    on_event(StreamEvent::Output(frame.payload));
                    let _ = link.credit(len);
                }
                KIND_CLOSE => {
                    on_event(StreamEvent::Closed(parse_close(&frame.payload)));
                    return;
                }
                _ => {}
            },
            // Replies to later calls (such as terminal.kill) need no action.
            Ok(Some(_)) => {}
            Ok(None) => {
                on_event(StreamEvent::Failed(
                    "herdr-core closed the connection".into(),
                ));
                return;
            }
            Err(error) => {
                on_event(StreamEvent::Failed(error));
                return;
            }
        }
    }
}

fn rpc_result(reply: Value) -> Result<Value, String> {
    if let Some(error) = reply.get("error") {
        let message = error["message"].as_str().unwrap_or("request failed");
        return Err(format!("herdr-core: {message}"));
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| "herdr-core sent a reply without a result".into())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// An in-memory core that follows the documented handshake (tests only).
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::io::{pipe, PipeReader, PipeWriter};

    pub struct FakeCore {
        pub to_client: PipeWriter,
        pub from_client: BufReader<PipeReader>,
        pub run: Value,
    }
    impl FakeCore {
        pub fn reply(&mut self, id: &Value, result: Value) {
            let message = json!({"jsonrpc": "2.0", "id": id, "result": result});
            self.send(0, KIND_DATA, message.to_string().as_bytes());
        }
        pub fn send(&mut self, channel: u32, kind: u8, payload: &[u8]) {
            self.to_client
                .write_all(&encode(channel, kind, payload))
                .unwrap();
        }
        pub fn request(&mut self) -> Value {
            loop {
                let frame = read_frame(&mut self.from_client).unwrap().unwrap();
                if frame.channel == 0 && frame.kind == KIND_DATA {
                    return serde_json::from_slice(&frame.payload).unwrap();
                }
            }
        }
        /// Next frame on the stream channel, skipping credit.
        pub fn stream_frame(&mut self) -> Frame {
            loop {
                let frame = read_frame(&mut self.from_client).unwrap().unwrap();
                if frame.channel == 3 && frame.kind != KIND_CREDIT {
                    return frame;
                }
            }
        }
    }

    pub type Connected = Result<(Arc<Link>, Box<dyn Read + Send>), String>;

    /// Hand `launch` to a fake core speaking `generation`; the core thread
    /// returns once it has answered hello, run and attach.
    pub fn connect(
        launch: &Launch,
        generation: u32,
    ) -> (Connected, std::thread::JoinHandle<FakeCore>) {
        let (client_reader, to_client) = pipe().unwrap();
        let (from_client, client_writer) = pipe().unwrap();
        let core = std::thread::spawn(move || {
            let mut core = FakeCore {
                to_client,
                from_client: BufReader::new(from_client),
                run: Value::Null,
            };
            let mut line = String::new();
            core.from_client.read_line(&mut line).unwrap();
            let hello: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(hello["method"], "hello");
            assert_eq!(hello["params"]["framed"], true);
            let reply = json!({"jsonrpc": "2.0", "id": hello["id"], "result": {
                "generation": generation, "version": "0.1.21", "framed": true,
                "core": null, "methods": [], "features": []}});
            writeln!(core.to_client, "{reply}").unwrap();
            if generation != GENERATION {
                return core;
            }
            let run = core.request();
            assert_eq!(run["method"], "terminal.run");
            core.reply(&run["id"], json!({"address": "t7", "state": "live"}));
            core.run = run;
            let attach = core.request();
            assert_eq!(attach["method"], "terminal.attach");
            assert_eq!(attach["params"]["terminal"], "t7");
            core.reply(
                &attach["id"],
                json!({"channel": 3, "terminal": {},
                "resize_notifications": false, "automatic_input": false}),
            );
            core
        });
        let result = Link::handshake(Box::new(client_writer), Box::new(client_reader), launch);
        (result, core)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::fake::FakeCore;

    fn connect(generation: u32) -> (fake::Connected, std::thread::JoinHandle<FakeCore>) {
        let env = HashMap::from([("SESSIONBAY_HOOK".to_string(), "1".to_string())]);
        let args = vec!["-l".to_string()];
        let launch = Launch {
            executable: "/bin/zsh",
            args: &args,
            cwd: Path::new("/tmp"),
            env: &env,
            cols: 100,
            rows: 30,
            pane_id: "pane-1",
        };
        let (result, core) = fake::connect(&launch, generation);
        if generation == GENERATION {
            let run = &result.as_ref().map(|_| ()).map_err(|e| e.clone());
            assert!(run.is_ok(), "{run:?}");
        }
        (result, core)
    }

    #[test]
    fn run_carries_the_launch_spec() {
        let (result, core) = connect(GENERATION);
        result.unwrap();
        let run = core.join().unwrap().run;
        assert_eq!(run["params"]["argv"], json!(["/bin/zsh", "-l"]));
        assert_eq!(run["params"]["cwd"], "/tmp");
        assert_eq!(run["params"]["env"]["SESSIONBAY_HOOK"], "1");
        assert_eq!(run["params"]["size"], json!({"cols": 100, "rows": 30}));
        assert_eq!(run["params"]["labels"]["sessionbay.pane"], "pane-1");
    }

    #[test]
    fn frames_round_trip_and_reject_oversized_payloads() {
        let bytes = encode(3, KIND_RESIZE, &[80, 0, 24, 0]);
        assert_eq!(bytes, [3, 0, 0, 0, 3, 4, 0, 0, 0, 80, 0, 24, 0]);
        let frame = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(
            frame,
            Frame {
                channel: 3,
                kind: KIND_RESIZE,
                payload: vec![80, 0, 24, 0]
            }
        );
        assert_eq!(read_frame(&mut [].as_slice()).unwrap(), None);
        let mut huge = encode(1, KIND_DATA, &[]);
        huge[5..9].copy_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert!(read_frame(&mut huge.as_slice()).is_err());
    }

    #[test]
    fn close_payloads_report_reason_and_exit_code() {
        assert_eq!(
            parse_close(br#"{"reason":"exited","exit_code":3,"signal":null}"#),
            Closed {
                reason: "exited".into(),
                exit_code: Some(3)
            }
        );
        assert_eq!(
            parse_close(b""),
            Closed {
                reason: "closed".into(),
                exit_code: None
            }
        );
    }

    #[test]
    fn handshake_runs_attaches_and_streams_until_the_program_exits() {
        let (result, core) = connect(GENERATION);
        let (link, reader) = result.unwrap();
        let mut core = core.join().unwrap();
        assert_eq!(link.address(), "t7");
        link.write(b"ls\r").unwrap();
        link.resize(120, 40).unwrap();
        let input = read_frame(&mut core.from_client).unwrap().unwrap();
        assert_eq!(
            input,
            Frame {
                channel: 3,
                kind: KIND_DATA,
                payload: b"ls\r".to_vec()
            }
        );
        let resize = read_frame(&mut core.from_client).unwrap().unwrap();
        assert_eq!(
            resize,
            Frame {
                channel: 3,
                kind: KIND_RESIZE,
                payload: vec![120, 0, 40, 0]
            }
        );
        core.to_client
            .write_all(&encode(3, KIND_DATA, b"\x1b[H\x1b[2Jpaint"))
            .unwrap();
        // A reply on channel 0 (e.g. to a later call) is not output.
        core.to_client
            .write_all(&encode(
                0,
                KIND_DATA,
                br#"{"jsonrpc":"2.0","id":9,"result":{}}"#,
            ))
            .unwrap();
        core.to_client
            .write_all(&encode(3, KIND_DATA, b"output"))
            .unwrap();
        core.to_client
            .write_all(&encode(
                3,
                KIND_CLOSE,
                br#"{"reason":"exited","exit_code":0}"#,
            ))
            .unwrap();
        let mut events = Vec::new();
        pump(&link, reader, |event| {
            events.push(match event {
                StreamEvent::Output(data) => format!("out:{}", String::from_utf8_lossy(&data)),
                StreamEvent::Closed(closed) => {
                    format!("closed:{}:{:?}", closed.reason, closed.exit_code)
                }
                StreamEvent::Failed(error) => format!("failed:{error}"),
            })
        });
        assert_eq!(
            events,
            [
                "out:\x1b[H\x1b[2Jpaint",
                "out:output",
                "closed:exited:Some(0)"
            ]
        );
        // Each consumed DATA frame returns its credit.
        let credit = read_frame(&mut core.from_client).unwrap().unwrap();
        assert_eq!(
            credit,
            Frame {
                channel: 3,
                kind: KIND_CREDIT,
                payload: 12u32.to_le_bytes().to_vec()
            }
        );
    }

    #[test]
    fn kill_asks_the_core_to_end_the_terminal() {
        let (result, core) = connect(GENERATION);
        let (link, _reader) = result.unwrap();
        let mut core = core.join().unwrap();
        link.kill().unwrap();
        let kill = core.request();
        assert_eq!(kill["method"], "terminal.kill");
        assert_eq!(kill["params"]["terminal"], "t7");
    }

    #[test]
    fn a_core_of_another_generation_is_refused() {
        let (result, core) = connect(GENERATION + 1);
        let error = result.err().unwrap();
        assert!(error.contains("generation 2"), "{error}");
        core.join().unwrap();
    }

    #[test]
    fn a_lost_connection_ends_the_stream_with_an_error() {
        let (result, core) = connect(GENERATION);
        let (link, reader) = result.unwrap();
        drop(core.join().unwrap());
        let mut events = Vec::new();
        pump(&link, reader, |event| {
            events.push(matches!(event, StreamEvent::Failed(_)))
        });
        assert_eq!(events, [true]);
    }

    #[test]
    fn a_missing_executable_is_reported() {
        let env = HashMap::new();
        let launch = Launch {
            executable: "sh",
            args: &[],
            cwd: Path::new("/"),
            env: &env,
            cols: 80,
            rows: 24,
            pane_id: "p",
        };
        let error = Link::spawn("/nonexistent/sessionbay-test-hc", &launch)
            .err()
            .unwrap();
        assert!(error.contains("Cannot start herdr-core"), "{error}");
    }
}
