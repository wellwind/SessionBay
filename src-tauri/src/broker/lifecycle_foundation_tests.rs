//! Only an isolated synthetic broker is launched; never discover the user's broker.
use super::*;

#[test]
fn proof_only_foundation_does_not_enable_idle_exit_without_ui_leases() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().to_path_buf();
    let broker = std::thread::spawn(move || run(directory));
    let deadline = Instant::now() + Duration::from_secs(5);
    let client = loop {
        if let Ok(client) = BrokerClient::existing_for_test(temp.path()) {
            break client;
        }
        assert!(
            !broker.is_finished(),
            "synthetic broker unexpectedly stopped"
        );
        assert!(Instant::now() < deadline, "synthetic broker did not start");
        std::thread::sleep(Duration::from_millis(5));
    };
    let generation = client.generation();
    let first = client.list().unwrap();
    // Several accept/maintenance ticks are not proof that an unleased UI is gone.
    std::thread::sleep(Duration::from_millis(900));
    let second = client.list();
    let stayed_alive = !broker.is_finished();
    // Explicit cleanup targets only the temp directory and its authenticated generation.
    client.shutdown_broker().unwrap();
    broker.join().unwrap().unwrap();
    assert!(first.is_empty());
    assert!(second.unwrap().is_empty());
    assert!(stayed_alive);
    assert_eq!(client.generation(), generation);
}

#[test]
fn native_owner_survives_client_clone_drop_and_releases_without_stopping_broker() {
    let temp = tempfile::tempdir().unwrap();
    let directory = transport::private_directory(temp.path()).unwrap();
    let host = Host::open(directory.clone()).unwrap();
    let owned_host = host.clone();
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let (ready, started) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = transport::listener(&directory).unwrap();
                ready.send(()).unwrap();
                loop {
                    if !matches!(
                        stopped.try_recv(),
                        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                    ) {
                        break;
                    }
                    if let Ok(accepted) =
                        tokio::time::timeout(Duration::from_millis(50), listener.accept()).await
                    {
                        serve(accepted.unwrap(), owned_host.clone()).await.unwrap();
                    }
                }
            });
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let client = BrokerClient::existing_for_test(temp.path()).unwrap();
    let owner = client.start_ui_owner().unwrap().unwrap();
    let cloned = client.clone();
    assert!(cloned.start_ui_owner().unwrap().is_none());
    drop(cloned);
    drop(client); // Rendering clients do not own the native guard.
    assert_eq!(
        host.ui_leases().unwrap().evidence(Instant::now()),
        (1, 0, false)
    );
    drop(owner);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if host.ui_leases().unwrap().evidence(Instant::now()).0 == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "native release did not arrive");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!host.shutdown.load(std::sync::atomic::Ordering::Acquire));
    assert!(host.runtime.list().is_empty());
    stop.send(()).unwrap();
    server.join().unwrap();
}

#[test]
fn lease_commands_require_generation_and_poison_never_supplies_lifecycle_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let host = Host::open(temp.path().into()).unwrap();
    let Response::Hello {
        ui_lease_offer: Some(offer),
        ..
    } = host.handle(Request::Hello { protocol: PROTOCOL }).unwrap()
    else {
        panic!()
    };
    assert!(host
        .handle(Request::AcquireUiLease {
            generation: "stale".into(),
            offer: offer.clone()
        })
        .is_err());
    assert_eq!(
        host.ui_leases().unwrap().evidence(Instant::now()),
        (0, 1, false)
    );
    let Response::UiLease { lease, .. } = host
        .handle(Request::AcquireUiLease {
            generation: host.generation.clone(),
            offer,
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(host
        .handle(Request::RenewUiLease {
            generation: "stale".into(),
            lease: lease.clone(),
            sequence: 1
        })
        .is_err());
    assert!(host
        .handle(Request::ReleaseUiLease {
            generation: "stale".into(),
            lease
        })
        .is_err());
    let poisoned = host.clone();
    assert!(std::thread::spawn(move || {
        let _guard = poisoned.ui_leases.lock().unwrap();
        panic!("synthetic poison");
    })
    .join()
    .is_err());
    assert!(host.handle(Request::Hello { protocol: PROTOCOL }).is_err());
    // Ordinary interactive commands remain available; poison cannot trigger stop.
    assert!(matches!(
        host.handle(Request::List {
            generation: host.generation.clone()
        })
        .unwrap(),
        Response::Records { .. }
    ));
    assert!(!host.shutdown.load(std::sync::atomic::Ordering::Acquire));
}
