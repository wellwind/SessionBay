#![cfg_attr(not(unix), allow(dead_code))]
//! A read-only observer of one launch-owned Codex app-server.
//!
//! The native remote TUI still owns thread creation, prompts, approvals and turns.
//! This helper never starts/resumes a thread or subscribes to its item stream.
//! See docs/codex-state-observer.md for protocol and compatibility boundaries.
use crate::{agent_activity::Observation, provider_hooks::StateReport, runtime::LaunchSpec};
use serde::{Deserialize, Serialize};
use std::path::Path;

const ARGUMENT: &str = "--sessionbay-codex-state";
const MAX_THREADS: usize = 64;

/// Wrap the original executable without shell interpolation or persistent config.
/// The broker adds its launch-local route before spawning the PTY. This path
/// requires no installed command hooks and never replaces existing user hooks.
pub fn prepare(spec: &mut LaunchSpec, helper: &Path) -> Result<(), String> {
    if !cfg!(unix) {
        return Err("Codex state observation requires a Unix PTY".into());
    }
    if spec.executable.is_empty() || spec.executable.contains('\0') {
        return Err("Invalid Codex executable".into());
    }
    let helper = helper
        .to_str()
        .filter(|value| !value.is_empty() && !value.chars().any(char::is_control))
        .ok_or("Invalid Codex state helper")?;
    let _ = split_arguments(&spec.args)?;
    let mut args = vec![ARGUMENT.into(), "--".into(), spec.executable.clone()];
    args.append(&mut spec.args);
    spec.executable = helper.into();
    spec.args = args;
    Ok(())
}

/// Shared configuration overrides belong on both the app-server and native TUI.
/// Everything else, including prompts, resume selection and approval/sandbox CLI
/// options, stays exclusively on the native TUI. Never edit notify or user hooks.
fn split_arguments(args: &[String]) -> Result<(Vec<String>, Vec<String>), String> {
    let mut server = Vec::new();
    let mut tui = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            tui.extend_from_slice(&args[index..]);
            break;
        }
        if arg == "--remote" || arg.starts_with("--remote=") {
            return Err("Codex observation cannot attach to an existing remote server".into());
        }
        if arg == "--no-daemon" {
            index += 1;
            continue;
        }
        if arg == "--strict-config" {
            server.push(arg.clone());
        }
        if matches!(arg.as_str(), "-c" | "--config" | "--enable" | "--disable") {
            let value = args.get(index + 1).ok_or("Missing Codex option value")?;
            server.extend([arg.clone(), value.clone()]);
            tui.extend([arg.clone(), value.clone()]);
            index += 2;
            continue;
        }
        if ["--config=", "--enable=", "--disable="]
            .iter()
            .any(|prefix| arg.starts_with(prefix))
            || (arg.starts_with("-c") && arg.len() > 2 && !arg.starts_with("--"))
        {
            server.push(arg.clone());
        }
        tui.push(arg.clone());
        index += 1;
    }
    Ok((server, tui))
}

// Profile v2 is a separate user-config layer. app-server rejects --profile, so
// silently translating it into a TOML override would change user policy.
fn requires_native_profile(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            arg == "-p"
                || arg == "--profile"
                || arg.starts_with("--profile=")
                || (arg.starts_with("-p") && arg.len() > 2 && !arg.starts_with("--"))
        })
}

// Remote resume restores server-saved permissions rather than honoring every
// local CLI override. Keep all resume/fork launches entirely native until that
// contract can be preserved, including catalog session-tree identity binding.
fn requires_native_session(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| matches!(arg.as_str(), "resume" | "fork"))
}

fn has_explicit_cwd(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            arg == "--cd"
                || arg.starts_with("--cd=")
                || arg == "-C"
                || (arg.starts_with("-C") && arg.len() > 2)
        })
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

// deserialize_with makes these fields mandatory even though null is valid.
// An older provider omitting parent identity cannot be treated as a root.
fn required_nullable<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadMetadata {
    id: String,
    session_id: String,
    #[serde(deserialize_with = "required_nullable")]
    parent_thread_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    forked_from_id: Option<String>,
    status: Status,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Status {
    NotLoaded,
    Idle,
    SystemError,
    #[serde(rename_all = "camelCase")]
    Active {
        active_flags: Vec<String>,
    },
    #[serde(other)]
    Unknown,
}

impl Status {
    fn observation(&self) -> Observation {
        match self {
            Self::Idle => Observation::Idle,
            Self::SystemError => Observation::Failed,
            Self::Active { active_flags } => {
                if active_flags.iter().any(|flag| {
                    !matches!(flag.as_str(), "waitingOnApproval" | "waitingOnUserInput")
                }) {
                    Observation::Unknown
                } else if active_flags.iter().any(|flag| flag == "waitingOnApproval") {
                    Observation::AwaitingPermission
                } else if active_flags.iter().any(|flag| flag == "waitingOnUserInput") {
                    Observation::AwaitingInput
                } else {
                    Observation::Busy
                }
            }
            Self::NotLoaded | Self::Unknown => Observation::Unknown,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadedThreads {
    data: Vec<String>,
    #[serde(deserialize_with = "required_nullable")]
    next_cursor: Option<String>,
}

impl LoadedThreads {
    fn validate(mut self) -> Result<Vec<String>, String> {
        if self.next_cursor.is_some()
            || self.data.len() > MAX_THREADS
            || self.data.iter().any(|id| !identifier(id))
        {
            return Err("Codex loaded-thread scope exceeds observer bounds".into());
        }
        self.data.sort();
        if self.data.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err("Duplicate Codex thread identity".into());
        }
        Ok(self.data)
    }
}

#[derive(Debug, Deserialize)]
struct ThreadRead {
    thread: ThreadMetadata,
}

/// Reject ambiguous roots, forks and missing identity. A session tree identifier
/// is deliberately never substituted for the actual thread/read thread ID.
fn select_root(threads: Vec<ThreadMetadata>) -> Option<ThreadMetadata> {
    let mut roots = threads
        .into_iter()
        .filter(|thread| thread.parent_thread_id.is_none());
    let root = roots.next()?;
    if roots.next().is_some()
        || root.forked_from_id.is_some()
        || !identifier(&root.id)
        || !identifier(&root.session_id)
    {
        return None;
    }
    Some(root)
}

#[derive(Default)]
struct Reporter {
    sequence: u64,
    last_session: Option<String>,
}

impl Reporter {
    fn snapshot(&mut self, root: Option<ThreadMetadata>) -> Option<StateReport> {
        let observation = match root {
            Some(root) => {
                self.last_session = Some(root.session_id);
                root.status.observation()
            }
            None => Observation::Unknown,
        };
        let session = self.last_session.clone()?;
        self.sequence = self.sequence.checked_add(1)?;
        Some(StateReport {
            session,
            // Metadata-only snapshots do not expose an active turn id. Never
            // invent one, infer it from a hook, or retrieve the conversation.
            turn: None,
            sequence: self.sequence,
            observation,
        })
    }
}

#[derive(Deserialize)]
struct Reply<T> {
    id: Option<u64>,
    result: Option<T>,
    error: Option<serde::de::IgnoredAny>,
}

fn parse_reply<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    request: u64,
) -> Result<Option<T>, String> {
    // IgnoredAny skips notifications, prompts, private thread previews and other
    // unused payloads without building or persisting a JSON value tree.
    let reply: Reply<T> =
        serde_json::from_slice(bytes).map_err(|_| "Invalid Codex state response")?;
    match reply.id {
        None => Ok(None),
        Some(id) if id == request && reply.error.is_none() => reply
            .result
            .map(Some)
            .ok_or_else(|| "Missing Codex state result".into()),
        _ => Err("Unexpected Codex state response".into()),
    }
}

#[derive(Serialize)]
struct RpcRequest<'a, P> {
    id: u64,
    method: &'a str,
    params: P,
}

/// Called before starting any GUI/event loop. The helper owns the server and TUI
/// in the runtime's PTY session; it does not daemonize or adopt unrelated PIDs.
pub fn run_if_requested() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(ARGUMENT)) {
        return false;
    }
    #[cfg(unix)]
    let result = (|| {
        if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
            return Err("Missing Codex state launch delimiter".into());
        }
        let executable = args.next().ok_or("Missing Codex executable")?;
        let original_args = args
            .map(|arg| {
                arg.into_string()
                    .map_err(|_| "Invalid Codex launch argument")
            })
            .collect::<Result<Vec<_>, _>>()?;
        unix::run(executable, original_args)
    })();
    #[cfg(not(unix))]
    let result: Result<i32, String> =
        Err("Codex observation is unsupported on this platform".into());
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            // Only fixed diagnostics, never provider payloads, prompts or paths.
            eprintln!("Session Bay: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        ffi::OsString,
        fs,
        io::{Read, Write},
        os::unix::{
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::UnixStream,
            process::ExitStatusExt,
        },
        process::{Child, Command, ExitStatus, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use tungstenite::{protocol::WebSocketConfig, Message, WebSocket};

    const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
    const RPC_TIMEOUT: Duration = Duration::from_secs(2);
    const SAMPLE_TIMEOUT: Duration = Duration::from_secs(3);
    const SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
    const MAX_MESSAGE: usize = 1024 * 1024;

    struct OwnedProcess(Child);

    impl OwnedProcess {
        fn status(&mut self) -> Result<Option<ExitStatus>, String> {
            self.0
                .try_wait()
                .map_err(|_| "Cannot inspect owned Codex process".into())
        }
    }

    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            // Child::try_wait reserves a live child's PID until reaping. Never
            // signal a PID after try_wait has reaped it (possible PID reuse).
            if matches!(self.0.try_wait(), Ok(None)) {
                unsafe { libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM) };
                let until = Instant::now() + Duration::from_millis(300);
                while Instant::now() < until {
                    if !matches!(self.0.try_wait(), Ok(None)) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
            // All job-control descendants remain in the app-owned PTY session.
            // runtime/unix.rs kills/reaps the session when this helper exits.
        }
    }

    pub(super) struct Client<S = UnixStream> {
        socket: WebSocket<S>,
        request_id: u64,
    }

    impl Client<UnixStream> {
        fn connect(path: &Path) -> Result<Self, String> {
            // Codex may publish an alias symlink to its protected physical
            // socket. Follow the alias, but require effective-owner-only access.
            let metadata = fs::metadata(path).map_err(|_| "Codex state socket is not ready")?;
            if !metadata.file_type().is_socket()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o077 != 0
            {
                return Err("Codex state socket is not owner-private".into());
            }
            let stream =
                UnixStream::connect(path).map_err(|_| "Cannot connect to owned Codex server")?;
            stream
                .set_read_timeout(Some(RPC_TIMEOUT))
                .map_err(|_| "Cannot set Codex observer read deadline")?;
            stream
                .set_write_timeout(Some(RPC_TIMEOUT))
                .map_err(|_| "Cannot set Codex observer write deadline")?;
            // This is a WebSocket handshake over the already connected local
            // Unix stream. The URL is an HTTP Host/path, never a TCP connection.
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_MESSAGE))
                .max_frame_size(Some(MAX_MESSAGE));
            let (socket, _) =
                tungstenite::client::client_with_config("ws://localhost/", stream, Some(config))
                    .map_err(|_| "Cannot negotiate Codex observer transport")?;
            Self::from_socket(socket)
        }
    }

    impl<S: Read + Write> Client<S> {
        pub(super) fn from_socket(socket: WebSocket<S>) -> Result<Self, String> {
            let mut client = Self {
                socket,
                request_id: 0,
            };
            let _: serde::de::IgnoredAny = client.request(
                "initialize",
                serde_json::json!({
                    // Upstream's non-originating client category prevents this
                    // observer changing TUI originator or gateway login policy.
                    "clientInfo": {"name":"codex_app_server_daemon", "title":"Session Bay read-only observer", "version":env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi":false}
                }),
            )?;
            client
                .socket
                .send(Message::Text("{\"method\":\"initialized\"}".into()))
                .map_err(|_| "Cannot finish Codex observer initialization")?;
            Ok(client)
        }

        pub(super) fn request<T: serde::de::DeserializeOwned, P: Serialize>(
            &mut self,
            method: &str,
            params: P,
        ) -> Result<T, String> {
            if !matches!(method, "initialize" | "thread/loaded/list" | "thread/read") {
                return Err("Codex observer forbids this request".into());
            }
            self.request_id = self
                .request_id
                .checked_add(1)
                .ok_or("Codex request sequence exhausted")?;
            let wire = serde_json::to_string(&RpcRequest {
                id: self.request_id,
                method,
                params,
            })
            .map_err(|_| "Cannot encode Codex state request")?;
            self.socket
                .send(Message::Text(wire.into()))
                .map_err(|_| "Codex observer disconnected")?;
            let until = Instant::now() + RPC_TIMEOUT;
            loop {
                if Instant::now() >= until {
                    return Err("Codex state response deadline exceeded".into());
                }
                match self
                    .socket
                    .read()
                    .map_err(|_| "Codex observer disconnected")?
                {
                    Message::Text(text) => {
                        if let Some(result) = parse_reply(text.as_bytes(), self.request_id)? {
                            return Ok(result);
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => {
                        self.socket
                            .flush()
                            .map_err(|_| "Codex observer disconnected")?;
                    }
                    _ => return Err("Unsupported Codex observer frame".into()),
                }
            }
        }

        fn loaded(&mut self) -> Result<Vec<String>, String> {
            self.request::<LoadedThreads, _>(
                "thread/loaded/list",
                serde_json::json!({"limit":MAX_THREADS}),
            )?
            .validate()
        }

        pub(super) fn snapshot(&mut self) -> Result<Option<ThreadMetadata>, String> {
            let until = Instant::now() + SAMPLE_TIMEOUT;
            let before = self.loaded()?;
            let mut threads = Vec::new();
            for id in &before {
                if Instant::now() >= until {
                    return Err("Codex state sample deadline exceeded".into());
                }
                let response: ThreadRead = self.request(
                    "thread/read",
                    serde_json::json!({"threadId":id, "includeTurns":false}),
                )?;
                if response.thread.id != *id {
                    return Err("Codex thread identity mismatch".into());
                }
                threads.push(response.thread);
            }
            // Loading/unloading can race metadata reads. Do not publish a root
            // selected from an inconsistent in-memory set.
            if Instant::now() >= until || self.loaded()? != before {
                return Ok(None);
            }
            Ok(select_root(threads))
        }
    }

    fn publish(reporter: &mut Reporter, root: Option<ThreadMetadata>) {
        if let Some(report) = reporter.snapshot(root) {
            let _ = crate::broker::send_provider_state(report);
        }
    }

    fn exit_code(status: ExitStatus) -> i32 {
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
    }

    pub(super) fn private_directory() -> Result<tempfile::TempDir, String> {
        tempfile::Builder::new()
            .prefix("sessionbay-codex-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .map_err(|_| "Cannot create private Codex socket directory".into())
    }

    fn native_fallback(executable: &OsString, args: &[String]) -> Result<i32, String> {
        eprintln!("Session Bay: live Codex status unavailable for this launch; continuing in the native TUI.");
        let child = Command::new(executable)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "Cannot start native Codex TUI")?;
        let mut owned = OwnedProcess(child);
        owned
            .0
            .wait()
            .map(exit_code)
            .map_err(|_| "Cannot wait for native Codex TUI".into())
    }

    pub(super) fn run(executable: OsString, args: Vec<String>) -> Result<i32, String> {
        // The runtime must own our session before we spawn any descendants.
        // A bare shell invocation cannot accidentally start a detached server.
        if unsafe { libc::getsid(0) != libc::getpid() } {
            return Err("Codex observer requires an owned PTY session".into());
        }
        for variable in [
            crate::provider_hooks::DIRECTORY,
            crate::provider_hooks::GENERATION,
            crate::provider_hooks::LAUNCH,
        ] {
            if std::env::var(variable)
                .ok()
                .filter(|value| identifier(value))
                .is_none()
            {
                return Err("Missing launch-local Codex observer route".into());
            }
        }
        if requires_native_profile(&args) || requires_native_session(&args) {
            return native_fallback(&executable, &args);
        }
        let (server_args, tui_args) = split_arguments(&args)?;
        // Set owner-only permissions at creation (independent of umask). Only
        // an ephemeral socket is stored here, never config or private content.
        let directory = private_directory()?;
        let socket_path = directory.path().join("state.sock");
        let endpoint = format!("unix://{}", socket_path.display());
        let server = Command::new(&executable)
            .args(server_args)
            .args(["app-server", "--listen", &endpoint])
            // Disable persisted remote-control enrollment only for this owned
            // server; otherwise unrelated remote clients could join its scope.
            .env("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Cannot start owned Codex app-server")?;
        let mut server = OwnedProcess(server);
        let until = Instant::now() + STARTUP_TIMEOUT;
        let mut client = loop {
            if server.status()?.is_some() || Instant::now() >= until {
                drop(server);
                return native_fallback(&executable, &args);
            }
            if let Ok(client) = Client::connect(&socket_path) {
                break Some(client);
            }
            thread::sleep(Duration::from_millis(80));
        };
        let mut tui_command = Command::new(&executable);
        tui_command.args(["--remote", &endpoint]);
        if !has_explicit_cwd(&tui_args) {
            // An explicit remote cwd preserves the native directory-trust
            // onboarding check. Runtime already set this process's canonical
            // cwd from LaunchSpec. Keep fallback argv wholly unchanged.
            tui_command.arg("--cd").arg(
                std::env::current_dir()
                    .map_err(|_| "Cannot resolve native Codex working directory")?,
            );
        }
        let tui = tui_command
            .args(tui_args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "Cannot start native Codex TUI")?;
        let mut tui = OwnedProcess(tui);
        let mut reporter = Reporter::default();
        loop {
            if let Some(status) = tui.status()? {
                publish(&mut reporter, None);
                return Ok(exit_code(status));
            }
            if server.status()?.is_some() {
                publish(&mut reporter, None);
                return Err("Owned Codex app-server exited".into());
            }
            if client.is_none() {
                // A reconnect never resets the source sequence or adopts a
                // different endpoint. It cannot leave a previous Busy/wait live.
                client = Client::connect(&socket_path).ok();
            }
            let sample = client.as_mut().map(Client::snapshot);
            match sample {
                Some(Ok(root)) => publish(&mut reporter, root),
                Some(Err(_)) => {
                    publish(&mut reporter, None);
                    client = None;
                }
                None => publish(&mut reporter, None),
            }
            let until = Instant::now() + SAMPLE_INTERVAL;
            while Instant::now() < until {
                if let Some(status) = tui.status()? {
                    publish(&mut reporter, None);
                    return Ok(exit_code(status));
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

#[cfg(test)]
#[path = "codex_state_tests.rs"]
mod tests;
