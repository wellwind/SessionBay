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
    assert!(legacy.compatibility_warning().is_some());
    assert!(modern.compatibility_warning().is_none());
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
