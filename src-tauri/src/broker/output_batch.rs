use super::UiEvent;

// Match the broker's existing poll payload budget. This is batching of a single
// received response, never a timer, extra poll, replay retention, or ANSI parser.
const BATCH_BYTES: usize = 64 * 1024;

pub(super) fn batch_output(events: Vec<UiEvent>) -> Vec<UiEvent> {
    let mut result = Vec::with_capacity(events.len());
    for event in events {
        if let UiEvent::Output {
            runtime_id,
            sequence,
            data,
        } = event
        {
            if let Some(UiEvent::Output {
                runtime_id: previous_id,
                sequence: previous_sequence,
                data: previous_data,
            }) = result.last_mut()
            {
                if *previous_id == runtime_id
                    && previous_sequence.checked_add(1) == Some(sequence)
                    && previous_data.len().saturating_add(data.len()) <= BATCH_BYTES
                {
                    previous_data.extend(data);
                    *previous_sequence = sequence;
                    continue;
                }
            }
            result.push(UiEvent::Output {
                runtime_id,
                sequence,
                data,
            });
        } else {
            // Snapshot, exit, error and disconnect retain their exact positions.
            result.push(event);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output(sequence: u64, data: &[u8]) -> UiEvent {
        UiEvent::Output {
            runtime_id: "r".into(),
            sequence,
            data: data.into(),
        }
    }
    #[test]
    fn exact_bytes_and_final_sequence_replace_per_chunk_ack_round_trips() {
        let chunks = [
            b"\x1b[?2026h\x1b[2J".as_slice(),
            b"\x1b[Hsynthetic ",
            "中文".as_bytes(),
            b"\x1b[?2026l",
        ];
        let expected = chunks.concat();
        let result = batch_output(
            chunks
                .iter()
                .enumerate()
                .map(|(index, data)| output(index as u64 + 1, data))
                .collect(),
        );
        assert_eq!(result.len(), 1);
        match &result[0] {
            UiEvent::Output { sequence, data, .. } => {
                assert_eq!(*sequence, 4);
                assert_eq!(*data, expected);
            }
            _ => panic!("expected output"),
        }
    }
    #[test]
    fn preserves_boundaries_identity_and_noncontiguous_cursors() {
        let result = batch_output(vec![
            output(1, b"a"),
            UiEvent::Snapshot {
                runtime_id: "r".into(),
                sequence: 2,
                data: b"snapshot".to_vec(),
                cols: 80,
                rows: 24,
                truncated: false,
            },
            output(3, b"b"),
            UiEvent::Error {
                runtime_id: "r".into(),
                message: "synthetic".into(),
            },
            output(4, b"c"),
            UiEvent::Exit {
                runtime_id: "r".into(),
                exit_code: Some(0),
            },
            output(5, b"d"),
            UiEvent::Disconnected {
                runtime_id: "r".into(),
                message: "synthetic".into(),
            },
            output(6, b"e"),
            output(8, b"f"),
            UiEvent::Output {
                runtime_id: "other".into(),
                sequence: 9,
                data: b"g".to_vec(),
            },
        ]);
        assert_eq!(result.len(), 11);
        assert!(matches!(result[1], UiEvent::Snapshot { .. }));
        assert!(matches!(result[3], UiEvent::Error { .. }));
        assert!(matches!(result[5], UiEvent::Exit { .. }));
        assert!(matches!(result[7], UiEvent::Disconnected { .. }));
    }
    #[test]
    fn never_expands_existing_payload_budget() {
        let result = batch_output(vec![
            output(1, &vec![b'a'; BATCH_BYTES - 1]),
            output(2, b"b"),
            output(3, b"c"),
        ]);
        assert_eq!(result.len(), 2);
        assert!(
            matches!(&result[0],UiEvent::Output{sequence:2,data,..} if data.len()==BATCH_BYTES)
        );
        assert!(matches!(&result[1],UiEvent::Output{sequence:3,data,..} if data==b"c"));
    }
    #[test]
    fn preserves_an_existing_oversize_event_and_does_not_wrap_sequence() {
        let result = batch_output(vec![
            output(1, &vec![b'a'; BATCH_BYTES + 1]),
            output(2, b"b"),
        ]);
        assert_eq!(result.len(), 2);
        assert!(
            matches!(&result[0], UiEvent::Output {sequence: 1, data, ..} if data.len() == BATCH_BYTES + 1)
        );
        let result = batch_output(vec![output(u64::MAX, b"a"), output(0, b"b")]);
        assert_eq!(result.len(), 2);
    }
    #[test]
    fn repeated_poll_responses_never_replay_an_acknowledged_prefix() {
        let first = batch_output(vec![output(1, b"a"), output(2, b"b")]);
        let second = batch_output(vec![output(3, b"c"), output(4, b"d")]);
        assert!(matches!(&first[0],UiEvent::Output{sequence:2,data,..} if data==b"ab"));
        assert!(matches!(&second[0],UiEvent::Output{sequence:4,data,..} if data==b"cd"));
        assert!(batch_output(vec![]).is_empty());
    }
    #[test]
    fn small_chunks_remain_bounded_without_ack_round_trip_amplification() {
        use super::super::screen::TerminalScreen;
        use crate::runtime::TerminalEvent;
        fn run(batched: bool) -> (usize, usize) {
            let mut screen = TerminalScreen::new(80, 24);
            let mut cursor = Some(0);
            let mut sequence = 0;
            let mut produce = |screen: &mut TerminalScreen| {
                for _ in 0..4 {
                    sequence += 1;
                    screen.event(TerminalEvent::Output {
                        runtime_id: "r".into(),
                        sequence,
                        data: format!("\x1b[HSynthetic frame {sequence}").into_bytes(),
                    });
                }
            };
            let mut snapshots = 0;
            let mut acknowledged_writes = 0;
            // Deterministic latency model: four new PTY chunks arrive during
            // each write/ACK round trip. No wall-clock performance assertion.
            for _ in 0..30 {
                produce(&mut screen);
                let events = screen.poll("r", cursor).unwrap();
                let events = if batched {
                    batch_output(events)
                } else {
                    events
                };
                for event in events {
                    match event {
                        UiEvent::Snapshot { sequence, .. } => {
                            snapshots += 1;
                            cursor = Some(sequence);
                        }
                        UiEvent::Output { sequence, .. } => cursor = Some(sequence),
                        _ => continue,
                    }
                    acknowledged_writes += 1;
                    produce(&mut screen);
                }
            }
            (snapshots, acknowledged_writes)
        }
        let baseline = run(false);
        let batched = run(true);
        println!("synthetic ACK model: baseline={baseline:?}, batched={batched:?}");
        assert!(baseline.0 > 0);
        assert_eq!(batched.0, 0);
        assert_eq!(batched.1, 30);
        assert!(baseline.1 > batched.1);
    }
}
