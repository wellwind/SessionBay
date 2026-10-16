#[path = "common/terminal_events.rs"]
mod terminal_events;

use sessionbay_lib::runtime::TerminalEvent;
use std::sync::mpsc;
use terminal_events::TerminalEvents;

fn output(sequence: u64, data: &[u8]) -> TerminalEvent {
    TerminalEvent::Output {
        runtime_id: "synthetic-runtime".into(),
        sequence,
        data: data.into(),
    }
}

#[test]
fn readiness_then_completion_preserves_sequence_and_all_output() {
    let (tx, rx) = mpsc::channel();
    tx.send(output(1, b"ready-for-input\n")).unwrap();
    tx.send(output(2, "received:中文\n".as_bytes())).unwrap();
    tx.send(output(3, b"done")).unwrap();
    tx.send(TerminalEvent::Exit {
        runtime_id: "synthetic-runtime".into(),
        exit_code: Some(7),
    })
    .unwrap();
    let mut acknowledged = Vec::new();
    let result = {
        let mut events = TerminalEvents::new(&rx, |id, sequence| {
            assert_eq!(id, "synthetic-runtime");
            acknowledged.push(sequence);
        });
        assert_eq!(events.until_text("ready-for-input"), "ready-for-input\n");
        events.collect()
    };
    assert_eq!(acknowledged, vec![1, 2, 3]);
    assert_eq!(
        result,
        ("ready-for-input\nreceived:中文\ndone".into(), Some(7))
    );
}

#[test]
fn readiness_to_completion_boundary_rejects_duplicates_and_gaps() {
    for invalid in [1, 3] {
        let (tx, rx) = mpsc::channel();
        tx.send(output(1, b"ready")).unwrap();
        tx.send(output(invalid, b"must-not-acknowledge")).unwrap();
        let mut acknowledged = Vec::new();
        let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut events = TerminalEvents::new(&rx, |_, sequence| acknowledged.push(sequence));
            events.until_text("ready");
            events.collect();
        }));
        assert!(failure.is_err(), "invalid sequence {invalid} was accepted");
        assert_eq!(acknowledged, vec![1]);
    }
}

#[test]
fn completion_without_readiness_still_requires_first_sequence_one() {
    let (tx, rx) = mpsc::channel();
    tx.send(output(2, b"missing-first-frame")).unwrap();
    let mut acknowledged = Vec::new();
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        TerminalEvents::new(&rx, |_, sequence| acknowledged.push(sequence)).collect();
    }));
    assert!(failure.is_err());
    assert!(acknowledged.is_empty());
}
