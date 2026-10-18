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
