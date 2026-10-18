use super::*;
use serde_json::json;
fn payload(status: &str) -> Vec<u8> {
    json!({"type":"session.status","properties":{"sessionID":"synthetic-session","status":{"type":status}}}).to_string().into_bytes()
}
fn state() -> (State, Capability) {
    let state = State::new("runtime-a", AgentKind::OpenCode, "synthetic-session").unwrap();
    let cap = state.capability.as_ref().unwrap().clone();
    (state, cap)
}
fn cursor(event: &UiEvent) -> Cursor {
    let UiEvent::AgentActivity {
        generation,
        revision,
        ..
    } = event
    else {
        panic!("missing activity")
    };
    Cursor {
        generation: generation.clone(),
        revision: *revision,
    }
}
fn observation(event: &UiEvent) -> (Option<Observation>, u64) {
    let UiEvent::AgentActivity {
        observation,
        valid_for_ms,
        ..
    } = event
    else {
        panic!("missing activity")
    };
    (*observation, *valid_for_ms)
}
#[test]
fn wire_fixture_matches_backend_serialization_without_a_terminal_ack_sequence() {
    let event = UiEvent::AgentActivity {
        runtime_id: "runtime-a".into(),
        generation: "synthetic-generation".into(),
        revision: 1,
        observation: Some(Observation::Busy),
        valid_for_ms: 1000,
    };
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/agent-activity/busy-event.json"
    ))
    .unwrap();
    assert_eq!(serde_json::to_value(&event).unwrap(), fixture);
    assert!(event.sequence().is_none());
    assert!(serde_json::from_value::<UiEvent>(fixture).is_ok());
}
#[test]
fn polls_do_not_renew_observations_and_expiry_is_one_new_revision() {
    let (mut state, cap) = state();
    let now = Instant::now();
    state
        .publish(&cap, 1, "session.status", &payload("busy"), now)
        .unwrap();
    let first = state.poll(None, now).unwrap();
    let after = cursor(&first);
    assert_eq!(observation(&first), (Some(Observation::Busy), 30000));
    for seconds in [0, 1, 10, 29] {
        assert!(state
            .poll(Some(&after), now + Duration::from_secs(seconds))
            .is_none());
    }
    let reconnect = state.poll(None, now + Duration::from_secs(11)).unwrap();
    assert_eq!(cursor(&reconnect), after);
    assert_eq!(observation(&reconnect), (Some(Observation::Busy), 19000));
    let expired = state
        .poll(Some(&after), now + Duration::from_secs(30))
        .unwrap();
    assert_eq!(observation(&expired), (None, 0));
    assert_eq!(cursor(&expired).revision, after.revision + 1);
    assert!(state
        .poll(Some(&cursor(&expired)), now + Duration::from_secs(60))
        .is_none());
    assert_eq!(
        cursor(&state.poll(None, now + Duration::from_secs(61)).unwrap()),
        cursor(&expired)
    );
}
#[test]
fn duplicate_replay_and_gaps_revoke_the_generation_without_refreshing_it() {
    for sequence in [0, 1, 3, u64::MAX] {
        let (mut state, cap) = state();
        let now = Instant::now();
        state
            .publish(&cap, 1, "session.status", &payload("busy"), now)
            .unwrap();
        assert!(state
            .publish(&cap, sequence, "session.status", &payload("idle"), now)
            .is_err());
        assert_eq!(observation(&state.poll(None, now).unwrap()), (None, 0));
        assert!(state
            .publish(&cap, 2, "session.status", &payload("idle"), now)
            .is_err());
    }
}
#[test]
fn wrong_capability_does_not_publish_or_invalidate_another_binding() {
    let (mut state, cap) = state();
    let now = Instant::now();
    state
        .publish(&cap, 1, "session.status", &payload("busy"), now)
        .unwrap();
    let before = cursor(&state.poll(None, now).unwrap());
    assert!(state
        .publish(
            &Capability::new(),
            2,
            "session.status",
            &payload("idle"),
            now
        )
        .is_err());
    let unchanged = state.poll(None, now).unwrap();
    assert_eq!(cursor(&unchanged), before);
    assert_eq!(observation(&unchanged).0, Some(Observation::Busy));
    assert_eq!(format!("{cap:?}"), "[redacted activity capability]");
    assert!(!format!(
        "{:?}",
        Response::ActivityOpened {
            activity_generation: "synthetic".into(),
            capability: cap.clone()
        }
    )
    .contains(&cap.0));
}
#[test]
fn payload_session_registration_schema_and_rate_limits_fail_closed() {
    let now = Instant::now();
    let mut wrong: serde_json::Value = serde_json::from_slice(&payload("idle")).unwrap();
    wrong["properties"]["sessionID"] = "different-session".into();
    for (event, bytes) in [
        ("session.status", wrong.to_string().into_bytes()),
        ("wrong.registration", payload("idle")),
        ("session.status", b"not-json".to_vec()),
        ("session.status", vec![b' '; MAX_PAYLOAD_BYTES + 1]),
        ("bad\nregistration", payload("idle")),
    ] {
        let (mut state, cap) = state();
        state
            .publish(&cap, 1, "session.status", &payload("busy"), now)
            .unwrap();
        assert!(state.publish(&cap, 2, event, &bytes, now).is_err());
        assert_eq!(observation(&state.poll(None, now).unwrap()), (None, 0));
        assert!(state.capability.is_none());
    }
    let (mut state, cap) = state();
    for seq in 1..=MAX_EVENTS_PER_SECOND as u64 {
        state
            .publish(&cap, seq, "session.status", &payload("busy"), now)
            .unwrap();
    }
    assert!(state
        .publish(
            &cap,
            MAX_EVENTS_PER_SECOND as u64 + 1,
            "session.status",
            &payload("idle"),
            now
        )
        .is_err());
    assert_eq!(observation(&state.poll(None, now).unwrap()), (None, 0));
}
#[test]
fn rate_window_is_bounded_and_reopens_after_elapsed_second() {
    let (mut state, cap) = state();
    let now = Instant::now();
    for seq in 1..=MAX_EVENTS_PER_SECOND as u64 {
        state
            .publish(&cap, seq, "session.status", &payload("busy"), now)
            .unwrap();
    }
    state
        .publish(
            &cap,
            MAX_EVENTS_PER_SECOND as u64 + 1,
            "session.status",
            &payload("idle"),
            now + Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(state.recent.len(), 1);
}
#[test]
fn unknown_clears_and_children_consume_sequence_without_changing_parent_freshness() {
    let now = Instant::now();
    let mut state = State::new("runtime-a", AgentKind::Claude, "synthetic-session").unwrap();
    let cap = state.capability.as_ref().unwrap().clone();
    let hook = |event: &str, prompt: &str| {
        json!({"hook_event_name":event,"session_id":"synthetic-session","prompt_id":prompt})
            .to_string()
            .into_bytes()
    };
    state
        .publish(
            &cap,
            1,
            "UserPromptSubmit",
            &hook("UserPromptSubmit", "turn-new"),
            now,
        )
        .unwrap();
    let before = state.poll(None, now).unwrap();
    let child=json!({"hook_event_name":"PostToolUse","session_id":"synthetic-session","agent_id":"child"}).to_string().into_bytes();
    state
        .publish(&cap, 2, "PostToolUse", &child, now + Duration::from_secs(1))
        .unwrap();
    assert!(state
        .poll(Some(&cursor(&before)), now + Duration::from_secs(1))
        .is_none());
    state
        .publish(
            &cap,
            3,
            "PreToolUse",
            &hook("PreToolUse", "turn-new"),
            now + Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(
        observation(&state.poll(None, now + Duration::from_secs(2)).unwrap()).0,
        Some(Observation::ToolPending)
    );
    state
        .publish(
            &cap,
            4,
            "NewUnreviewedEvent",
            &hook("NewUnreviewedEvent", "turn-old"),
            now + Duration::from_secs(3),
        )
        .unwrap();
    assert_eq!(
        observation(&state.poll(None, now + Duration::from_secs(3)).unwrap()),
        (None, 0)
    );
}
#[test]
fn closing_is_idempotent_and_reopening_changes_both_capability_and_generation() {
    let (mut original, cap) = state();
    let now = Instant::now();
    original
        .publish(&cap, 1, "session.status", &payload("busy"), now)
        .unwrap();
    original.close();
    let closed = original.poll(None, now).unwrap();
    original.close();
    assert_eq!(cursor(&original.poll(None, now).unwrap()), cursor(&closed));
    let (new, new_cap) = state();
    assert_ne!(new.binding.generation, original.binding.generation);
    assert!(!cap.matches(&new_cap));
}
#[test]
fn publisher_budget_reserves_control_slots_and_reclaims_released_permits() {
    let directory = tempfile::tempdir().unwrap();
    let host = Host::open(directory.path().into()).unwrap();
    assert!(host.activity_permits.available_permits() < super::super::MAX_CLIENTS);
    let mut permits = Vec::new();
    for _ in 0..super::super::MAX_ACTIVITY_PUBLISHERS {
        permits.push(
            Arc::clone(&host.activity_permits)
                .try_acquire_owned()
                .unwrap(),
        );
    }
    assert!(Arc::clone(&host.activity_permits)
        .try_acquire_owned()
        .is_err());
    permits.pop();
    assert!(Arc::clone(&host.activity_permits)
        .try_acquire_owned()
        .is_ok());
    drop(permits);
    assert_eq!(
        host.activity_permits.available_permits(),
        super::super::MAX_ACTIVITY_PUBLISHERS
    );
}
#[test]
fn revision_exhaustion_publishes_a_final_safe_unknown_and_closes() {
    let (mut state, cap) = state();
    state.revision = MAX_SAFE_REVISION - 1;
    let now = Instant::now();
    state
        .publish(&cap, 1, "session.status", &payload("busy"), now)
        .unwrap();
    let end = state.poll(None, now).unwrap();
    assert_eq!(cursor(&end).revision, MAX_SAFE_REVISION);
    assert_eq!(observation(&end), (None, 0));
    assert!(state.capability.is_none());
}
mod live {
    use super::*;
    use crate::{
        broker::{BrokerClient, RuntimeInfo},
        runtime::LaunchSpec,
        service::LaunchRequest,
    };
    use std::{collections::HashMap, path::Path, sync::mpsc, thread};
    fn spec(path: &Path, pane: &str) -> LaunchSpec {
        #[cfg(unix)]
        let (executable, args) = ("/bin/sh".to_owned(), vec!["-c".into(), "read line".into()]);
        #[cfg(windows)]
        let (executable, args) = (
            std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
                .to_string_lossy()
                .into_owned(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "$null = Read-Host".into(),
            ],
        );
        LaunchSpec {
            executable,
            args,
            cwd: path.into(),
            env: HashMap::new(),
            session_id: None,
            resume_key: None,
            pane_id: pane.into(),
        }
    }
    fn launch(host: &Arc<Host>, kind: &str, pane: &str) -> RuntimeInfo {
        match host
            .handle(Request::Launch {
                generation: host.generation.clone(),
                spec: Box::new(spec(&host.directory, pane)),
                kind: kind.into(),
                project_id: None,
                profile_id: None,
                resume_id: None,
                home_directory: false,
                cols: 80,
                rows: 24,
            })
            .unwrap()
        {
            Response::Runtime { info: Some(info) } => info,
            _ => panic!("missing runtime"),
        }
    }
    fn open(host: &Host, runtime: &str) -> (String, Capability) {
        match host
            .open_activity(runtime, AgentKind::OpenCode, "synthetic-session")
            .unwrap()
        {
            Response::ActivityOpened {
                activity_generation,
                capability,
            } => (activity_generation, capability),
            _ => panic!("missing publisher"),
        }
    }
    fn publish(
        host: &Host,
        runtime: &str,
        generation: &str,
        cap: &Capability,
        sequence: u64,
    ) -> Result<(Response, bool), String> {
        host.handle_activity(
            Request::PublishActivity {
                generation: host.generation.clone(),
                runtime_id: runtime.into(),
                activity_generation: generation.into(),
                capability: cap.clone(),
                sequence,
                registered_event: "session.status".into(),
                payload: payload("busy"),
            },
            runtime,
            generation,
        )
    }
    #[test]
    fn routing_generation_exit_and_legacy_poll_are_authoritative() {
        let directory = tempfile::tempdir().unwrap();
        let host = Host::open(directory.path().into()).unwrap();
        let agent = launch(&host, "opencode", "agent");
        let shell = launch(&host, "shell", "shell");
        assert!(host
            .open_activity("missing", AgentKind::OpenCode, "synthetic-session")
            .is_err());
        assert!(host
            .open_activity(&agent.id, AgentKind::Claude, "synthetic-session")
            .is_err());
        assert!(host
            .open_activity(&shell.id, AgentKind::OpenCode, "synthetic-session")
            .is_err());
        assert!(host
            .open_activity(&agent.id, AgentKind::OpenCode, "")
            .is_err());
        lock(&host.entries)
            .get_mut(&agent.id)
            .unwrap()
            .record
            .resume_id = Some("synthetic-session".into());
        assert!(host
            .open_activity(&agent.id, AgentKind::OpenCode, "wrong-session")
            .is_err());
        let (first, cap) = open(&host, &agent.id);
        publish(&host, &agent.id, &first, &cap, 1).unwrap();
        let Response::Events {events}=host.handle(serde_json::from_value(json!({"command":"poll","generation":host.generation,"runtimeId":agent.id,"after":null})).unwrap()).unwrap() else {panic!("missing poll")};
        assert!(events
            .iter()
            .all(|event| !matches!(event, UiEvent::AgentActivity { .. })));
        let wrong = Request::PublishActivity {
            generation: host.generation.clone(),
            runtime_id: shell.id.clone(),
            activity_generation: first.clone(),
            capability: cap.clone(),
            sequence: 2,
            registered_event: "session.status".into(),
            payload: payload("busy"),
        };
        assert!(host.handle_activity(wrong, &agent.id, &first).is_err());
        let (second, cap2) = open(&host, &agent.id);
        assert_ne!(first, second);
        assert!(publish(&host, &agent.id, &first, &cap, 2).is_err());
        publish(&host, &agent.id, &second, &cap2, 1).unwrap();
        host.close_activity(&agent.id, &first);
        assert_eq!(
            observation(&host.poll_activity(&agent.id, None, Instant::now()).unwrap()).0,
            Some(Observation::Busy)
        );
        #[cfg(unix)]
        host.runtime.write(&agent.id, "exit\n").unwrap();
        #[cfg(windows)]
        host.runtime.write(&agent.id, "exit\r").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while host.activity_runtime_live(&agent.id) {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            observation(&host.poll_activity(&agent.id, None, Instant::now()).unwrap()),
            (None, 0)
        );
        assert!(publish(&host, &agent.id, &second, &cap2, 2).is_err());
        assert!(host
            .open_activity(&agent.id, AgentKind::OpenCode, "synthetic-session")
            .is_err());
        host.runtime.shutdown().unwrap();
        host.persist().unwrap();
        let stored = std::fs::read_to_string(directory.path().join("sessions.json")).unwrap();
        for secret in [&cap.0, &cap2.0, &first, &second] {
            assert!(!stored.contains(secret));
        }
        let restored = Host::open(directory.path().into()).unwrap();
        assert!(lock(&restored.activity).is_empty());
    }
    #[test]
    fn saturated_duplicate_open_preserves_generation_and_control_requests() {
        let directory = tempfile::tempdir().unwrap();
        let host = Host::open(directory.path().into()).unwrap();
        let agent = launch(&host, "opencode", "agent");
        let mut permits = Vec::new();
        let mut current = None;
        for _ in 0..super::super::super::MAX_ACTIVITY_PUBLISHERS {
            let (response, permit) = host
                .open_activity_publisher(
                    &host.generation,
                    &agent.id,
                    AgentKind::OpenCode,
                    "synthetic-session",
                )
                .unwrap();
            let Response::ActivityOpened {
                activity_generation,
                capability,
            } = response
            else {
                panic!("missing publisher")
            };
            current = Some((activity_generation, capability));
            permits.push(permit);
        }
        let (generation, cap) = current.unwrap();
        publish(&host, &agent.id, &generation, &cap, 1).unwrap();
        assert!(host
            .open_activity_publisher(
                &host.generation,
                &agent.id,
                AgentKind::OpenCode,
                "synthetic-session"
            )
            .is_err());
        publish(&host, &agent.id, &generation, &cap, 2).unwrap();
        assert!(matches!(
            host.handle(Request::List {
                generation: host.generation.clone()
            })
            .unwrap(),
            Response::Records { .. }
        ));
        permits.pop();
        let (response, _permit) = host
            .open_activity_publisher(
                &host.generation,
                &agent.id,
                AgentKind::OpenCode,
                "synthetic-session",
            )
            .unwrap();
        let Response::ActivityOpened {
            activity_generation,
            ..
        } = response
        else {
            panic!("missing publisher")
        };
        assert_ne!(activity_generation, generation);
        assert!(publish(&host, &agent.id, &generation, &cap, 3).is_err());
        host.runtime.shutdown().unwrap();
    }
    struct Cleanup {
        client: BrokerClient,
        broker: Option<thread::JoinHandle<Result<(), String>>>,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Some(broker) = self.broker.take() {
                let stopped = self.client.shutdown_broker().is_ok();
                if stopped || broker.is_finished() {
                    let _ = broker.join();
                }
            }
        }
    }
    fn next_activity(
        client: &BrokerClient,
        lease: &str,
        receiver: &mpsc::Receiver<UiEvent>,
        expected: Option<Observation>,
    ) -> UiEvent {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let event = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            match &event {
                UiEvent::AgentActivity { observation, .. } if *observation == expected => {
                    return event
                }
                UiEvent::Snapshot {
                    runtime_id,
                    sequence,
                    ..
                }
                | UiEvent::Output {
                    runtime_id,
                    sequence,
                    ..
                } => client.ack(runtime_id, *sequence, lease).unwrap(),
                UiEvent::Error { message, .. } | UiEvent::Disconnected { message, .. } => {
                    panic!("{message}")
                }
                _ => (),
            }
        }
    }
    #[test]
    fn actual_socket_ordered_publisher_reaches_broker_client_subscriber_and_drop_revokes() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().to_owned();
        let broker = thread::spawn(move || crate::broker::run(path));
        let deadline = Instant::now() + Duration::from_secs(10);
        let client = loop {
            match BrokerClient::existing_for_test(parent.path()) {
                Ok(client) => break client,
                Err(error) => {
                    if broker.is_finished() {
                        panic!(
                            "synthetic broker failed: {:?}; {error}",
                            broker.join().unwrap()
                        );
                    }
                    assert!(Instant::now() < deadline, "broker did not start: {error}");
                    thread::sleep(Duration::from_millis(20));
                }
            }
        };
        let mut cleanup = Cleanup {
            client: client.clone(),
            broker: Some(broker),
        };
        let lease = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let request = LaunchRequest {
            pane_id: "synthetic-activity-pane".into(),
            kind: "opencode".into(),
            project_id: None,
            session_id: None,
            resume_id: None,
            cwd: Some(parent.path().to_string_lossy().into()),
            profile_id: None,
            cols: 80,
            rows: 24,
        };
        let info = client
            .launch(
                spec(parent.path(), &request.pane_id),
                &request,
                lease.clone(),
                Arc::new(move |event| tx.send(event).map_err(|error| error.to_string())),
            )
            .unwrap();
        let mut publisher = client
            .open_ordered_activity_publisher(&info.id, AgentKind::OpenCode, "synthetic-session")
            .unwrap();
        publisher
            .publish("session.status", &payload("busy"))
            .unwrap();
        let busy = next_activity(&client, &lease, &rx, Some(Observation::Busy));
        assert!(observation(&busy).1 > 0 && observation(&busy).1 <= 30000);
        assert!(client.ack(&info.id, u64::MAX, &lease).is_err());
        client.detach(&info.id, &lease);
        thread::sleep(Duration::from_millis(60));
        let reconnect = BrokerClient::existing_for_test(parent.path()).unwrap();
        let new_lease = Uuid::new_v4().to_string();
        let (tx2, rx2) = mpsc::channel();
        reconnect
            .attach(
                &info.id,
                new_lease.clone(),
                Arc::new(move |event| tx2.send(event).map_err(|error| error.to_string())),
            )
            .unwrap();
        let snapshot = next_activity(&reconnect, &new_lease, &rx2, Some(Observation::Busy));
        assert_eq!(cursor(&snapshot), cursor(&busy));
        assert!(observation(&snapshot).1 < observation(&busy).1);
        drop(publisher);
        let invalidated = next_activity(&reconnect, &new_lease, &rx2, None);
        assert_eq!(cursor(&invalidated).generation, cursor(&busy).generation);
        assert!(cursor(&invalidated).revision > cursor(&busy).revision);
        assert_eq!(observation(&invalidated), (None, 0));
        // Explicit close also invalidates without relying on UI lifetime.
        let mut publisher = reconnect
            .open_ordered_activity_publisher(&info.id, AgentKind::OpenCode, "synthetic-session")
            .unwrap();
        publisher
            .publish("session.status", &payload("idle"))
            .unwrap();
        next_activity(&reconnect, &new_lease, &rx2, Some(Observation::Idle));
        publisher.close().unwrap();
        assert_eq!(
            observation(&next_activity(&reconnect, &new_lease, &rx2, None)),
            (None, 0)
        );
        reconnect.shutdown_broker().unwrap();
        cleanup.broker.take().unwrap().join().unwrap().unwrap();
    }
}

#[cfg(windows)]
#[test]
fn terminal_reply_drain_is_bounded_for_unreading_and_extra_byte_peers() {
    use interprocess::local_socket::tokio::prelude::*;
    use tokio::io::AsyncWriteExt;
    for extra_byte in [false, true] {
        let parent = tempfile::tempdir().unwrap();
        let directory = transport::private_directory(parent.path()).unwrap();
        let _ownership = transport::lock(&directory).unwrap();
        let ipc = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        ipc.block_on(async {
            let listener = transport::listener(&directory).unwrap();
            let permits = Arc::new(tokio::sync::Semaphore::new(1));
            let server_permits = Arc::clone(&permits);
            let server = tokio::spawn(async move {
                let _permit = server_permits.acquire_owned().await.unwrap();
                let stream = listener.accept().await.unwrap();
                transport::authenticate(&stream).unwrap();
                let mut stream = transport::ActivityStream::new(stream);
                final_reply(&mut stream, &Response::Ok).await.unwrap();
            });
            let mut client = transport::connect(&directory).await.unwrap();
            if extra_byte {
                client.write_u8(1).await.unwrap();
            }
            // The peer intentionally never consumes the buffered terminal reply.
            tokio::time::timeout(transport::REQUEST_TIMEOUT + Duration::from_secs(3), server)
                .await
                .expect("unreading activity peer retained its slot")
                .unwrap();
            assert_eq!(permits.available_permits(), 1);
            drop(client);
        });
        ipc.shutdown_background();
    }
}

#[test]
fn authoritative_snapshots_expire_without_source_and_refresh_only_on_new_evidence() {
    let (mut state, _) = state();
    let now = Instant::now();
    state.publish_source(Observation::Busy, now);
    let first = state.poll(None, now).unwrap();
    assert_eq!(observation(&first), (Some(Observation::Busy), 30000));
    let next = state.poll(None, now + Duration::from_secs(29)).unwrap();
    assert_eq!(observation(&next), (Some(Observation::Busy), 1000));
    let expired = state.poll(None, now + Duration::from_secs(30)).unwrap();
    assert_eq!(observation(&expired), (None, 0));
    state.publish_source(
        Observation::AwaitingPermission,
        now + Duration::from_secs(31),
    );
    let waiting = state.poll(None, now + Duration::from_secs(31)).unwrap();
    assert_eq!(
        observation(&waiting),
        (Some(Observation::AwaitingPermission), 30000)
    );
    state.publish_source(Observation::Unknown, now + Duration::from_secs(32));
    assert_eq!(
        observation(&state.poll(None, now + Duration::from_secs(32)).unwrap()),
        (None, 0)
    );
}

#[test]
fn authoritative_snapshot_close_never_reappears() {
    let (mut state, _) = state();
    let now = Instant::now();
    state.publish_source(Observation::Idle, now);
    state.close();
    assert_eq!(observation(&state.poll(None, now).unwrap()), (None, 0));
}
