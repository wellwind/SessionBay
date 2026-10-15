#![cfg(unix)]

use sessionbay_lib::{
    config::{ConfigStore, Settings},
    shells::{
        discover_shells, ShellDiscoveryInputs, MAX_SAVED_EXECUTABLES, MAX_SAVED_SEARCH_DIRECTORIES,
        MAX_SEARCH_DIRECTORIES, MAX_SHELL_CANDIDATES, MAX_SHELL_LIST_BYTES, MAX_SHELL_LIST_LINES,
    },
};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
};

fn executable(path: &Path, body: &str) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    path.to_owned()
}

fn shell_list(root: &Path, content: &str) -> PathBuf {
    let path = root.join("shells");
    fs::write(&path, content).unwrap();
    path
}

#[test]
fn literal_paths_are_discovered_without_execution_or_settings_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let marker = root.join("must-not-exist");
    let shell = executable(
        &root.join("shell with spaces;$(literal)'#name"),
        &format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display()),
    );
    let list = shell_list(root, &format!("# valid shells\n{}\n", shell.display()));
    let startup = root.join(".bashrc");
    let history = root.join(".bash_history");
    fs::write(&startup, "startup sentinel; do not read or execute").unwrap();
    fs::write(&history, "private history sentinel").unwrap();
    let store = ConfigStore::open(root.join("settings")).unwrap();
    let mut settings = Settings::default();
    settings.profiles[0].name = "My existing shell profile".into();
    settings.profiles[0].args = vec!["--custom".into(), "space and ;$(literal)".into()];
    store.save_settings(&settings).unwrap();
    let files = [
        shell.clone(),
        list.clone(),
        startup,
        history,
        store.directory.join("settings.json"),
    ];
    let before: Vec<_> = files.iter().map(|path| fs::read(path).unwrap()).collect();
    let inputs = ShellDiscoveryInputs {
        shells_file: Some(list),
        current_shell: Some(shell.clone()),
        ..Default::default()
    };

    let found = discover_shells(&inputs);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "shell with spaces;$(literal)'#name");
    assert_eq!(found[0].executable, shell.to_str().unwrap());
    assert_eq!(discover_shells(&inputs), found);
    assert!(!marker.exists(), "discovery must not execute a candidate");
    for (path, bytes) in files.iter().zip(before) {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    assert_eq!(
        serde_json::to_value(store.load_settings().0).unwrap(),
        serde_json::to_value(settings).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&found[0]).unwrap(),
        serde_json::json!({"name": "shell with spaces;$(literal)'#name", "executable": shell})
    );
}

#[test]
fn canonical_deduplication_preserves_the_first_discovered_invocation_path() {
    let temp = tempfile::tempdir().unwrap();
    let actual = executable(&temp.path().join("actual-shell"), "not executed");
    let alias = temp.path().join("sh");
    symlink(&actual, &alias).unwrap();
    let list = shell_list(
        temp.path(),
        &format!(
            "{}\n{}\n{}\n",
            actual.display(),
            alias.display(),
            actual.display()
        ),
    );
    let found = discover_shells(&ShellDiscoveryInputs {
        shells_file: Some(list),
        current_shell: Some(alias.clone()),
        ..Default::default()
    });
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "sh");
    assert_eq!(found[0].executable, alias.to_str().unwrap());
}

#[test]
fn saved_alias_excludes_canonical_target_without_changing_any_profile_fields() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let marker = root.join("must-not-execute");
    let real = executable(
        &root.join("real/bash"),
        &format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display()),
    );
    let alias = root.join("alias/bash");
    fs::create_dir(alias.parent().unwrap()).unwrap();
    symlink(&real, &alias).unwrap();
    let other = executable(&root.join("distinct/fish"), "never run");
    let list = shell_list(
        root,
        &format!(
            "{}\n{}\n{}\n",
            real.display(),
            alias.display(),
            other.display()
        ),
    );
    let store = ConfigStore::open(root.join("settings")).unwrap();
    let mut settings = Settings::default();
    settings.profiles[0].id = "saved-special".into();
    settings.profiles[0].name = "Keep my renamed profile".into();
    settings.profiles[0].executable = alias.to_str().unwrap().into();
    settings.profiles[0].args = vec!["--custom".into(), "spaces ;$(literal)".into()];
    settings.profiles[0]
        .env
        .insert("KEEP_ME".into(), "value ;$(literal)".into());
    settings.default_profile_id = "saved-special".into();
    store.save_settings(&settings).unwrap();
    let settings_path = store.directory.join("settings.json");
    let saved_bytes = fs::read(&settings_path).unwrap();
    let list_bytes = fs::read(&list).unwrap();
    let snapshot = store.load_settings().0;
    let inputs = ShellDiscoveryInputs {
        shells_file: Some(list.clone()),
        current_shell: Some(real.clone()),
        saved_executables: snapshot
            .profiles
            .iter()
            .map(|p| p.executable.clone())
            .collect(),
        ..Default::default()
    };
    let found = discover_shells(&inputs);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].executable, other.to_str().unwrap());
    assert_eq!(discover_shells(&inputs), found);
    assert!(!marker.exists());
    assert_eq!(fs::read(&settings_path).unwrap(), saved_bytes);
    assert_eq!(fs::read(&list).unwrap(), list_bytes);
    assert_eq!(
        serde_json::to_value(snapshot).unwrap(),
        serde_json::to_value(settings).unwrap()
    );
}

#[test]
fn saved_bare_command_uses_first_executable_in_path_and_keeps_distinct_targets() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let first = executable(&root.join("first/bash"), "never run");
    let second = executable(&root.join("second/bash"), "never run");
    let fallback = executable(&root.join("fallback/bash"), "never run");
    let alias_dir = root.join("alias");
    fs::create_dir(&alias_dir).unwrap();
    symlink(&first, alias_dir.join("bash")).unwrap();
    let list = shell_list(
        root,
        &format!(
            "{}\n{}\n{}\n",
            first.display(),
            second.display(),
            fallback.display()
        ),
    );
    let found = discover_shells(&ShellDiscoveryInputs {
        shells_file: Some(list),
        path: Some(
            std::env::join_paths([Path::new("relative"), &alias_dir, second.parent().unwrap()])
                .unwrap(),
        ),
        saved_executables: vec!["bash".into()],
        profile_fallback_directories: vec![fallback.parent().unwrap().into()],
        ..Default::default()
    });
    assert_eq!(
        found
            .iter()
            .map(|p| p.executable.as_str())
            .collect::<Vec<_>>(),
        [second.to_str().unwrap(), fallback.to_str().unwrap()]
    );
}

#[test]
fn saved_bare_command_resolves_fallbacks_but_missing_commands_do_not_hide_candidates() {
    let temp = tempfile::tempdir().unwrap();
    let saved = executable(&temp.path().join("fallback/bash"), "never run");
    let other = executable(&temp.path().join("other/fish"), "never run");
    let list = shell_list(
        temp.path(),
        &format!("{}\n{}\n", saved.display(), other.display()),
    );
    let input = ShellDiscoveryInputs {
        shells_file: Some(list),
        saved_executables: vec![
            "bash".into(),
            "missing-shell".into(),
            "relative/invalid".into(),
        ],
        profile_fallback_directories: vec![saved.parent().unwrap().into()],
        ..Default::default()
    };
    let found = discover_shells(&input);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].executable, other.to_str().unwrap());
}

#[test]
fn incomplete_saved_command_resolution_fails_closed_at_input_caps() {
    let temp = tempfile::tempdir().unwrap();
    let shell = executable(&temp.path().join("bash"), "never run");
    let mut input = ShellDiscoveryInputs {
        current_shell: Some(shell),
        saved_executables: vec!["missing-shell".into(); MAX_SAVED_EXECUTABLES + 1],
        ..Default::default()
    };
    assert!(discover_shells(&input).is_empty());
    input.saved_executables = vec!["missing-shell".into()];
    input.profile_fallback_directories = (0..MAX_SAVED_SEARCH_DIRECTORIES + 1)
        .map(|i| temp.path().join(format!("missing-{i}")))
        .collect();
    assert!(discover_shells(&input).is_empty());
    input.profile_fallback_directories.clear();
    input.path = Some("x".repeat(128 * 1024).into());
    assert!(discover_shells(&input).is_empty());
}

#[test]
fn missing_relative_nonexecutables_and_directories_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let nonexec = temp.path().join("nonexec");
    fs::write(&nonexec, "ordinary file").unwrap();
    fs::set_permissions(&nonexec, fs::Permissions::from_mode(0o600)).unwrap();
    let directory = temp.path().join("directory");
    fs::create_dir(&directory).unwrap();
    let missing = temp.path().join("missing");
    let broken_link = temp.path().join("broken-link");
    symlink(&missing, &broken_link).unwrap();
    let list = shell_list(
        temp.path(),
        &format!(
            "# ignored\n\nrelative-shell\n~/bin/bash\n{}\n{}\n{}\n{}\n",
            nonexec.display(),
            directory.display(),
            missing.display(),
            broken_link.display()
        ),
    );
    assert!(discover_shells(&ShellDiscoveryInputs {
        shells_file: Some(list),
        current_shell: Some("relative-shell".into()),
        path: Some(".:relative::~/bin".into()),
        ..Default::default()
    })
    .is_empty());
}

#[test]
fn path_search_checks_only_known_names_in_absolute_directories() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("path with spaces;$(literal)");
    let bash = executable(&directory.join("bash"), "never run");
    executable(&directory.join("unrelated-program"), "never run");
    let standard = temp.path().join("standard");
    let fish = executable(&standard.join("fish"), "never run");
    let found = discover_shells(&ShellDiscoveryInputs {
        path: Some(std::env::join_paths([Path::new("relative"), &directory, &directory]).unwrap()),
        standard_directories: vec![standard],
        ..Default::default()
    });
    let executables: Vec<_> = found
        .iter()
        .map(|candidate| candidate.executable.as_str())
        .collect();
    assert_eq!(
        executables,
        [fish.to_str().unwrap(), bash.to_str().unwrap()]
    );
}

#[test]
fn candidate_and_source_line_counts_are_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let paths: Vec<_> = (0..MAX_SHELL_CANDIDATES + 2)
        .map(|i| executable(&temp.path().join(format!("shell-{i}")), "never run"))
        .collect();
    let content: String = paths
        .iter()
        .map(|path| format!("{}\n", path.display()))
        .collect();
    let list = shell_list(temp.path(), &content);
    let inputs = ShellDiscoveryInputs {
        shells_file: Some(list.clone()),
        ..Default::default()
    };
    assert_eq!(discover_shells(&inputs).len(), MAX_SHELL_CANDIDATES);
    fs::write(
        &list,
        format!(
            "{}{}\n",
            "# ignored\n".repeat(MAX_SHELL_LIST_LINES),
            paths[0].display()
        ),
    )
    .unwrap();
    assert!(discover_shells(&inputs).is_empty());
}

#[test]
fn oversized_or_nonregular_shell_lists_are_skipped_without_losing_current_shell() {
    let temp = tempfile::tempdir().unwrap();
    let shell = executable(&temp.path().join("bash"), "never run");
    let list = shell_list(temp.path(), &"x".repeat(MAX_SHELL_LIST_BYTES + 1));
    let mut inputs = ShellDiscoveryInputs {
        shells_file: Some(list.clone()),
        ..Default::default()
    };
    assert!(discover_shells(&inputs).is_empty());
    inputs.current_shell = Some(shell.clone());
    assert_eq!(discover_shells(&inputs).len(), 1);
    fs::write(&list, [0xff, 0xfe]).unwrap();
    assert_eq!(discover_shells(&inputs).len(), 1);
    inputs.shells_file = Some(temp.path().to_owned());
    assert_eq!(discover_shells(&inputs).len(), 1);
    let alias = temp.path().join("shell-list-link");
    symlink(&shell, &alias).unwrap();
    inputs.shells_file = Some(alias);
    assert_eq!(discover_shells(&inputs).len(), 1);
}

#[test]
fn directory_search_is_bounded_and_oversized_path_is_ignored() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("after-limit");
    executable(&directory.join("bash"), "never run");
    let mut directories: Vec<PathBuf> = (0..MAX_SEARCH_DIRECTORIES)
        .map(|i| temp.path().join(format!("missing-{i}")))
        .collect();
    directories.push(directory.clone());
    let inputs = ShellDiscoveryInputs {
        standard_directories: directories,
        ..Default::default()
    };
    assert!(discover_shells(&inputs).is_empty());
    let huge_path = format!("{}:{}", directory.display(), "x".repeat(128 * 1024));
    let inputs = ShellDiscoveryInputs {
        path: Some(huge_path.into()),
        ..Default::default()
    };
    assert!(discover_shells(&inputs).is_empty());
}
