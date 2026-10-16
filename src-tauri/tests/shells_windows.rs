#![cfg(windows)]

use sessionbay_lib::shells::{discover_shells, ShellDiscoveryInputs};
use std::{fs, path::Path};

fn fixture(directory: &Path, name: &str) {
    fs::create_dir_all(directory).unwrap();
    fs::write(
        directory.join(name),
        b"synthetic read-only discovery fixture",
    )
    .unwrap();
}

#[test]
fn native_shells_are_discovered_without_executing_or_mutating_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("shells & spaces 中文");
    for name in [
        "pwsh.exe",
        "powershell.exe",
        "cmd.exe",
        "bash.exe",
        "nu.exe",
        "pwsh.cmd",
        "unknown.ps1",
    ] {
        fixture(&root, name);
    }
    let inputs = ShellDiscoveryInputs {
        path: Some(std::env::join_paths([Path::new("."), &root]).unwrap()),
        current_shell: Some(root.join("cmd.exe")),
        standard_directories: vec![root.clone()],
        ..Default::default()
    };
    let found = discover_shells(&inputs);
    assert_eq!(found.len(), 5);
    assert_eq!(found[0].name, "cmd.exe");
    assert!(found
        .iter()
        .all(|candidate| candidate.executable.ends_with(".exe")));
    for candidate in &found {
        assert_eq!(
            fs::read(&candidate.executable).unwrap(),
            b"synthetic read-only discovery fixture"
        );
    }
    assert_eq!(found, discover_shells(&inputs));
}

#[test]
fn saved_bare_and_absolute_extensionless_profiles_are_excluded_using_pathext() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), "pwsh.exe");
    fixture(temp.path(), "cmd.exe");
    let inputs = ShellDiscoveryInputs {
        path: Some(std::env::join_paths([temp.path()]).unwrap()),
        pathext: Some(".EXE;.CMD".into()),
        saved_executables: vec![
            "pwsh".into(),
            temp.path().join("cmd").to_string_lossy().into_owned(),
        ],
        ..Default::default()
    };
    assert!(discover_shells(&inputs).is_empty());
}

#[test]
fn current_shell_scripts_and_nonfiles_are_not_native_shell_candidates() {
    let temp = tempfile::tempdir().unwrap();
    fixture(temp.path(), "wrapper.cmd");
    for path in [
        temp.path().join("wrapper.cmd"),
        temp.path().to_owned(),
        "relative.exe".into(),
    ] {
        assert!(discover_shells(&ShellDiscoveryInputs {
            current_shell: Some(path),
            ..Default::default()
        })
        .is_empty());
    }
}
