//! Native Service owns this guard, never a renderer or arbitrary client clone.
use super::{client::exchange, ui_lease::RENEW_INTERVAL, Request, Response};
use std::{path::Path, sync::mpsc, thread, time::Duration};

pub(crate) struct NativeUiLease {
    // No worker owns a sender: dropping the native owner always wakes it.
    _close: mpsc::Sender<()>,
}
impl NativeUiLease {
    pub(super) fn start(directory: &Path, generation: &str, offer: &str) -> Result<Self, String> {
        let Response::UiLease {
            lease,
            sequence: 0,
            valid_for_ms: 1..,
        } = exchange(
            directory,
            &Request::AcquireUiLease {
                generation: generation.into(),
                offer: offer.into(),
            },
        )?
        else {
            return Err("Invalid UI lease acquire response".into());
        };
        let (close, closed) = mpsc::channel();
        let directory = directory.to_owned();
        let generation = generation.to_owned();
        thread::Builder::new()
            .name("sessionbay-ui-lease".into())
            .spawn(move || {
                run_owner(closed, RENEW_INTERVAL, generation, lease, |request| {
                    exchange(&directory, request)
                });
            })
            .map_err(|error| format!("Cannot start native UI lease owner: {error}"))?;
        // If thread creation fails, the acquired lease times out conservatively.
        Ok(Self { _close: close })
    }
}
fn run_owner(
    closed: mpsc::Receiver<()>,
    interval: Duration,
    generation: String,
    lease: String,
    mut send: impl FnMut(&Request) -> Result<Response, String>,
) {
    let mut sequence = 1u64;
    loop {
        match closed.recv_timeout(interval) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        // A failed/unknown reply retries this same sequence on this same owner.
        // It never reconnects, revives an expired lease, or resends a Launch.
        if matches!(send(&Request::RenewUiLease { generation: generation.clone(), lease: lease.clone(), sequence }),
            Ok(Response::UiLease { lease: id, sequence: acknowledged, valid_for_ms: 1.. }) if id == lease && acknowledged == sequence)
        {
            let Some(next) = sequence.checked_add(1) else {
                break;
            };
            sequence = next;
        }
    }
    // Serialized after any in-flight renew, with no join/blocking in Service close.
    let _ = send(&Request::ReleaseUiLease { generation, lease });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_renew_reply_retries_same_sequence_and_close_waits_for_inflight_renew() {
        let (close, closed) = mpsc::channel::<()>();
        let (entered, ready) = mpsc::channel();
        let (allow, proceed) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut seen = Vec::new();
            run_owner(
                closed,
                Duration::ZERO,
                "generation".into(),
                "lease".into(),
                |request| match request {
                    Request::RenewUiLease { sequence, .. } => {
                        seen.push(*sequence);
                        if seen.len() == 1 {
                            return Err("lost response".into());
                        }
                        entered.send(()).unwrap();
                        proceed.recv().unwrap();
                        Ok(Response::UiLease {
                            lease: "lease".into(),
                            sequence: *sequence,
                            valid_for_ms: 60_000,
                        })
                    }
                    Request::ReleaseUiLease { generation, lease } => {
                        assert_eq!(generation, "generation");
                        assert_eq!(lease, "lease");
                        seen.push(0);
                        Ok(Response::Ok)
                    }
                    _ => panic!("unexpected non-lease action"),
                },
            );
            seen
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(close); // Native close during an in-flight renewal.
        allow.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), vec![1, 1, 0]);
    }
    #[test]
    fn closing_owner_before_first_tick_releases_without_renewing() {
        let (close, closed) = mpsc::channel::<()>();
        drop(close);
        let mut calls = 0;
        run_owner(
            closed,
            Duration::from_secs(5),
            "g".into(),
            "l".into(),
            |request| {
                assert!(matches!(request, Request::ReleaseUiLease { .. }));
                calls += 1;
                Ok(Response::Ok)
            },
        );
        assert_eq!(calls, 1);
    }
}
