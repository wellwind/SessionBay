//! Synthetic Git workbench timings. Ignored by default; run with
//! `cargo test --no-default-features --test git_performance -- --ignored --nocapture`.
#[path = "support/git_fixture.rs"]
mod git_fixture;

use git_fixture::{git, init_repo, temp};
use serde_json::{json, Value};
use sessionbay_lib::git::{GitRequest, GitService, ProjectGit};
use std::{
    fmt::Write as _,
    fs,
    io::Write,
    process::{Command, Stdio},
    time::Instant,
};

const COMMITS: usize = 20_000;
const FILES: usize = 5_000;
const LINES: usize = 10_000;

fn timed<T>(label: &str, report: &mut String, action: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = action();
    writeln!(
        report,
        "{label}: {:.1} ms",
        started.elapsed().as_secs_f64() * 1000.0
    )
    .unwrap();
    value
}

#[test]
#[ignore]
fn measure_large_synthetic_repository() {
    let (_temp, base) = temp();
    let root = init_repo(&base.join("big"));
    // fast-import builds a long, branchy history in seconds.
    let mut stream = String::new();
    for index in 0..COMMITS {
        let branch = if index % 50 < 5 && index > 0 {
            "refs/heads/side"
        } else {
            "refs/heads/main"
        };
        write!(stream, "commit {branch}\nmark :{}\ncommitter Synthetic <s@example.invalid> {} +0000\ndata 12\ncommit {index:05}\n", index + 1, 1_700_000_000 + index).unwrap();
        if index > 0 {
            writeln!(stream, "from :{index}").unwrap();
        }
        write!(
            stream,
            "M 644 inline file{}.txt\ndata 8\nv{index:06}\n\n",
            index % 100
        )
        .unwrap();
    }
    let mut child = Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(&root)
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
    git(&root, &["reset", "-q", "--hard", "main"]);
    for index in 0..FILES {
        fs::write(root.join(format!("untracked-{index}.txt")), b"x\n").unwrap();
    }
    let big: String = (0..LINES).map(|i| format!("line {i}\n")).collect();
    fs::write(root.join("file0.txt"), big.replace("line 5", "LINE 5")).unwrap();
    git(&root, &["add", "file0.txt"]);
    git(&root, &["commit", "-q", "-m", "big file"]);
    fs::write(root.join("file0.txt"), big).unwrap();

    let service = GitService::new();
    let mut report = String::new();
    let found = timed("discover", &mut report, || service.discover(&root).unwrap());
    let ProjectGit::Ready(found) = found else {
        panic!()
    };
    let id = found.repos[0].id.clone();
    let call = |value: Value| {
        let mut value = value;
        value["repoId"] = json!(id);
        service
            .handle(&root, serde_json::from_value::<GitRequest>(value).unwrap())
            .unwrap()
    };
    let status = timed(&format!("status ({FILES} untracked)"), &mut report, || {
        call(json!({ "op": "status" }))
    });
    assert!(status["entries"].as_array().unwrap().len() >= FILES);
    let page = timed(
        &format!("log first page of {COMMITS} commits"),
        &mut report,
        || call(json!({ "op": "log", "limit": 200 })),
    );
    assert_eq!(page["commits"].as_array().unwrap().len(), 200);
    timed("log page at offset 10000", &mut report, || {
        call(json!({ "op": "log", "offset": 10000, "limit": 200 }))
    });
    let diff = timed(&format!("diff {LINES}-line file"), &mut report, || {
        call(json!({ "op": "diff", "path": "file0.txt", "source": { "kind": "unstaged" } }))
    });
    assert!(!diff["hunks"].as_array().unwrap().is_empty());
    timed(&format!("blame {LINES}-line file"), &mut report, || {
        call(json!({ "op": "blame", "path": "file0.txt", "rev": null }))
    });
    timed("file history", &mut report, || {
        call(json!({ "op": "fileHistory", "path": "file1.txt", "limit": 100 }))
    });
    timed("refs", &mut report, || call(json!({ "op": "refs" })));
    println!("{report}");
}
