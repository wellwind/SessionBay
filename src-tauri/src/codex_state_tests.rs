use super::*;
use serde_json::json;

fn metadata(id: &str, session: &str, status: serde_json::Value) -> ThreadMetadata {
    serde_json::from_value(json!({
        "id":id, "sessionId":session, "parentThreadId":null,
        "forkedFromId":null, "status":status,
        "preview":"PRIVATE PROMPT", "cwd":"/private/project", "turns":[],
    }))
    .unwrap()
}

#[test]
fn runtime_status_is_authoritative_and_unknown_flags_fail_closed() {
    for (wire, expected) in [
        (json!({"type":"idle"}), Observation::Idle),
        (json!({"type":"systemError"}), Observation::Failed),
        (json!({"type":"notLoaded"}), Observation::Unknown),
        (json!({"type":"futureStatus"}), Observation::Unknown),
        (json!({"type":"active","activeFlags":[]}), Observation::Busy),
        (
            json!({"type":"active","activeFlags":["waitingOnApproval"]}),
            Observation::AwaitingPermission,
        ),
        (
            json!({"type":"active","activeFlags":["waitingOnUserInput"]}),
            Observation::AwaitingInput,
        ),
        (
            json!({"type":"active","activeFlags":["waitingOnUserInput","waitingOnApproval"]}),
            Observation::AwaitingPermission,
        ),
        (
            json!({"type":"active","activeFlags":["futureFlag"]}),
            Observation::Unknown,
        ),
    ] {
        assert_eq!(
            metadata("thread", "tree", wire).status.observation(),
            expected
        );
    }
    assert!(serde_json::from_value::<Status>(json!({"type":"active"})).is_err());
}

#[test]
fn only_one_proven_non_fork_root_is_selected() {
    let mut child = metadata("child", "tree", json!({"type":"active","activeFlags":[]}));
    child.parent_thread_id = Some("root".into());
    let root = select_root(vec![
        child,
        metadata("root", "tree", json!({"type":"idle"})),
    ])
    .unwrap();
    assert_eq!(root.id, "root");
    assert_eq!(root.session_id, "tree");
    assert!(select_root(vec![]).is_none());
    assert!(select_root(vec![
        metadata("a", "tree", json!({"type":"idle"})),
        metadata("b", "tree", json!({"type":"idle"}))
    ])
    .is_none());
    let mut fork = metadata("fork", "original-tree", json!({"type":"idle"}));
    fork.forked_from_id = Some("source".into());
    assert!(select_root(vec![fork]).is_none());
    assert!(select_root(vec![metadata("root", "", json!({"type":"idle"}))]).is_none());
}

#[test]
fn old_or_incomplete_identity_never_binds_a_parent() {
    for missing in ["parentThreadId", "forkedFromId", "sessionId", "id"] {
        let mut wire = json!({"id":"root","sessionId":"tree","parentThreadId":null,"forkedFromId":null,"status":{"type":"idle"}});
        wire.as_object_mut().unwrap().remove(missing);
        assert!(
            serde_json::from_value::<ThreadMetadata>(wire).is_err(),
            "{missing}"
        );
    }
}

#[test]
fn privacy_and_request_correlation_do_not_require_transcripts() {
    let payload = json!({"id":3,"result":{"thread":{
        "id":"root","sessionId":"tree","parentThreadId":null,"forkedFromId":null,
        "status":{"type":"active","activeFlags":[]},"preview":"PRIVATE".repeat(10000),
        "turns":[{"items":[{"text":"SECRET"}]}], "credentials":{"access_token":"SECRET"}
    }}})
    .to_string();
    let result: ThreadRead = parse_reply(payload.as_bytes(), 3).unwrap().unwrap();
    let report = Reporter::default().snapshot(Some(result.thread)).unwrap();
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("PRIVATE") && !encoded.contains("SECRET"));
    assert_eq!(report.session, "tree");
    assert_eq!(report.turn, None);
    assert!(parse_reply::<ThreadRead>(payload.as_bytes(), 4).is_err());
    assert!(parse_reply::<ThreadRead>(br#"{"id":3,"error":{"message":"PRIVATE"}}"#, 3).is_err());
    assert!(parse_reply::<ThreadRead>(
        br#"{"method":"item/agentMessage/delta","params":{"delta":"PRIVATE"}}"#,
        3
    )
    .unwrap()
    .is_none());
    assert!(parse_reply::<ThreadRead>(br#"{"id":3,"method":"item/commandExecution/requestApproval","params":{"command":"PRIVATE"}}"#,3).is_err());
}

#[test]
fn snapshots_are_source_ordered_across_loss_clear_and_reconnection() {
    let mut reporter = Reporter::default();
    assert!(reporter.snapshot(None).is_none());
    let busy = reporter
        .snapshot(Some(metadata(
            "a",
            "tree-a",
            json!({"type":"active","activeFlags":[]}),
        )))
        .unwrap();
    let disconnected = reporter.snapshot(None).unwrap();
    let next = reporter
        .snapshot(Some(metadata("b", "tree-b", json!({"type":"idle"}))))
        .unwrap();
    assert_eq!(
        (busy.sequence, disconnected.sequence, next.sequence),
        (1, 2, 3)
    );
    assert_eq!(disconnected.observation, Observation::Unknown);
    assert_eq!(disconnected.session, "tree-a");
    assert_eq!(next.session, "tree-b");
    assert_eq!(next.observation, Observation::Idle);
    reporter.sequence = u64::MAX;
    assert!(reporter.snapshot(None).is_none());
}

#[test]
fn loaded_thread_discovery_is_bounded_and_complete() {
    let parse = |wire| {
        serde_json::from_value::<LoadedThreads>(wire)
            .unwrap()
            .validate()
    };
    assert_eq!(
        parse(json!({"data":["b","a"],"nextCursor":null})).unwrap(),
        vec!["a", "b"]
    );
    for wire in [
        json!({"data":["a","a"],"nextCursor":null}),
        json!({"data":["a"],"nextCursor":"more"}),
        json!({"data":[""],"nextCursor":null}),
        json!({"data":["bad\n"],"nextCursor":null}),
    ] {
        assert!(parse(wire).is_err());
    }
    assert!(parse(
        json!({"data":(0..65).map(|n|n.to_string()).collect::<Vec<_>>(),"nextCursor":null})
    )
    .is_err());
    assert!(serde_json::from_value::<LoadedThreads>(json!({"data":[]})).is_err());
}

#[test]
fn wrapping_preserves_argv_environment_and_no_shell_or_config_writes() {
    let original = vec![
        "resume",
        "real-id",
        "-c",
        "notify=['/private/original']",
        "--enable",
        "hooks",
        "--no-daemon",
        "--",
        "prompt ; $(touch impossible)",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let (server, tui) = split_arguments(&original).unwrap();
    assert_eq!(
        server,
        vec!["-c", "notify=['/private/original']", "--enable", "hooks"]
    );
    assert!(tui.contains(&"resume".into()));
    assert!(tui.contains(&"prompt ; $(touch impossible)".into()));
    assert!(!tui.contains(&"--no-daemon".into()));
    assert!(split_arguments(&["--remote=unix:///other".into()]).is_err());
    assert!(split_arguments(&["-c".into()]).is_err());
    let mut spec = LaunchSpec {
        executable: "/provider path/codex".into(),
        args: original.clone(),
        cwd: "/project".into(),
        env: std::collections::HashMap::from([("CODEX_HOME".into(), "/private/home".into())]),
        session_id: Some("catalog".into()),
        resume_key: Some("key".into()),
        pane_id: "pane".into(),
    };
    let before = spec.clone();
    let result = prepare(&mut spec, Path::new("/application/helper"));
    if cfg!(unix) {
        result.unwrap();
        assert_eq!(spec.executable, "/application/helper");
        assert_eq!(&spec.args[..3], &[ARGUMENT, "--", "/provider path/codex"]);
        assert_eq!(&spec.args[3..], &original);
        assert_eq!(spec.env, before.env);
        assert_eq!(spec.cwd, before.cwd);
        assert_eq!(spec.resume_key, before.resume_key);
    } else {
        assert!(result.is_err());
    }
}

#[test]
fn profile_fallback_preserves_exact_native_arguments() {
    for profile in [
        vec!["-p", "work"],
        vec!["--profile", "work"],
        vec!["--profile=work"],
        vec!["-pwork"],
    ] {
        let args = profile
            .into_iter()
            .chain(["resume", "existing", "-c", "notify=['private-helper']"])
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let original = args.clone();
        assert!(requires_native_profile(&args));
        assert_eq!(args, original);
    }
    assert!(!requires_native_profile(&[
        "--".into(),
        "--profile=prompt-text".into()
    ]));
}

#[cfg(unix)]
#[test]
fn socket_directory_is_private_and_removed_after_scope() {
    use std::os::unix::fs::MetadataExt;
    let directory = super::unix::private_directory().unwrap();
    let path = directory.path().to_path_buf();
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(&path).unwrap().uid(), unsafe {
        libc::geteuid()
    });
    drop(directory);
    assert!(!path.exists());
}

#[cfg(unix)]
mod transport {
    use super::*;
    use std::{
        io::{self, Cursor, Read, Write},
        sync::{Arc, Mutex},
    };
    use tungstenite::{
        protocol::{
            frame::{
                coding::{Data, OpCode},
                Frame,
            },
            Role, WebSocketConfig,
        },
        WebSocket,
    };

    struct ScriptedStream {
        incoming: Cursor<Vec<u8>>,
        outgoing: Arc<Mutex<Vec<u8>>>,
    }
    impl Read for ScriptedStream {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.incoming.read(bytes)
        }
    }
    impl Write for ScriptedStream {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.outgoing.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    fn client(
        replies: Vec<serde_json::Value>,
    ) -> (
        super::super::unix::Client<ScriptedStream>,
        Arc<Mutex<Vec<u8>>>,
    ) {
        let mut incoming = Vec::new();
        for reply in replies {
            Frame::message(
                reply.to_string().into_bytes(),
                OpCode::Data(Data::Text),
                true,
            )
            .format(&mut incoming)
            .unwrap();
        }
        let outgoing = Arc::new(Mutex::new(Vec::new()));
        let stream = ScriptedStream {
            incoming: Cursor::new(incoming),
            outgoing: Arc::clone(&outgoing),
        };
        let socket = WebSocket::from_raw_socket(
            stream,
            Role::Client,
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(1024 * 1024))
                    .max_frame_size(Some(1024 * 1024)),
            ),
        );
        (
            super::super::unix::Client::from_socket(socket).unwrap(),
            outgoing,
        )
    }
    fn loaded(id: u64, data: Vec<&str>) -> serde_json::Value {
        json!({"id":id,"result":{"data":data,"nextCursor":null}})
    }
    fn read(id: u64, thread: &str, status: serde_json::Value) -> serde_json::Value {
        json!({"id":id,"result":{"thread":{"id":thread,"sessionId":"tree","parentThreadId":null,"forkedFromId":null,"status":status,"preview":"PRIVATE PREVIEW","turns":[]}}})
    }
    fn sent(outgoing: &Arc<Mutex<Vec<u8>>>) -> Vec<serde_json::Value> {
        let bytes = outgoing.lock().unwrap().clone();
        let stream = ScriptedStream {
            incoming: Cursor::new(bytes),
            outgoing: Arc::new(Mutex::new(Vec::new())),
        };
        let mut server = WebSocket::from_raw_socket(stream, Role::Server, None);
        let mut results = Vec::new();
        while let Ok(tungstenite::Message::Text(text)) = server.read() {
            results.push(serde_json::from_str(&text).unwrap());
        }
        results
    }
    #[test]
    fn websocket_snapshots_request_only_metadata_and_handle_disconnect() {
        let (mut client, outgoing) = client(vec![
            json!({"id":1,"result":{}}),
            loaded(2, vec!["root"]),
            json!({"method":"unrelated/notification","params":{"text":"PRIVATE"}}),
            read(
                3,
                "root",
                json!({"type":"active","activeFlags":["waitingOnApproval"]}),
            ),
            loaded(4, vec!["root"]),
        ]);
        let snapshot = client.snapshot().unwrap().unwrap();
        assert_eq!(
            snapshot.status.observation(),
            Observation::AwaitingPermission
        );
        assert_eq!(snapshot.session_id, "tree");
        assert!(client.snapshot().is_err());
        let requests = sent(&outgoing);
        let methods = requests
            .iter()
            .map(|r| r["method"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            vec![
                "initialize",
                "initialized",
                "thread/loaded/list",
                "thread/read",
                "thread/loaded/list",
                "thread/loaded/list"
            ]
        );
        assert_eq!(
            requests[0]["params"]["clientInfo"]["name"],
            "codex_app_server_daemon"
        );
        assert_eq!(
            requests[3]["params"],
            json!({"threadId":"root","includeTurns":false})
        );
        assert!(!serde_json::to_string(&requests)
            .unwrap()
            .contains("PRIVATE"));
    }
    #[test]
    fn changing_loaded_set_never_emits_an_ambiguous_root() {
        let (mut client, _) = client(vec![
            json!({"id":1,"result":{}}),
            loaded(2, vec!["old"]),
            read(3, "old", json!({"type":"active","activeFlags":[]})),
            loaded(4, vec!["new", "old"]),
            loaded(5, vec![]),
            loaded(6, vec![]),
            loaded(7, vec!["new"]),
            read(8, "new", json!({"type":"idle"})),
            loaded(9, vec!["new"]),
        ]);
        assert!(client.snapshot().unwrap().is_none());
        assert!(client.snapshot().unwrap().is_none());
        assert_eq!(client.snapshot().unwrap().unwrap().id, "new");
    }
    #[test]
    fn id_mismatch_and_mutating_rpc_fail_without_approval_replies() {
        let (mut client, outgoing) = client(vec![
            json!({"id":1,"result":{}}),
            loaded(2, vec!["root"]),
            read(3, "other", json!({"type":"idle"})),
        ]);
        for method in [
            "thread/start",
            "thread/resume",
            "turn/start",
            "turn/interrupt",
            "account/login/start",
        ] {
            assert!(client
                .request::<serde::de::IgnoredAny, _>(method, json!({}))
                .is_err());
        }
        assert!(client.snapshot().is_err());
        assert_eq!(sent(&outgoing).len(), 4);
    }
    #[test]
    fn stale_rpc_id_and_unsolicited_server_request_fail_closed() {
        for reply in [
            loaded(999, vec!["root"]),
            json!({"id":2,"method":"item/commandExecution/requestApproval","params":{"command":"PRIVATE"}}),
        ] {
            let (mut client, outgoing) = client(vec![json!({"id":1,"result":{}}), reply]);
            assert!(client.snapshot().is_err());
            assert_eq!(sent(&outgoing).len(), 3);
        }
    }
}

#[test]
fn all_resume_and_fork_launches_stay_native_without_argument_changes() {
    for mode in ["resume", "fork"] {
        for extra in [
            vec!["session-id"],
            vec!["--last"],
            vec!["session-id", "--sandbox", "read-only", "-a", "untrusted"],
        ] {
            let args = std::iter::once(mode)
                .chain(extra)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let original = args.clone();
            assert!(requires_native_session(&args));
            assert_eq!(args, original);
        }
    }
    assert!(!requires_native_session(&["--".into(), "resume".into()]));
    assert!(!requires_native_session(
        &["Explain the word resume".into()]
    ));
}

#[test]
fn remote_cwd_detection_preserves_original_options_and_prompt_boundary() {
    for args in [
        vec!["--cd", "/selected"],
        vec!["--cd=/selected"],
        vec!["-C", "/selected"],
        vec!["-C/selected"],
    ] {
        let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        assert!(has_explicit_cwd(&args));
    }
    assert!(!has_explicit_cwd(&[]));
    assert!(!has_explicit_cwd(&[
        "--".into(),
        "--cd".into(),
        "/prompt".into()
    ]));
    assert!(!has_explicit_cwd(&["--".into(), "-C/prompt".into()]));
}
