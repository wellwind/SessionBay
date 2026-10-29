//! Wire schemas copied from bc8031e (pre-home-policy broker), kept test-only.
//! Do not relax these to match newer messages: strict unknown-field rejection is the regression.
use super::*;
use serde::{Deserialize, Serialize};
#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "command",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LegacyRequest {
    Hello {
        protocol: u32,
    },
    List {
        generation: String,
    },
    Launch {
        generation: String,
        spec: Box<LaunchSpec>,
        kind: String,
        project_id: Option<String>,
        profile_id: Option<String>,
        resume_id: Option<String>,
        cols: u16,
        rows: u16,
    },
    FindResume {
        generation: String,
        key: String,
    },
    Poll {
        generation: String,
        runtime_id: String,
        after: Option<u64>,
    },
    Write {
        generation: String,
        runtime_id: String,
        data: String,
    },
    Resize {
        generation: String,
        runtime_id: String,
        cols: u16,
        rows: u16,
    },
    Stop {
        generation: String,
        runtime_id: String,
    },
    Forget {
        generation: String,
        runtime_id: String,
    },
    /// Explicit process-management action, never used by desktop close/drop.
    Shutdown {
        generation: String,
    },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "result",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum LegacyResponse {
    Hello { protocol: u32, generation: String },
    Records { records: Vec<RuntimeRecord> },
    Runtime { info: Option<RuntimeInfo> },
    Events { events: Vec<UiEvent> },
    Ok,
    Error { message: String },
}

fn hello(capabilities: Option<serde_json::Value>) -> Response {
    let mut value =
        serde_json::json!({"result":"hello", "protocol":1, "generation":"synthetic-generation"});
    if let Some(capabilities) = capabilities {
        value["capabilities"] = capabilities;
    }
    serde_json::from_value(value).unwrap()
}
fn launch() -> (LaunchSpec, LaunchRequest) {
    let request = LaunchRequest {
        kanban_card_id: None,
        pane_id: "synthetic-pane".into(),
        kind: "shell".into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: None,
        profile_id: Some("chosen-profile".into()),
        cols: 80,
        rows: 24,
    };
    let spec = LaunchSpec {
        executable: "/synthetic/shell".into(),
        args: vec!["literal argument".into()],
        cwd: dirs::home_dir().unwrap(),
        env: HashMap::new(),
        session_id: None,
        resume_key: None,
        pane_id: request.pane_id.clone(),
    };
    (spec, request)
}
#[test]
fn new_home_field_reproduces_old_decoder_failure_and_negotiation_omits_only_that_field() {
    let modern = BrokerClient::from_hello(
        Path::new("/unused"),
        hello(Some(serde_json::json!(["homeDirectory"]))),
    )
    .unwrap();
    let legacy = BrokerClient::from_hello(Path::new("/unused"), hello(None)).unwrap();
    let (spec, request) = launch();
    let mut modern_wire =
        serde_json::to_value(modern.launch_request(spec.clone(), &request)).unwrap();
    let error = serde_json::from_value::<LegacyRequest>(modern_wire.clone()).unwrap_err();
    assert!(
        error.to_string().contains("unknown field `homeDirectory`"),
        "{error}"
    );
    assert_eq!(
        modern_wire.as_object_mut().unwrap().remove("homeDirectory"),
        Some(true.into())
    );
    let legacy_wire = serde_json::to_value(legacy.launch_request(spec, &request)).unwrap();
    assert_eq!(modern_wire, legacy_wire); // Includes the exact resolved cwd, null project, and chosen profile.
    let old: LegacyRequest = serde_json::from_value(legacy_wire.clone()).unwrap();
    assert!(matches!(
        old,
        LegacyRequest::Launch {
            project_id: None,
            profile_id: Some(_),
            ..
        }
    ));
    assert!(serde_json::from_value::<Request>(legacy_wire.clone()).is_ok());
    let mut unknown = legacy_wire.clone();
    unknown["unknownPolicy"] = true.into();
    assert!(serde_json::from_value::<LegacyRequest>(unknown.clone()).is_err());
    assert!(serde_json::from_value::<Request>(unknown).is_err());
    let mut invalid = legacy_wire;
    invalid["cols"] = "80".into();
    assert!(serde_json::from_value::<LegacyRequest>(invalid.clone()).is_err());
    assert!(serde_json::from_value::<Request>(invalid).is_err());
}
#[test]
fn hello_extensions_are_backward_compatible_and_unknown_capabilities_do_not_enable_home_policy() {
    let new_hello = hello(Some(serde_json::json!(["homeDirectory", "futureFeature"])));
    let old: LegacyResponse =
        serde_json::from_value(serde_json::to_value(&new_hello).unwrap()).unwrap();
    assert!(matches!(old, LegacyResponse::Hello { protocol: 1, .. }));
    for capabilities in [
        None,
        Some(serde_json::json!([])),
        Some(serde_json::json!(["unknown"])),
    ] {
        let client = BrokerClient::from_hello(Path::new("/unused"), hello(capabilities)).unwrap();
        assert!(!client.inner.home_directory_supported);
    }
    let incompatible: Response = serde_json::from_value(
        serde_json::json!({"result":"hello", "protocol":2,"generation":"old"}),
    )
    .unwrap();
    assert!(BrokerClient::from_hello(Path::new("/unused"), incompatible).is_err());
    // The request remains exactly the old hello shape: old hosts deny unknown fields.
    let request = serde_json::to_value(Request::Hello { protocol: PROTOCOL }).unwrap();
    assert!(serde_json::from_value::<LegacyRequest>(request).is_ok());
}
#[test]
fn project_and_resume_wire_scope_is_unchanged_by_legacy_negotiation() {
    let modern = BrokerClient::from_hello(
        Path::new("/unused"),
        hello(Some(serde_json::json!(["homeDirectory"]))),
    )
    .unwrap();
    let legacy = BrokerClient::from_hello(Path::new("/unused"), hello(None)).unwrap();
    let (mut spec, mut request) = launch();
    request.kind = "codex".into();
    request.project_id = Some("project".into());
    request.resume_id = Some("resume".into());
    spec.resume_key = Some("provider-scoped-key".into());
    let new = serde_json::to_value(modern.launch_request(spec.clone(), &request)).unwrap();
    let old = serde_json::to_value(legacy.launch_request(spec, &request)).unwrap();
    assert_eq!(new, old);
    assert!(!old.as_object().unwrap().contains_key("homeDirectory"));
    assert!(matches!(
        serde_json::from_value::<LegacyRequest>(old).unwrap(),
        LegacyRequest::Launch {
            project_id: Some(_),
            resume_id: Some(_),
            ..
        }
    ));
}

#[test]
fn home_policy_validation_and_generation_authority_are_preserved() {
    let directory = tempfile::tempdir().unwrap();
    let host = super::super::Host::open(directory.path().into()).unwrap();
    let client = BrokerClient::from_hello(
        Path::new("/unused"),
        Response::Hello {
            protocol: PROTOCOL,
            generation: host.generation.clone(),
            capabilities: vec![HOME_DIRECTORY_CAPABILITY.into()],
            ui_lease_offer: None,
        },
    )
    .unwrap();
    for field in [
        "projectId",
        "resumeId",
        "sessionId",
        "resumeKey",
        "kind",
        "generation",
    ] {
        let (spec, request) = launch();
        let mut wire = serde_json::to_value(client.launch_request(spec, &request)).unwrap();
        match field {
            "sessionId" | "resumeKey" => wire["spec"][field] = "forbidden".into(),
            "kind" => wire[field] = "codex".into(),
            _ => wire[field] = "forbidden".into(),
        }
        let request = serde_json::from_value(wire).unwrap();
        let error = host.handle(request).unwrap_err();
        assert!(
            error.contains("unscoped shell") || error.contains("broker restarted"),
            "{field}: {error}"
        );
        assert!(host.runtime.list().is_empty());
    }
}

#[cfg(unix)]
#[test]
fn legacy_encoded_global_shell_launches_resolved_home_without_a_project() {
    let directory = tempfile::tempdir().unwrap();
    let host = super::super::Host::open(directory.path().into()).unwrap();
    let client = BrokerClient::from_hello(
        Path::new("/unused"),
        Response::Hello {
            protocol: PROTOCOL,
            generation: host.generation.clone(),
            capabilities: vec![],
            ui_lease_offer: None,
        },
    )
    .unwrap();
    let (mut spec, request) = launch();
    spec.executable = "/bin/sh".into();
    spec.args = vec!["-c".into(), "printf synthetic-ready; read line".into()];
    let wire = serde_json::to_value(client.launch_request(spec, &request)).unwrap();
    assert!(serde_json::from_value::<LegacyRequest>(wire.clone()).is_ok());
    let response = host.handle(serde_json::from_value(wire).unwrap()).unwrap();
    let Response::Runtime { info: Some(info) } = response else {
        panic!("missing runtime")
    };
    host.runtime.shutdown().unwrap();
    assert_eq!(
        PathBuf::from(info.cwd),
        dirs::home_dir().unwrap().canonicalize().unwrap()
    );
    let records = host.records();
    assert_eq!(records.len(), 1);
    assert!(records[0].project_id.is_none());
    assert_eq!(records[0].profile_id.as_deref(), Some("chosen-profile"));
}

#[test]
fn activity_poll_negotiation_omits_every_new_field_for_legacy_hosts() {
    for capabilities in [
        None,
        Some(serde_json::json!([])),
        Some(serde_json::json!(["future"])),
    ] {
        let client = BrokerClient::from_hello(Path::new("/unused"), hello(capabilities)).unwrap();
        assert!(!client.inner.activity_supported);
        let request = Request::Poll {
            generation: client.generation(),
            runtime_id: "r".into(),
            after: Some(0),
            agent_activity: client.inner.activity_supported,
            terminal_status: client.inner.terminal_status_supported,
            activity_after: None,
        };
        assert!(
            serde_json::from_value::<LegacyRequest>(serde_json::to_value(request).unwrap()).is_ok()
        );
        assert!(client
            .open_ordered_activity_publisher("r", crate::models::AgentKind::Claude, "session")
            .is_err());
    }
    let client = BrokerClient::from_hello(
        Path::new("/unused"),
        hello(Some(serde_json::json!(["orderedAgentActivity"]))),
    )
    .unwrap();
    assert!(client.inner.activity_supported);
    let wire = serde_json::to_value(Request::Poll {
        generation: client.generation(),
        runtime_id: "r".into(),
        after: Some(0),
        agent_activity: true,
        terminal_status: false,
        activity_after: None,
    })
    .unwrap();
    assert!(serde_json::from_value::<LegacyRequest>(wire).is_err());
}

#[test]
fn terminal_status_has_an_independent_negotiated_capability() {
    for (capabilities, expected) in [
        (serde_json::json!(["orderedAgentActivity"]), false),
        (
            serde_json::json!(["orderedAgentActivity", "nativeTerminalStatusV1"]),
            true,
        ),
    ] {
        let client =
            BrokerClient::from_hello(Path::new("/unused"), hello(Some(capabilities))).unwrap();
        assert_eq!(client.inner.terminal_status_supported, expected);
        let wire = serde_json::to_value(Request::Poll {
            generation: client.generation(),
            runtime_id: "r".into(),
            after: None,
            agent_activity: true,
            terminal_status: client.inner.terminal_status_supported,
            activity_after: None,
        })
        .unwrap();
        assert_eq!(
            wire.get("terminalStatus"),
            expected.then_some(&serde_json::Value::Bool(true))
        );
    }
}

#[test]
fn legacy_hook_preflight_is_local_and_allows_explicit_opt_out() {
    let client = BrokerClient::from_hello(Path::new("/unused-no-transport"), hello(None)).unwrap();
    let (mut spec, request) = launch();
    spec.env
        .insert(crate::provider_hooks::OPT_IN.into(), "live".into());
    assert_eq!(
        client.check_provider_hooks(&spec),
        Err(LaunchPreflightError::MissingProviderHooks)
    );
    let error = client
        .launch_unattached(spec.clone(), &request)
        .unwrap_err();
    assert_eq!(
        error,
        LaunchPreflightError::MissingProviderHooks.to_string()
    );
    // The subscribed path must reject locally too, before transport or attach.
    let subscribed_error = client
        .launch(
            spec.clone(),
            &request,
            "unused-attachment".into(),
            std::sync::Arc::new(|_| panic!("preflight cannot emit or attach")),
        )
        .unwrap_err();
    assert_eq!(subscribed_error, error);
    assert!(error.contains("was not started this time"));
    assert!(error.contains("existing work is not affected"));
    assert!(!error.contains("end it first"));
    spec.env.remove(crate::provider_hooks::OPT_IN);
    assert!(client.check_provider_hooks(&spec).is_ok());
}

#[test]
fn hooks_preflight_classifies_only_missing_capability_and_preserves_spec() {
    let (mut spec, _) = launch();
    spec.env
        .insert(crate::provider_hooks::OPT_IN.into(), "live".into());
    spec.env.insert("SYNTHETIC_ENV".into(), "preserved".into());
    let before = serde_json::to_value(&spec).unwrap();
    for (capabilities, expected) in [
        (None, Err(LaunchPreflightError::MissingProviderHooks)),
        (
            Some(serde_json::json!(["unknown-capability"])),
            Err(LaunchPreflightError::MissingProviderHooks),
        ),
        (
            Some(serde_json::json!([crate::provider_hooks::CAPABILITY])),
            Ok(()),
        ),
    ] {
        let client =
            BrokerClient::from_hello(Path::new("/unused-no-transport"), hello(capabilities))
                .unwrap();
        assert_eq!(client.check_provider_hooks(&spec), expected);
        assert_eq!(serde_json::to_value(&spec).unwrap(), before);
        let mut opted_out = spec.clone();
        opted_out.env.remove(crate::provider_hooks::OPT_IN);
        assert!(client.check_provider_hooks(&opted_out).is_ok());
    }
}

#[test]
fn lease_offer_is_compatible_with_old_response_decoder_and_requests_stay_negotiated() {
    let temp = tempfile::tempdir().unwrap();
    let host = super::super::Host::open(temp.path().into()).unwrap();
    let response = host.handle(Request::Hello { protocol: PROTOCOL }).unwrap();
    let wire = serde_json::to_value(&response).unwrap();
    assert!(wire["uiLeaseOffer"].is_string());
    assert!(matches!(
        serde_json::from_value::<LegacyResponse>(wire).unwrap(),
        LegacyResponse::Hello {
            protocol: PROTOCOL,
            ..
        }
    ));
    // No exchange is attempted for an old broker, even when starting a native owner.
    let old = BrokerClient::from_hello(Path::new("/unused-do-not-connect"), hello(None)).unwrap();
    assert!(old.start_ui_owner().unwrap().is_none());
    let unknown = BrokerClient::from_hello(
        Path::new("/unused-do-not-connect"),
        hello(Some(serde_json::json!(["futureLease"]))),
    )
    .unwrap();
    assert!(unknown.start_ui_owner().unwrap().is_none());
    assert!(serde_json::from_value::<LegacyRequest>(
        serde_json::to_value(Request::Hello { protocol: PROTOCOL }).unwrap()
    )
    .is_ok());
    assert!(serde_json::from_value::<LegacyRequest>(
        serde_json::to_value(Request::AcquireUiLease {
            generation: "g".into(),
            offer: "o".into()
        })
        .unwrap()
    )
    .is_err());
}
