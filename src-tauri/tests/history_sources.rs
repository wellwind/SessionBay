use sessionbay_lib::{
    history_sources::{
        discover_history_sources, HistorySourceCandidateStatus, HistorySourceDiscoveryInputs,
        MAX_CONFIGURED_SOURCES, MAX_ROOT_PATH_BYTES,
    },
    models::{AgentKind, HistorySource},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

const SUPPORTED_PROVIDERS: [(AgentKind, &str); 3] = [
    (AgentKind::Codex, ".codex"),
    (AgentKind::Claude, ".claude"),
    (AgentKind::Grok, ".grok"),
];

fn saved_source(kind: AgentKind, root: &Path, enabled: bool) -> HistorySource {
    HistorySource {
        id: format!("synthetic-{}", kind.as_str()),
        kind,
        root: root.to_string_lossy().into_owned(),
        enabled,
    }
}

#[test]
fn all_supported_providers_use_their_manifest_default_roots() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("synthetic home");
    for (_, directory) in SUPPORTED_PROVIDERS {
        fs::create_dir_all(home.join(directory)).unwrap();
    }

    for (kind, directory) in SUPPORTED_PROVIDERS {
        let result = discover_history_sources(
            kind,
            &HistorySourceDiscoveryInputs {
                home: Some(home.clone()),
                source_env: None,
            },
            &[],
        );
        assert_eq!(result.kind, kind);
        assert!(result.supported);
        assert_eq!(result.candidates.len(), 1, "{kind:?}");
        let candidate = &result.candidates[0];
        assert_eq!(candidate.kind, kind);
        assert_eq!(
            Path::new(&candidate.root),
            home.join(directory).canonicalize().unwrap()
        );
        assert_eq!(candidate.status, HistorySourceCandidateStatus::Found);
        assert!(!candidate.configured);
    }
}

#[test]
fn explicit_environment_root_precedes_home_default_for_every_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    for (kind, directory) in SUPPORTED_PROVIDERS {
        let explicit = temp.path().join(format!("explicit-{}", kind.as_str()));
        fs::create_dir_all(&explicit).unwrap();
        fs::create_dir_all(home.join(directory)).unwrap();
        let result = discover_history_sources(
            kind,
            &HistorySourceDiscoveryInputs {
                home: Some(home.clone()),
                source_env: Some(explicit.clone()),
            },
            &[],
        );
        assert_eq!(result.candidates.len(), 2, "{kind:?}");
        assert_eq!(
            Path::new(&result.candidates[0].root),
            explicit.canonicalize().unwrap()
        );
        assert_eq!(
            Path::new(&result.candidates[1].root),
            home.join(directory).canonicalize().unwrap()
        );
        assert!(result.candidates.iter().all(|candidate| {
            candidate.kind == kind && candidate.status == HistorySourceCandidateStatus::Found
        }));
    }
}

#[test]
fn identical_environment_and_default_root_are_reported_once() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".codex");
    fs::create_dir(&root).unwrap();
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: Some(temp.path().to_owned()),
            source_env: Some(root.clone()),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        Path::new(&result.candidates[0].root),
        root.canonicalize().unwrap()
    );
}

#[test]
fn grok_source_is_the_state_root_not_its_sessions_subdirectory() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".grok");
    fs::create_dir_all(root.join("sessions")).unwrap();
    fs::write(
        root.join("sessions/synthetic.json"),
        br#"{"id":"synthetic"}"#,
    )
    .unwrap();
    let result = discover_history_sources(
        AgentKind::Grok,
        &HistorySourceDiscoveryInputs {
            home: Some(temp.path().to_owned()),
            source_env: None,
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        Path::new(&result.candidates[0].root),
        root.canonicalize().unwrap()
    );
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
}

#[test]
fn missing_directory_and_readable_empty_directory_have_distinct_statuses() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("not-created");
    let empty = temp.path().join(".claude");
    fs::create_dir(&empty).unwrap();
    let result = discover_history_sources(
        AgentKind::Claude,
        &HistorySourceDiscoveryInputs {
            home: Some(temp.path().to_owned()),
            source_env: Some(missing.clone()),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 2);
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::Missing
    );
    assert_eq!(Path::new(&result.candidates[0].root), missing);
    assert_eq!(
        result.candidates[1].status,
        HistorySourceCandidateStatus::Found
    );
    assert!(
        !missing.exists(),
        "Detection must not create a missing root"
    );
    assert_eq!(fs::read_dir(empty).unwrap().count(), 0);
}

#[test]
fn ordinary_file_is_a_check_failure_not_a_history_directory() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("source-file");
    let bytes = b"synthetic content that must remain untouched";
    fs::write(&file, bytes).unwrap();
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(file.clone()),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::CheckFailed
    );
    assert!(result.candidates[0].message.is_some());
    assert_eq!(fs::read(file).unwrap(), bytes);
}

#[test]
fn empty_relative_and_nul_environment_paths_fail_without_hiding_valid_default() {
    let temp = tempfile::tempdir().unwrap();
    let default = temp.path().join(".codex");
    fs::create_dir(&default).unwrap();
    let invalid_paths = [
        PathBuf::new(),
        PathBuf::from("relative synthetic source"),
        PathBuf::from("~/synthetic-source"),
        temp.path().join("invalid\0source"),
        temp.path().join("invalid\nsource"),
        temp.path().join("invalid\tsource"),
        temp.path().join("x".repeat(MAX_ROOT_PATH_BYTES + 1)),
    ];
    for invalid in invalid_paths {
        let result = discover_history_sources(
            AgentKind::Codex,
            &HistorySourceDiscoveryInputs {
                home: Some(temp.path().to_owned()),
                source_env: Some(invalid.clone()),
            },
            &[],
        );
        assert_eq!(result.candidates.len(), 2, "{invalid:?}");
        assert_eq!(
            result.candidates[0].status,
            HistorySourceCandidateStatus::CheckFailed,
            "{invalid:?}"
        );
        assert!(result.candidates[0].message.is_some());
        assert_eq!(
            result.candidates[0].root,
            "[invalid provider environment history root]"
        );
        assert_eq!(
            result.candidates[1].status,
            HistorySourceCandidateStatus::Found
        );
        assert_eq!(
            Path::new(&result.candidates[1].root),
            default.canonicalize().unwrap()
        );
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_environment_path_is_rejected_before_filesystem_checks() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    let temp = tempfile::tempdir().unwrap();
    let invalid = temp
        .path()
        .join(OsString::from_vec(b"invalid-\xff-source".to_vec()));
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(invalid),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::CheckFailed
    );
    assert!(result.candidates[0]
        .message
        .as_deref()
        .unwrap()
        .contains("UTF-8"));
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn missing_home_is_graceful_and_explicit_root_still_works() {
    let temp = tempfile::tempdir().unwrap();
    for (kind, _) in SUPPORTED_PROVIDERS {
        let result = discover_history_sources(kind, &HistorySourceDiscoveryInputs::default(), &[]);
        assert!(result.supported);
        assert_eq!(result.kind, kind);
        assert!(result.candidates.is_empty());

        let result = discover_history_sources(
            kind,
            &HistorySourceDiscoveryInputs {
                home: None,
                source_env: Some(temp.path().to_owned()),
            },
            &[],
        );
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(
            result.candidates[0].status,
            HistorySourceCandidateStatus::Found
        );
    }
}

#[test]
fn rejected_environment_values_never_expand_or_poison_ipc_output() {
    let invalid = PathBuf::from(format!("/{}\0\n", "x".repeat(1024 * 1024)));
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: Some(PathBuf::from("relative-home")),
            source_env: Some(invalid),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 2);
    for candidate in &result.candidates {
        assert_eq!(candidate.status, HistorySourceCandidateStatus::CheckFailed);
        assert!(candidate.root.len() < 80);
        assert!(!candidate.root.chars().any(char::is_control));
        assert!(candidate.configured_source_ids.is_empty());
    }
    assert_ne!(result.candidates[0].root, result.candidates[1].root);
    assert!(serde_json::to_vec(&result).unwrap().len() < 1024);
}

#[test]
fn configured_ids_identify_matching_saved_sources_without_changing_them() {
    let temp = tempfile::tempdir().unwrap();
    let mut first = saved_source(AgentKind::Codex, temp.path(), false);
    first.id = "saved-disabled".into();
    let mut second = first.clone();
    second.id = "saved-other-id".into();
    second.enabled = true;
    let other = saved_source(AgentKind::Claude, temp.path(), true);
    let sources = vec![first, second, other];
    let before = serde_json::to_vec(&sources).unwrap();
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(temp.path().to_owned()),
        },
        &sources,
    );
    assert!(result.candidates[0].configured);
    assert_eq!(
        result.candidates[0].configured_source_ids,
        ["saved-disabled", "saved-other-id"]
    );
    assert_eq!(serde_json::to_vec(&sources).unwrap(), before);
    assert_eq!(
        serde_json::to_value(&result).unwrap()["candidates"][0]["configuredSourceIds"],
        serde_json::json!(["saved-disabled", "saved-other-id"])
    );
}

#[test]
fn unsupported_provider_has_no_candidates_even_with_invalid_inputs_and_saved_source() {
    let temp = tempfile::tempdir().unwrap();
    let nonexistent_home = temp.path().join("never-create-this-home");
    let saved = vec![saved_source(AgentKind::Antigravity, temp.path(), true)];
    let before = serde_json::to_vec(&saved).unwrap();
    let result = discover_history_sources(
        AgentKind::Antigravity,
        &HistorySourceDiscoveryInputs {
            home: Some(nonexistent_home.clone()),
            source_env: Some(temp.path().join("invalid\0source")),
        },
        &saved,
    );
    assert_eq!(result.kind, AgentKind::Antigravity);
    assert!(!result.supported);
    assert!(result.candidates.is_empty());
    assert!(result.message.is_some());
    assert!(!nonexistent_home.exists());
    assert_eq!(serde_json::to_vec(&saved).unwrap(), before);
}

#[test]
fn configured_matches_provider_and_path_independently_of_enabled_state() {
    let temp = tempfile::tempdir().unwrap();
    let inputs = HistorySourceDiscoveryInputs {
        home: None,
        source_env: Some(temp.path().to_owned()),
    };
    for enabled in [false, true] {
        let saved = vec![saved_source(AgentKind::Grok, temp.path(), enabled)];
        let matching = discover_history_sources(AgentKind::Grok, &inputs, &saved);
        assert_eq!(matching.candidates.len(), 1);
        assert!(matching.candidates[0].configured);

        let different_provider = discover_history_sources(AgentKind::Claude, &inputs, &saved);
        assert_eq!(different_provider.candidates.len(), 1);
        assert!(!different_provider.candidates[0].configured);
    }
}

#[test]
fn saved_sources_do_not_expand_the_bounded_discovery_candidate_list() {
    let temp = tempfile::tempdir().unwrap();
    let explicit = temp.path().join("explicit");
    let default = temp.path().join(".codex");
    let saved_only = temp.path().join("saved-only");
    for path in [&explicit, &default, &saved_only] {
        fs::create_dir(path).unwrap();
    }
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: Some(temp.path().to_owned()),
            source_env: Some(explicit.clone()),
        },
        &[saved_source(AgentKind::Codex, &saved_only, true)],
    );
    assert_eq!(result.candidates.len(), 2);
    assert_eq!(
        Path::new(&result.candidates[0].root),
        explicit.canonicalize().unwrap()
    );
    assert_eq!(
        Path::new(&result.candidates[1].root),
        default.canonicalize().unwrap()
    );
    assert!(result
        .candidates
        .iter()
        .all(|candidate| !candidate.configured));
}

#[test]
fn configured_source_checks_are_bounded_even_for_unvalidated_input() {
    let temp = tempfile::tempdir().unwrap();
    let mut sources = (0..MAX_CONFIGURED_SOURCES)
        .map(|index| {
            saved_source(
                AgentKind::Claude,
                &temp.path().join(format!("source-{index}")),
                false,
            )
        })
        .collect::<Vec<_>>();
    sources.push(saved_source(AgentKind::Codex, temp.path(), true));
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(temp.path().to_owned()),
        },
        &sources,
    );
    assert_eq!(result.candidates.len(), 1);
    assert!(!result.candidates[0].configured);
}

#[test]
fn grok_nested_probe_preserves_a_usable_root_and_describes_missing_or_invalid_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".grok");
    fs::create_dir(&root).unwrap();
    let inputs = HistorySourceDiscoveryInputs {
        home: None,
        source_env: Some(root.clone()),
    };

    let missing = discover_history_sources(AgentKind::Grok, &inputs, &[]);
    assert_eq!(missing.candidates.len(), 1);
    assert_eq!(
        missing.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
    assert!(missing.candidates[0]
        .message
        .as_deref()
        .unwrap()
        .contains("sessions"));
    assert!(missing.candidates[0]
        .message
        .as_deref()
        .unwrap()
        .contains("does not exist"));
    assert!(!root.join("sessions").exists());

    fs::write(root.join("sessions"), b"synthetic ordinary file").unwrap();
    let file = discover_history_sources(AgentKind::Grok, &inputs, &[]);
    assert_eq!(
        file.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
    assert!(file.candidates[0]
        .message
        .as_deref()
        .unwrap()
        .contains("sessions"));
    assert!(file.candidates[0]
        .message
        .as_deref()
        .unwrap()
        .contains("could not be checked"));
    assert_eq!(
        fs::read(root.join("sessions")).unwrap(),
        b"synthetic ordinary file"
    );

    fs::remove_file(root.join("sessions")).unwrap();
    fs::create_dir(root.join("sessions")).unwrap();
    let readable = discover_history_sources(AgentKind::Grok, &inputs, &[]);
    assert_eq!(
        readable.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
    assert!(readable.candidates[0].message.is_none());
    assert_eq!(
        Path::new(&readable.candidates[0].root),
        root.canonicalize().unwrap()
    );
    assert_eq!(fs::read_dir(root.join("sessions")).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn grok_unreadable_sessions_provides_a_warning_but_keeps_the_root_found() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".grok");
    let sessions = root.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let original_permissions = fs::metadata(&sessions).unwrap().permissions();
    fs::set_permissions(&sessions, fs::Permissions::from_mode(0o000)).unwrap();
    let denial_enforced = fs::read_dir(&sessions)
        .err()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied);
    let result = discover_history_sources(
        AgentKind::Grok,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(root.clone()),
        },
        &[],
    );
    fs::set_permissions(&sessions, original_permissions).unwrap();
    if !denial_enforced {
        eprintln!(
            "Permission-denied assertion skipped: this process can read mode-000 directories"
        );
        return;
    }
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
    assert_eq!(
        Path::new(&result.candidates[0].root),
        root.canonicalize().unwrap()
    );
    let message = result.candidates[0].message.as_deref().unwrap();
    assert!(message.contains("sessions"));
    assert!(message.contains("permission was denied"));
}

#[test]
fn whitespace_quotes_and_shell_metacharacters_are_literal_path_characters() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp
        .path()
        .join("source with 'quotes';$(synthetic-never-execute)&[x]");
    fs::create_dir(&root).unwrap();
    let result = discover_history_sources(
        AgentKind::Claude,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(root.clone()),
        },
        &[],
    );
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
    assert_eq!(
        Path::new(&result.candidates[0].root),
        root.canonicalize().unwrap()
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn symlink_aliases_are_canonicalized_deduplicated_and_marked_configured() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".grok");
    let env_alias = temp.path().join("environment alias");
    let saved_alias = temp.path().join("saved alias");
    fs::create_dir(&root).unwrap();
    symlink(&root, &env_alias).unwrap();
    symlink(&root, &saved_alias).unwrap();
    let saved = vec![saved_source(AgentKind::Grok, &saved_alias, false)];
    let before = serde_json::to_vec(&saved).unwrap();
    let inputs = HistorySourceDiscoveryInputs {
        home: Some(temp.path().to_owned()),
        source_env: Some(env_alias.clone()),
    };
    let result = discover_history_sources(AgentKind::Grok, &inputs, &saved);
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        Path::new(&result.candidates[0].root),
        root.canonicalize().unwrap()
    );
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::Found
    );
    assert!(result.candidates[0].configured);
    assert_eq!(serde_json::to_vec(&saved).unwrap(), before);
    assert_eq!(fs::read_link(env_alias).unwrap(), root);
    assert_eq!(fs::read_link(saved_alias).unwrap(), root);

    let other_provider = vec![saved_source(AgentKind::Codex, &root, true)];
    let result = discover_history_sources(AgentKind::Grok, &inputs, &other_provider);
    assert!(!result.candidates[0].configured);
}

#[cfg(unix)]
#[test]
fn unreadable_synthetic_directory_reports_permission_denied() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("unreadable");
    fs::create_dir(&root).unwrap();
    let original_permissions = fs::metadata(&root).unwrap().permissions();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();
    let denial_enforced = fs::read_dir(&root)
        .err()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied);
    let result = discover_history_sources(
        AgentKind::Codex,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(root.clone()),
        },
        &[],
    );
    // Restore the fixture even when the test process can bypass Unix permission bits.
    fs::set_permissions(&root, original_permissions).unwrap();
    if !denial_enforced {
        eprintln!(
            "Permission-denied assertion skipped: this process can read mode-000 directories"
        );
        return;
    }
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(
        result.candidates[0].status,
        HistorySourceCandidateStatus::PermissionDenied
    );
    assert!(result.candidates[0].message.is_some());
}

fn snapshot_tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn visit(root: &Path, path: &Path, snapshot: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap().to_owned();
            if entry.file_type().unwrap().is_dir() {
                snapshot.insert(relative, None);
                visit(root, &path, snapshot);
            } else {
                snapshot.insert(relative, Some(fs::read(path).unwrap()));
            }
        }
    }
    let mut snapshot = BTreeMap::new();
    visit(root, root, &mut snapshot);
    snapshot
}

#[test]
fn discovery_never_changes_source_bytes_settings_or_directory_contents() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let settings_dir = temp.path().join("app");
    fs::create_dir(&settings_dir).unwrap();
    let mut sources = Vec::new();
    for (kind, directory) in SUPPORTED_PROVIDERS {
        let root = home.join(directory);
        fs::create_dir_all(root.join("sessions/nested")).unwrap();
        fs::write(
            root.join("sessions/synthetic.json"),
            b"{\"synthetic\":true}\n",
        )
        .unwrap();
        fs::write(root.join("sessions/nested/opaque.bin"), [0, 0xff, 7, 42]).unwrap();
        fs::write(
            root.join("config.json"),
            b"synthetic unparsed configuration\n",
        )
        .unwrap();
        sources.push(saved_source(kind, &root, false));
    }
    let source_bytes = serde_json::to_vec_pretty(&sources).unwrap();
    let settings_bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "sources": sources,
        "theme": "light",
        "syntheticMarker": "preserve exact settings bytes"
    }))
    .unwrap();
    fs::write(settings_dir.join("settings.json"), &settings_bytes).unwrap();
    let before = snapshot_tree(temp.path());

    for _ in 0..2 {
        for (kind, _) in SUPPORTED_PROVIDERS {
            let result = discover_history_sources(
                kind,
                &HistorySourceDiscoveryInputs {
                    home: Some(home.clone()),
                    source_env: None,
                },
                &sources,
            );
            assert_eq!(result.candidates.len(), 1);
            assert_eq!(
                result.candidates[0].status,
                HistorySourceCandidateStatus::Found
            );
            assert!(result.candidates[0].configured);
        }
    }
    assert_eq!(serde_json::to_vec_pretty(&sources).unwrap(), source_bytes);
    assert_eq!(
        fs::read(settings_dir.join("settings.json")).unwrap(),
        settings_bytes
    );
    assert_eq!(snapshot_tree(temp.path()), before);
}

#[test]
fn statuses_and_candidate_fields_serialize_for_camel_case_ipc() {
    for (status, expected) in [
        (HistorySourceCandidateStatus::Found, "found"),
        (HistorySourceCandidateStatus::Missing, "missing"),
        (
            HistorySourceCandidateStatus::PermissionDenied,
            "permissionDenied",
        ),
        (HistorySourceCandidateStatus::CheckFailed, "checkFailed"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), expected);
    }
    let temp = tempfile::tempdir().unwrap();
    let result = discover_history_sources(
        AgentKind::Claude,
        &HistorySourceDiscoveryInputs {
            home: None,
            source_env: Some(temp.path().to_owned()),
        },
        &[],
    );
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json["kind"], "claude");
    assert_eq!(json["supported"], true);
    assert_eq!(json["candidates"][0]["kind"], "claude");
    assert_eq!(json["candidates"][0]["status"], "found");
    assert_eq!(json["candidates"][0]["configured"], false);
    assert!(json["candidates"][0]["root"].is_string());
}
