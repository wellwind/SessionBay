#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{io::Write, path::Path, time::Duration};

fn wait_for(path: &Path) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline, "fixture deadline");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// Synthetic fixture: private marker files only, no real broker or agent processes.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.is_empty() {
        let state =
            std::path::PathBuf::from(std::env::var_os("SESSIONBAY_SMOKE_APP_DATA").unwrap());
        // The child deliberately inherits both redirected standard handles and
        // survives its parent, matching the native smoke's pipe-EOF failure.
        let _child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--hold-smoke-output")
            .arg(&state)
            .spawn()
            .unwrap();
        wait_for(&state.join("holder-started"));
        println!("SESSIONBAY_FRONTEND {{\"phase\":\"ready\"}}");
        eprintln!("SESSIONBAY_FRONTEND {{\"phase\":\"interaction\"}}");
        std::io::stdout().flush().unwrap();
        std::io::stderr().flush().unwrap();
        return;
    }
    assert_eq!(args.len(), 2);
    let state = std::path::PathBuf::from(&args[1]);
    if args[0] == "--hold-smoke-output" {
        std::fs::write(state.join("holder-started"), "holding inherited output").unwrap();
        wait_for(&state.join("release-holder"));
        std::fs::write(state.join("holder-completed"), "explicitly released").unwrap();
        return;
    }
    assert_eq!(args[0], "--sessionbay-runtime-broker-stop");
    let mode = std::fs::read_to_string(state.join("mode")).unwrap();
    if mode == "inherited-output" {
        std::fs::write(state.join("release-holder"), "explicit fixture stop").unwrap();
        wait_for(&state.join("holder-completed"));
    }
    std::fs::write(state.join("pid"), std::process::id().to_string()).unwrap();
    std::thread::sleep(Duration::from_millis(if mode == "timeout" {
        120_000
    } else {
        400
    }));
    std::fs::write(state.join("completed"), "state existed until helper exit").unwrap();
    if mode == "failure" {
        eprintln!("synthetic stop failure");
        std::process::exit(23);
    }
}
