//! Browser-acceptance bridge: serves the real Git workbench core over
//! loopback HTTP for a synthetic repository it creates itself. Never points
//! at user repositories; binds 127.0.0.1 only.
//!
//! `cargo run --no-default-features --example git_bridge -- <port>`
//!
//! `SESSIONBAY_GIT_BRIDGE_LARGE=1` builds the same large repository as
//! `tests/git_performance.rs` (20,000 commits, 5,000 untracked files and a
//! 10,000-line diff) for frontend measurements.
use sessionbay_lib::git::{hosting::HostRequest, GitRequest, GitService};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    service: GitService,
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let config = base.join("gitconfig");
    std::fs::write(&config, "[user]\n\tname = Synthetic Tester\n\temail = tester@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n").unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &config);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    let root = base.join("repo");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q"]);
    let write = |name: &str, text: &str| std::fs::write(root.join(name), text).unwrap();
    write("f.txt", "alpha\nbeta\ngamma\ndelta\n");
    write("conflict.txt", "base line\n");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "Initial synthetic commit"]);
    git(&root, &["switch", "-q", "-c", "topic"]);
    write("conflict.txt", "topic line\n");
    git(&root, &["commit", "-q", "-am", "Topic change"]);
    git(&root, &["switch", "-q", "main"]);
    write("conflict.txt", "main line\n");
    git(&root, &["commit", "-q", "-am", "Main change"]);
    if std::env::var_os("SESSIONBAY_GIT_BRIDGE_LARGE").is_some_and(|value| value == "1") {
        large(&root);
    }
    // Two edits in one hunk, plus an untracked file.
    write("f.txt", "alpha\nBETA\ngamma\nDELTA\n");
    write("notes.txt", "untracked\n");
    // Long branch and path names for narrow-layout and resize checks.
    git(
        &root,
        &[
            "branch",
            "feature/very-long-branch-name-for-narrow-layout-checks-with-many-segments",
        ],
    );
    let deep = root
        .join("deeply/nested/directory/structure/with/very/long/segment/names/for/layout/review");
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(
        deep.join("synthetic-file-with-an-intentionally-long-name-for-ellipsis.txt"),
        "deep\n",
    )
    .unwrap();
    let service = GitService::with_data_dir(base.join("data"));
    Fixture {
        _temp: temp,
        root,
        service,
    }
}

/// Mirrors tests/git_performance.rs: long branchy history, many untracked
/// files and a 10,000-line modified file, on top of the regular fixture.
fn large(root: &Path) {
    use std::fmt::Write as _;
    let mut stream = String::new();
    for index in 0..20_000usize {
        let branch = if index % 50 < 5 {
            "refs/heads/side"
        } else {
            "refs/heads/main"
        };
        write!(stream, "commit {branch}\nmark :{}\ncommitter Synthetic <s@example.invalid> {} +0000\ndata 12\ncommit {index:05}\n", index + 1, 1_700_000_000 + index).unwrap();
        writeln!(
            stream,
            "from {}",
            if index == 0 {
                "refs/heads/main^0".to_owned()
            } else {
                format!(":{index}")
            }
        )
        .unwrap();
        write!(
            stream,
            "M 644 inline file{}.txt\ndata 8\nv{index:06}\n\n",
            index % 100
        )
        .unwrap();
    }
    let mut child = Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(root)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
    git(root, &["reset", "-q", "--hard", "main"]);
    for index in 0..5_000 {
        std::fs::write(root.join(format!("untracked-{index}.txt")), b"x\n").unwrap();
    }
    let big: String = (0..10_000).map(|i| format!("line {i}\n")).collect();
    std::fs::write(root.join("file0.txt"), big.replace("line 5", "LINE 5")).unwrap();
    git(root, &["add", "file0.txt"]);
    git(root, &["commit", "-q", "-m", "big file"]);
    std::fs::write(root.join("file0.txt"), big).unwrap();
}

fn inspect(root: &Path) -> serde_json::Value {
    serde_json::json!({
        "index": String::from_utf8_lossy(&Command::new("git").args(["show", ":f.txt"]).current_dir(root).output().unwrap().stdout),
        "log": git(root, &["log", "--format=%s %P"]),
        "status": git(root, &["status", "--porcelain"]),
        "conflictFile": std::fs::read_to_string(root.join("conflict.txt")).unwrap_or_default(),
    })
}

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(1441);
    // Browser specs run the UI in Traditional Chinese; the core follows it.
    sessionbay_lib::i18n::set_locale(&std::env::args().nth(2).unwrap_or_else(|| "zh-TW".into()));
    // The page origin allowed to call the bridge (the Vite server of the calling config).
    let origin = std::env::var("SESSIONBAY_GIT_BRIDGE_ORIGIN")
        .unwrap_or_else(|_| "http://127.0.0.1:1440".into());
    let state = Mutex::new(fixture());
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    eprintln!("git bridge on http://127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_owned();
        let path = parts.next().unwrap_or_default().to_owned();
        let mut length = 0;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                break;
            }
            if let Some((k, v)) = header.split_once(':') {
                if k.eq_ignore_ascii_case("content-length") {
                    length = v.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0; length];
        let _ = reader.read_exact(&mut body);
        let (status, payload) = if method == "OPTIONS" {
            (204, String::new())
        } else {
            let mut fixture = state.lock().unwrap();
            let result: Result<serde_json::Value, String> = match path.as_str() {
                "/health" => Ok(serde_json::json!("ok")),
                "/reset" => {
                    *fixture = self::fixture();
                    Ok(serde_json::Value::Null)
                }
                "/inspect" => Ok(inspect(&fixture.root)),
                "/git" => serde_json::from_slice::<GitRequest>(&body)
                    .map_err(|e| e.to_string())
                    .and_then(|request| fixture.service.handle(&fixture.root, request)),
                "/hosting" => serde_json::from_slice::<HostRequest>(&body)
                    .map_err(|e| e.to_string())
                    .and_then(|request| fixture.service.handle_hosting(&fixture.root, request)),
                _ => Err("not found".into()),
            };
            match result {
                Ok(value) => (200, serde_json::json!({ "ok": value }).to_string()),
                Err(error) => (200, serde_json::json!({ "error": error }).to_string()),
            }
        };
        let response = format!(
            "HTTP/1.1 {status} OK\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        let mut stream = stream;
        let _ = stream.write_all(response.as_bytes());
    }
}
