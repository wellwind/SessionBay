#![cfg_attr(windows, windows_subsystem = "windows")]

// Synthetic CLI fixture: no IPC, histories, credentials, or real agent processes.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], "--sessionbay-runtime-broker-stop");
    let state = std::path::PathBuf::from(&args[1]);
    let mode = std::fs::read_to_string(state.join("mode")).unwrap();
    std::fs::write(state.join("pid"), std::process::id().to_string()).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(if mode == "timeout" {
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
