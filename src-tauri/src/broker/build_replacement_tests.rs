//! Synthetic hosts only; no installed broker or real agent history.
use super::*;
#[cfg(unix)]
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};

#[test]
fn identities_are_additive_and_missing_or_unsafe_legacy_hosts_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::open(dir.path().into()).unwrap();
    let hello = || host.handle(Request::Hello { protocol: PROTOCOL }).unwrap();
    let client = BrokerClient::from_hello(dir.path(), hello()).unwrap();
    assert!(!client.build_mismatch().unwrap());
    for field in ["buildIdentity", "capabilities"] {
        let mut value = serde_json::to_value(hello()).unwrap();
        value.as_object_mut().unwrap().remove(field);
        let client =
            BrokerClient::from_hello(dir.path(), serde_json::from_value(value).unwrap()).unwrap();
        assert!(client.build_mismatch().unwrap());
    }
    let old: Response = serde_json::from_value(serde_json::json!({
        "result": "hello", "protocol": 1, "generation": "synthetic-legacy"
    }))
    .unwrap();
    let client = BrokerClient::from_hello(dir.path(), old).unwrap();
    assert!(client.build_mismatch().unwrap());
    assert!(!client.retire_if_idle().unwrap());
}

#[cfg(unix)]
fn synthetic_host(parent: &Path, identity: &str) -> (Arc<Host>, thread::JoinHandle<()>) {
    let directory = transport::private_directory(parent).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let owner = loop {
        match transport::lock(&directory) {
            Ok(owner) => break owner,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) => panic!("{error}"),
        }
    };
    let mut host = Host::open(directory.clone()).unwrap();
    Arc::get_mut(&mut host).unwrap().build_identity = identity.into();
    let running = host.clone();
    let (ready, listening) = mpsc::channel();
    let worker = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let listener = transport::listener(&directory).unwrap();
            ready.send(()).unwrap();
            while !running.shutdown.load(Ordering::Acquire) {
                if let Ok(Ok(stream)) =
                    tokio::time::timeout(Duration::from_millis(25), listener.accept()).await
                {
                    let Ok(admission) = running.admit() else {
                        continue;
                    };
                    let host = running.clone();
                    tokio::spawn(async move {
                        let _admission = admission;
                        if serve(stream, host.clone()).await.is_err() {
                            host.pin_unknown_client();
                        }
                    });
                }
            }
            running.shutdown_reply_complete.notified().await;
            drop(listener);
            drop(owner);
        });
    });
    listening.recv_timeout(Duration::from_secs(5)).unwrap();
    (host, worker)
}

#[cfg(unix)]
fn replacement(
    parent: &Path,
    starts: &AtomicUsize,
    worker: &mut Option<thread::JoinHandle<()>>,
) -> BrokerClient {
    BrokerClient::connect_with_start(parent, || {
        starts.fetch_add(1, Ordering::SeqCst);
        assert!(transport::ownership_available(&parent.join("runtime-broker-v1")).unwrap());
        *worker = Some(synthetic_host(parent, build_identity::current().unwrap()).1);
        Ok(Arc::new(Mutex::new(None)))
    })
    .unwrap()
}

#[cfg(unix)]
#[test]
fn matching_identity_keeps_the_host_and_idle_mismatch_retires_then_replaces() {
    for matched in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let (host, old) = synthetic_host(
            root.path(),
            if matched {
                build_identity::current().unwrap()
            } else {
                "synthetic-old-build"
            },
        );
        let starts = AtomicUsize::new(0);
        let mut new = None;
        let client = replacement(root.path(), &starts, &mut new);
        assert_eq!(client.generation() == host.generation, matched);
        assert_eq!(starts.load(Ordering::SeqCst), usize::from(!matched));
        assert!(!client.build_mismatch().unwrap());
        client.shutdown_broker().unwrap();
        old.join().unwrap();
        if let Some(new) = new {
            new.join().unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn mismatch_keeps_running_runtime_reports_count_and_replaces_after_last_exit() {
    let root = tempfile::tempdir().unwrap();
    let (host, old) = synthetic_host(root.path(), "synthetic-old-build");
    let client = BrokerClient::existing_for_test(root.path()).unwrap();
    let request = crate::service::LaunchRequest {
        kanban_card_id: None,
        pane_id: "synthetic-pane".into(),
        kind: "shell".into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: Some(root.path().to_string_lossy().into_owned()),
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    let info = client
        .launch_unattached(
            crate::runtime::LaunchSpec {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), "read value".into()],
                cwd: root.path().into(),
                env: HashMap::new(),
                session_id: None,
                resume_key: None,
                pane_id: request.pane_id.clone(),
            },
            &request,
        )
        .unwrap();
    let starts = AtomicUsize::new(0);
    let mut new = None;
    let kept = replacement(root.path(), &starts, &mut new);
    assert_eq!(kept.generation(), host.generation);
    assert!(kept.build_mismatch().unwrap());
    assert_eq!(kept.running_count().unwrap(), 1);
    assert!(!kept.retire_if_idle().unwrap());
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    kept.stop(&info.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let updated = loop {
        let next = replacement(root.path(), &starts, &mut new);
        if next.generation() != host.generation {
            break next;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(updated.running_count().unwrap(), 0);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert!(updated
        .list()
        .unwrap()
        .iter()
        .any(|record| record.info.id == info.id));
    updated.shutdown_broker().unwrap();
    old.join().unwrap();
    new.unwrap().join().unwrap();
}

#[cfg(unix)]
#[test]
fn connect_starts_again_after_dead_broker_with_stale_or_missing_socket() {
    for remove_socket in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (_host, old) = synthetic_host(root.path(), build_identity::current().unwrap());
        let dead = BrokerClient::existing_for_test(root.path()).unwrap();
        dead.shutdown_broker().unwrap();
        old.join().unwrap();
        if remove_socket {
            // Unix transport uses a private socket in this synthetic directory.
            for entry in fs::read_dir(root.path().join("runtime-broker-v1")).unwrap() {
                use std::os::unix::fs::FileTypeExt;
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_socket() {
                    fs::remove_file(entry.path()).unwrap();
                }
            }
        }
        assert!(dead.list().is_err());
        let starts = AtomicUsize::new(0);
        let mut new = None;
        let client = replacement(root.path(), &starts, &mut new);
        assert_ne!(client.generation(), dead.generation());
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        client.shutdown_broker().unwrap();
        new.unwrap().join().unwrap();
    }
}

#[test]
fn update_retirement_defers_for_another_admitted_request_and_seals_launches() {
    let dir = tempfile::tempdir().unwrap();
    let host = Host::open(dir.path().into()).unwrap();
    let request = host.admit().unwrap();
    assert!(!host.try_update_exit(0));
    drop(request);
    assert!(host.try_update_exit(0));
    assert!(host.admit().is_err());
}

#[cfg(unix)]
#[test]
fn legacy_host_without_safe_retirement_is_kept_even_with_zero_running_agents() {
    for count in [0, 2] {
        let root = tempfile::tempdir().unwrap();
        let directory = transport::private_directory(root.path()).unwrap();
        let (ready, listening) = mpsc::channel();
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let _owner = transport::lock(&directory).unwrap();
                let listener = transport::listener(&directory).unwrap();
                ready.send(()).unwrap();
                loop {
                    let mut stream = listener.accept().await.unwrap();
                    transport::authenticate(&stream).unwrap();
                    let bytes = transport::read_frame(&mut stream, 1024 * 1024).await.unwrap();
                    let request: Request = serde_json::from_slice(&bytes).unwrap();
                    let shutdown = matches!(request, Request::Shutdown { .. });
                    let response = match request {
                        Request::Hello { .. } => serde_json::json!({ "result": "hello", "protocol": 1, "generation": "synthetic-legacy" }),
                        Request::List { .. } => serde_json::json!({ "result": "records", "records": (0..count).map(|id| serde_json::json!({
                            "id": format!("synthetic-{id}"), "paneId": format!("pane-{id}"), "sessionId": null,
                            "state": "running", "cwd": "/synthetic", "exitCode": null, "kind": "shell",
                            "projectId": null, "profileId": null, "resumeId": null
                        })).collect::<Vec<_>>() }),
                        Request::Shutdown { .. } => serde_json::json!({ "result": "ok" }),
                        _ => panic!("legacy broker must not receive automatic retirement or Stop"),
                    };
                    transport::write_frame(&mut stream, &serde_json::to_vec(&response).unwrap()).await.unwrap();
                    if shutdown { transport::flush_shutdown_reply(&mut stream).await.unwrap(); break; }
                }
            });
        });
        listening.recv_timeout(Duration::from_secs(5)).unwrap();
        let client = BrokerClient::connect_with_start(root.path(), || {
            panic!("legacy owner must be preserved")
        })
        .unwrap();
        assert!(client.build_mismatch().unwrap());
        assert_eq!(client.running_count().unwrap(), count);
        assert!(!client.retire_if_idle().unwrap());
        // Stand-in for the explicit confirmation path; never an automatic action.
        client.shutdown_broker().unwrap();
        worker.join().unwrap();
    }
}
