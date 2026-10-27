//! Runs the user's Git executable with separate argv, cwd and stdin.
//!
//! Paths and refs are always individual arguments; nothing is joined into a
//! shell string. Output is bounded and every command can time out or cancel.
use crate::tr;
use std::{
    ffi::{OsStr, OsString},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

/// Oldest Git that supports every flag the workbench passes
/// (`rev-parse --path-format`, `switch`, `restore`, porcelain v2 `-z`).
pub const MINIMUM_GIT: (u32, u32) = (2, 31);
const DEFAULT_OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Never refreshes the index or takes optional locks.
    Read,
    /// May write repository state; callers serialize per common dir.
    Write,
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    pub fn stderr_text(&self) -> String {
        sanitize_message(&String::from_utf8_lossy(&self.stderr))
    }
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    /// The trimmed stdout as UTF-8, failing with stderr otherwise.
    pub fn checked(self) -> Result<Self, GitError> {
        if self.success() {
            Ok(self)
        } else {
            Err(GitError::from_output(&self))
        }
    }
}

/// Classified failure kinds let the UI explain auth/offline/rejection without
/// pretending a network write did or did not happen.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitErrorKind {
    NotFound,
    Timeout,
    Cancelled,
    TooLarge,
    Authentication,
    Offline,
    Rejected,
    Hook,
    Signing,
    Locked,
    Conflict,
    DubiousOwnership,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
    pub kind: GitErrorKind,
    pub message: String,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let prefix = match self.kind {
            GitErrorKind::NotFound => tr!("Git executable not found"),
            GitErrorKind::Timeout => tr!("The Git operation timed out"),
            GitErrorKind::Cancelled => tr!("The Git operation was cancelled"),
            GitErrorKind::TooLarge => tr!("Git output exceeded the limit"),
            GitErrorKind::Authentication => tr!("Authentication failed"),
            GitErrorKind::Offline => tr!("Cannot reach the remote"),
            GitErrorKind::Rejected => tr!("The remote rejected the push"),
            GitErrorKind::Hook => tr!("A Git hook failed"),
            GitErrorKind::Signing => tr!("Signing failed"),
            GitErrorKind::Locked => tr!("The repository is locked by another process"),
            GitErrorKind::Conflict => tr!("Conflicts occurred"),
            GitErrorKind::DubiousOwnership => tr!("Git rejected an untrusted folder owner"),
            GitErrorKind::Failed => tr!("The Git operation failed"),
        };
        if self.message.is_empty() {
            write!(f, "{prefix}")
        } else {
            write!(f, "{prefix}{}{}", tr!(": "), self.message)
        }
    }
}

impl From<GitError> for String {
    fn from(value: GitError) -> Self {
        value.to_string()
    }
}

impl GitError {
    pub fn new(kind: GitErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(GitErrorKind::Failed, message)
    }
    pub fn from_output(output: &GitOutput) -> Self {
        let message = output.stderr_text();
        Self::new(classify(&message), message.trim().to_owned())
    }
}

/// Git messages are forced to the C locale in [`GitRunner::command`], so these
/// English fragments are stable across user locales.
pub fn classify(message: &str) -> GitErrorKind {
    let lower = message.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if any(&["detected dubious ownership"]) {
        GitErrorKind::DubiousOwnership
    } else if any(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "permission denied (publickey",
        "terminal prompts disabled",
        "invalid username or password",
        "http basic: access denied",
        "403 forbidden",
        "the requested url returned error: 403",
        "the requested url returned error: 401",
    ]) {
        GitErrorKind::Authentication
    } else if any(&[
        "could not resolve host",
        "could not resolve hostname",
        "failed to connect",
        "connection timed out",
        "connection refused",
        "network is unreachable",
        "unable to access",
        "operation timed out",
        "no route to host",
    ]) {
        GitErrorKind::Offline
    } else if any(&[
        "[rejected]",
        "[remote rejected]",
        "failed to push some refs",
        "protected branch",
        "pre-receive hook declined",
    ]) {
        GitErrorKind::Rejected
    } else if any(&[
        "gpg failed to sign",
        "error: gpg",
        "failed to write commit object",
        "signing failed",
        "ssh-keygen",
    ]) {
        GitErrorKind::Signing
    } else if any(&[
        "index.lock",
        "unable to create",
        "another git process seems to be running",
    ]) && lower.contains("lock")
    {
        GitErrorKind::Locked
    } else if any(&["hook", "pre-commit", "commit-msg"]) && any(&["declined", "failed", "exit"]) {
        GitErrorKind::Hook
    } else if any(&["conflict", "needs merge", "unmerged"]) {
        GitErrorKind::Conflict
    } else {
        GitErrorKind::Failed
    }
}

/// Logs and errors must never carry tokens or credential-bearing remote URLs.
pub fn sanitize_message(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    for (index, line) in message.lines().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&redact_url_credentials(line));
    }
    let limited: String = out.chars().take(4000).collect();
    limited
}

/// Replaces `scheme://user:secret@host` with `scheme://***@host`.
pub fn redact_url_credentials(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("://") {
        let (head, tail) = rest.split_at(index + 3);
        result.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '\'' || c == '"' || c == '/')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        if let Some(at) = authority.rfind('@') {
            result.push_str("***");
            result.push_str(&authority[at..]);
        } else {
            result.push_str(authority);
        }
        rest = &tail[end..];
    }
    result.push_str(rest);
    result
}

#[derive(Clone)]
pub struct GitRunner {
    executable: PathBuf,
    version: (u32, u32, u32),
}

impl std::fmt::Debug for GitRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitRunner")
            .field("executable", &self.executable)
            .field("version", &self.version)
            .finish()
    }
}

pub struct Invocation<'a> {
    pub cwd: &'a Path,
    pub args: Vec<OsString>,
    pub access: Access,
    pub stdin: Option<Vec<u8>>,
    pub env: Vec<(OsString, OsString)>,
    pub timeout: Duration,
    pub output_limit: usize,
    pub cancel: Option<Arc<AtomicBool>>,
}

impl<'a> Invocation<'a> {
    pub fn new<I, S>(cwd: &'a Path, access: Access, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Self {
            cwd,
            args: args.into_iter().map(|a| a.as_ref().to_owned()).collect(),
            access,
            stdin: None,
            env: Vec::new(),
            timeout: Duration::from_secs(30),
            output_limit: DEFAULT_OUTPUT_LIMIT,
            cancel: None,
        }
    }
    pub fn arg(mut self, value: impl AsRef<OsStr>) -> Self {
        self.args.push(value.as_ref().to_owned());
        self
    }
    pub fn args<I, S>(mut self, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(values.into_iter().map(|a| a.as_ref().to_owned()));
        self
    }
    pub fn stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }
    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.env
            .push((key.as_ref().to_owned(), value.as_ref().to_owned()));
        self
    }
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
    pub fn limit(mut self, bytes: usize) -> Self {
        self.output_limit = bytes;
        self
    }
    pub fn cancel(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }
}

impl GitRunner {
    /// Resolve `SESSIONBAY_GIT` (absolute path, tests/diagnostics) or `git`.
    pub fn detect() -> Result<Self, GitError> {
        let executable = match std::env::var_os("SESSIONBAY_GIT") {
            Some(value) if !value.is_empty() => PathBuf::from(value),
            _ => crate::config::resolve_executable("git")
                .map_err(|e| GitError::new(GitErrorKind::NotFound, e))?,
        };
        Self::with_executable(executable)
    }

    pub fn with_executable(executable: PathBuf) -> Result<Self, GitError> {
        let mut runner = Self {
            executable,
            version: (0, 0, 0),
        };
        let output = runner
            .run(
                Invocation::new(Path::new("."), Access::Read, ["version"])
                    .timeout(Duration::from_secs(10)),
            )
            .map_err(|e| GitError::new(GitErrorKind::NotFound, e.message))?;
        let text = output.stdout_text();
        let version = parse_version(&text).ok_or_else(|| {
            GitError::new(
                GitErrorKind::NotFound,
                tr!(
                    "Cannot recognize the Git version: {{version}}",
                    version = text.trim()
                ),
            )
        })?;
        if (version.0, version.1) < MINIMUM_GIT {
            return Err(GitError::new(
                GitErrorKind::NotFound,
                tr!(
                    "Git {{version}} is too old; {{minimum}} or later is required",
                    version = format!("{}.{}.{}", version.0, version.1, version.2),
                    minimum = format!("{}.{}", MINIMUM_GIT.0, MINIMUM_GIT.1)
                ),
            ));
        }
        runner.version = version;
        Ok(runner)
    }

    pub fn version(&self) -> String {
        format!("{}.{}.{}", self.version.0, self.version.1, self.version.2)
    }

    fn command(&self, invocation: &Invocation<'_>) -> Result<std::process::Command, GitError> {
        let mut command =
            crate::host_environment::command(&self.executable).map_err(GitError::failed)?;
        command.current_dir(invocation.cwd);
        // Stable, parseable output without overriding the user's hooks,
        // signing, SSH or credential helpers.
        command.args([
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "core.pager=cat",
        ]);
        if invocation.access == Access::Read {
            command.arg("--no-optional-locks");
            command.env("GIT_OPTIONAL_LOCKS", "0");
        }
        command.args(&invocation.args);
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GIT_LITERAL_PATHSPECS", "1");
        command.env("GCM_INTERACTIVE", "never");
        command.env("LC_MESSAGES", "C");
        if let Some(all) = std::env::var_os("LC_ALL") {
            // LC_ALL would override LC_MESSAGES; keep the user's character set.
            command.env_remove("LC_ALL");
            command.env("LC_CTYPE", all);
        }
        for (key, value) in &invocation.env {
            command.env(key, value);
        }
        command
            .stdin(if invocation.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Own process group, so cancel/timeout can also stop ssh, credential
        // helpers and hooks that Git spawned (they share our output pipes).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        Ok(command)
    }

    pub fn run(&self, invocation: Invocation<'_>) -> Result<GitOutput, GitError> {
        let mut command = self.command(&invocation)?;
        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GitError::new(
                    GitErrorKind::NotFound,
                    self.executable.display().to_string(),
                )
            } else {
                GitError::failed(tr!("Cannot start Git: {{error}}", error = e))
            }
        })?;
        let writer = invocation.stdin.clone().and_then(|bytes| {
            child.stdin.take().map(|mut stdin| {
                thread::spawn(move || {
                    let _ = stdin.write_all(&bytes);
                })
            })
        });
        let limit = invocation.output_limit;
        let overflow = Arc::new(AtomicBool::new(false));
        let stdout = spawn_reader(child.stdout.take(), limit, overflow.clone());
        let stderr = spawn_reader(
            child.stderr.take(),
            1024 * 1024,
            Arc::new(AtomicBool::new(false)),
        );
        let started = Instant::now();
        let mut killed = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(e) => break Err(GitError::failed(e.to_string())),
            }
            if invocation
                .cancel
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                kill(&mut child);
                killed = true;
                break Err(GitError::new(GitErrorKind::Cancelled, ""));
            }
            if overflow.load(Ordering::Relaxed) {
                kill(&mut child);
                killed = true;
                break Err(GitError::new(
                    GitErrorKind::TooLarge,
                    tr!("over {{limit}} bytes", limit = limit),
                ));
            }
            if started.elapsed() > invocation.timeout {
                kill(&mut child);
                killed = true;
                break Err(GitError::new(
                    GitErrorKind::Timeout,
                    tr!(
                        "over {{seconds}} seconds",
                        seconds = invocation.timeout.as_secs()
                    ),
                ));
            }
            thread::sleep(Duration::from_millis(5));
        };
        if killed {
            // Output is discarded on these errors. A descendant outside our
            // reach (e.g. on Windows) may still hold the pipes open, so never
            // wait for the readers; they finish when the pipes close.
            drop((writer, stdout, stderr));
            return Err(status.expect_err("killed runs always end in an error"));
        }
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        let stdout = stdout.join().unwrap_or_default();
        let stderr = stderr.join().unwrap_or_default();
        let status = status?;
        if overflow.load(Ordering::Relaxed) {
            return Err(GitError::new(
                GitErrorKind::TooLarge,
                tr!("over {{limit}} bytes", limit = limit),
            ));
        }
        Ok(GitOutput {
            code: status.code(),
            stdout,
            stderr,
        })
    }

    /// Runs and requires a zero exit status.
    pub fn ok(&self, invocation: Invocation<'_>) -> Result<GitOutput, GitError> {
        self.run(invocation)?.checked()
    }
}

fn kill(child: &mut Child) {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        // SAFETY: plain syscall; the group was created for this child only.
        unsafe { libc::kill(-group, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_reader(
    source: Option<impl Read + Send + 'static>,
    limit: usize,
    overflow: Arc<AtomicBool>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let Some(mut source) = source else {
            return buffer;
        };
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if buffer.len() + read > limit {
                        overflow.store(true, Ordering::Relaxed);
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
            }
        }
        buffer
    })
}

pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut parts = rest
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u32>().ok());
    Some((
        parts.next()??,
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
    ))
}

/// Converts raw Git path bytes into an argument without lossy decoding.
pub fn path_arg(bytes: &[u8]) -> Result<OsString, GitError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(OsStr::from_bytes(bytes).to_owned())
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(OsString::from)
            .map_err(|_| {
                GitError::failed(tr!("Non-UTF-8 paths are not supported on this platform"))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_and_vendor_versions() {
        assert_eq!(parse_version("git version 2.55.0\n"), Some((2, 55, 0)));
        assert_eq!(
            parse_version("git version 2.39.5 (Apple Git-154)"),
            Some((2, 39, 5))
        );
        assert_eq!(
            parse_version("git version 2.47.1.windows.2"),
            Some((2, 47, 1))
        );
        assert_eq!(parse_version("hg version"), None);
    }

    #[test]
    fn redacts_credentials_in_remote_urls() {
        assert_eq!(
            redact_url_credentials(
                "fatal: unable to access 'https://oauth2:glpat-abc@git.example.test/a/b.git/'"
            ),
            "fatal: unable to access 'https://***@git.example.test/a/b.git/'"
        );
        assert_eq!(
            redact_url_credentials("https://git.example.test/a and ssh://git@host:22/x"),
            "https://git.example.test/a and ssh://***@host:22/x"
        );
    }

    #[test]
    fn classifies_common_failures() {
        assert_eq!(
            classify("fatal: Authentication failed for 'https://x'"),
            GitErrorKind::Authentication
        );
        assert_eq!(
            classify("ssh: Could not resolve hostname example.invalid"),
            GitErrorKind::Offline
        );
        assert_eq!(
            classify(" ! [rejected]        main -> main (fetch first)"),
            GitErrorKind::Rejected
        );
        assert_eq!(
            classify("fatal: Unable to create '/r/.git/index.lock': File exists.\nAnother git process seems to be running"),
            GitErrorKind::Locked
        );
        assert_eq!(
            classify("fatal: detected dubious ownership in repository at '/r'"),
            GitErrorKind::DubiousOwnership
        );
    }
}
