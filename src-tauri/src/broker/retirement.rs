//! Virgin-only retirement. Any broker work attempt permanently removes eligibility.
use super::*;

pub(super) struct Policy {
    pub(super) grace: Duration,
    pub(super) now: Arc<dyn Fn() -> Instant + Send + Sync>,
    pub(super) enabled: bool,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            grace: Duration::from_secs(30),
            now: Arc::new(Instant::now),
            enabled: cfg!(any(target_os = "linux", target_os = "macos")),
        }
    }
}
pub(super) struct Gate {
    pub(super) work_attempted: bool,
    pub(super) uncertain: bool,
    sealed: bool,
    in_flight: usize,
    deadline: Option<Instant>,
}
impl Gate {
    pub(super) fn new(work_attempted: bool) -> Self {
        Self {
            work_attempted,
            uncertain: false,
            sealed: false,
            in_flight: 0,
            deadline: None,
        }
    }
}
pub(super) struct Admission(Arc<Host>);
impl Drop for Admission {
    fn drop(&mut self) {
        // A poisoned gate never authorizes retirement, even while unwinding.
        if let Ok(mut gate) = self.0.retirement.lock() {
            match gate.in_flight.checked_sub(1) {
                Some(count) => gate.in_flight = count,
                None => gate.uncertain = true,
            }
            gate.uncertain |= std::thread::panicking();
        }
    }
}
impl Host {
    pub(super) fn now(&self) -> Instant {
        (self.retirement_policy.now)()
    }
    pub(super) fn admit(self: &Arc<Self>) -> Result<Admission, String> {
        let mut gate = self
            .retirement
            .lock()
            .map_err(|_| "Broker admission integrity unavailable")?;
        if gate.sealed || self.shutdown.load(std::sync::atomic::Ordering::Acquire) {
            return Err("The runtime broker is shutting down".into());
        }
        gate.in_flight = gate
            .in_flight
            .checked_add(1)
            .ok_or("Broker admission overflow")?;
        gate.deadline = None;
        Ok(Admission(self.clone()))
    }
    pub(super) fn mark_fault(&self) {
        if let Ok(mut gate) = self.retirement.lock() {
            gate.uncertain = true;
            gate.deadline = None;
        }
    }
    pub(super) fn mark_work_attempt(&self) -> Result<(), String> {
        {
            let mut gate = self
                .retirement
                .lock()
                .map_err(|_| "Broker admission integrity unavailable")?;
            if gate.sealed {
                return Err("The runtime broker is shutting down".into());
            }
            gate.work_attempted = true;
            gate.deadline = None;
        }
        // Never hold lifecycle while acquiring writer or performing fsync/probes.
        if let Err(error) = self.persist() {
            self.mark_fault();
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn pin_unknown_client(&self) {
        if let Ok(mut leases) = self.ui_leases.lock() {
            leases.pin_unknown();
        }
        // Drop the UI guard before touching lifecycle; no inverse lock order.
        self.mark_fault();
    }
    pub(super) fn try_idle_exit(&self) -> bool {
        // Same writer -> lifecycle order as persist. Busy maintenance does not
        // restart the grace period; it only defers this seal attempt.
        let Ok(_writer) = self.persisted.try_lock() else {
            return false;
        };
        let Ok(mut gate) = self.retirement.lock() else {
            return false;
        };
        if !self.retirement_policy.enabled
            || self.shutdown.load(std::sync::atomic::Ordering::Acquire)
            || gate.sealed
            || gate.work_attempted
            || gate.uncertain
        {
            return false;
        }
        if gate.in_flight != 0 {
            return false;
        }
        let now = self.now();
        let Ok(mut leases) = self.ui_leases.lock() else {
            gate.uncertain = true;
            return false;
        };
        if !leases.idle_clear(now) {
            gate.deadline = None;
            return false;
        }
        // Historical/poisoned entries cannot be dismissed by an empty runtime List.
        match self.entries.lock() {
            Ok(entries) if entries.is_empty() => {}
            _ => {
                gate.uncertain = true;
                return false;
            }
        }
        let Some(next_deadline) = now.checked_add(self.retirement_policy.grace) else {
            gate.uncertain = true;
            return false;
        };
        let deadline = *gate.deadline.get_or_insert(next_deadline);
        if now < deadline {
            return false;
        }
        // Last fallible proof, under the same gate as every external admission.
        if self.runtime.try_close_if_quiescent().is_err() {
            gate.uncertain = true;
            return false;
        }
        gate.sealed = true;
        self.shutdown
            .store(true, std::sync::atomic::Ordering::Release);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn pristine() -> (tempfile::TempDir, Arc<Host>, Arc<Mutex<Instant>>) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("sessions.json"),
            storage::encode(storage::Kind::Modern, false, vec![]).unwrap(),
        )
        .unwrap();
        let now = Arc::new(Mutex::new(Instant::now()));
        let clock = now.clone();
        let host = Host::open_with_policy(
            dir.path().into(),
            Policy {
                grace: Duration::from_secs(30),
                now: Arc::new(move || *clock.lock().unwrap()),
                enabled: true,
            },
        )
        .unwrap();
        (dir, host, now)
    }
    fn advance(clock: &Mutex<Instant>, secs: u64) {
        *clock.lock().unwrap() += Duration::from_secs(secs);
    }
    fn owner(host: &Arc<Host>) -> String {
        let Response::Hello {
            ui_lease_offer: Some(offer),
            ..
        } = host.handle(Request::Hello { protocol: PROTOCOL }).unwrap()
        else {
            panic!()
        };
        let Response::UiLease { lease, .. } = host
            .handle(Request::AcquireUiLease {
                generation: host.generation.clone(),
                offer,
            })
            .unwrap()
        else {
            panic!()
        };
        lease
    }
    fn release(host: &Arc<Host>, lease: String) {
        host.handle(Request::ReleaseUiLease {
            generation: host.generation.clone(),
            lease,
        })
        .unwrap();
    }
    #[test]
    fn virgin_grace_seals_without_shutdown_request_and_rejects_late_admission() {
        let (_dir, host, now) = pristine();
        assert!(!host.try_idle_exit());
        advance(&now, 29);
        assert!(!host.try_idle_exit());
        advance(&now, 1);
        assert!(host.try_idle_exit());
        assert!(host.shutdown.load(Ordering::Acquire));
        assert!(host.admit().is_err());
        assert!(host.handle(Request::Hello { protocol: PROTOCOL }).is_err());
    }
    #[test]
    fn request_in_flight_restarts_grace_and_maintenance_does_not() {
        let (_dir, host, now) = pristine();
        assert!(!host.try_idle_exit());
        advance(&now, 29);
        let guard = host.admit().unwrap();
        advance(&now, 2);
        assert!(!host.try_idle_exit());
        drop(guard);
        assert!(!host.try_idle_exit());
        advance(&now, 29);
        host.persist().unwrap();
        assert!(!host.try_idle_exit());
        advance(&now, 1);
        assert!(host.try_idle_exit());
    }
    #[test]
    fn leases_pending_legacy_and_expired_evidence_never_allow_retirement() {
        for mode in ["live", "pending", "expired", "unleased"] {
            let (_dir, host, now) = pristine();
            match mode {
                "live" => {
                    owner(&host);
                }
                "pending" => {
                    host.handle(Request::Hello { protocol: PROTOCOL }).unwrap();
                }
                "expired" => {
                    let lease = owner(&host);
                    advance(&now, 61);
                    release(&host, lease);
                }
                _ => {
                    host.handle(Request::List {
                        generation: host.generation.clone(),
                    })
                    .unwrap();
                }
            }
            assert!(!host.try_idle_exit(), "{mode}");
            advance(&now, 120);
            assert!(!host.try_idle_exit(), "{mode}");
        }
    }
    #[test]
    fn explicit_release_starts_grace_but_new_owner_cancels_it() {
        let (_dir, host, now) = pristine();
        let lease = owner(&host);
        release(&host, lease);
        assert!(!host.try_idle_exit());
        advance(&now, 29);
        let next = owner(&host);
        assert!(!host.try_idle_exit());
        release(&host, next);
        assert!(!host.try_idle_exit());
        advance(&now, 30);
        assert!(host.try_idle_exit());
    }
    #[test]
    fn attempt_bit_is_durable_and_never_cleared_by_empty_records_or_restart() {
        let (dir, host, now) = pristine();
        let admission = host.admit().unwrap();
        host.mark_work_attempt().unwrap();
        drop(admission);
        advance(&now, 120);
        assert!(!host.try_idle_exit());
        let (_, attempted, records) =
            storage::decode(&fs::read(dir.path().join("sessions.json")).unwrap()).unwrap();
        assert!(attempted);
        assert!(records.is_empty());
        let reopened = Host::open(dir.path().into()).unwrap();
        assert!(reopened.retirement.lock().unwrap().work_attempted);
        assert!(!reopened.try_idle_exit());
    }
    #[test]
    fn rejected_launch_is_durably_attempted_before_validation() {
        let (dir, host, now) = pristine();
        let lease = owner(&host);
        let spec = LaunchSpec {
            executable: "/synthetic/never-run".into(),
            args: vec![],
            cwd: dir.path().into(),
            env: HashMap::new(),
            session_id: None,
            resume_key: None,
            pane_id: "rejected".into(),
        };
        let result = host.handle(Request::Launch {
            generation: host.generation.clone(),
            spec: Box::new(spec),
            kind: "not-an-agent".into(),
            project_id: None,
            profile_id: None,
            resume_id: None,
            home_directory: false,
            cols: 80,
            rows: 24,
        });
        assert!(result.unwrap_err().contains("Unknown runtime kind"));
        assert!(host.runtime.list().is_empty());
        release(&host, lease);
        advance(&now, 120);
        assert!(!host.try_idle_exit());
        assert!(
            storage::decode(&fs::read(dir.path().join("sessions.json")).unwrap())
                .unwrap()
                .1
        );
    }
    #[cfg(unix)]
    #[test]
    fn released_ui_cannot_retire_a_started_shell_even_after_exit_and_forget() {
        let (dir, host, now) = pristine();
        let lease = owner(&host);
        let spec = LaunchSpec {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), "read value; test \"$value\" = continue".into()],
            cwd: dir.path().into(),
            env: HashMap::new(),
            session_id: None,
            resume_key: None,
            pane_id: "synthetic-idle-shell".into(),
        };
        let Response::Runtime { info: Some(info) } = host
            .handle(Request::Launch {
                generation: host.generation.clone(),
                spec: Box::new(spec),
                kind: "shell".into(),
                project_id: None,
                profile_id: None,
                resume_id: None,
                home_directory: false,
                cols: 80,
                rows: 24,
            })
            .unwrap()
        else {
            panic!()
        };
        release(&host, lease);
        advance(&now, 120);
        assert!(!host.try_idle_exit());
        assert_eq!(host.runtime.list()[0].id, info.id);
        host.handle(Request::Write {
            generation: host.generation.clone(),
            runtime_id: info.id.clone(),
            data: "continue\n".into(),
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while host.runtime.list()[0].state != "exited" {
            assert!(Instant::now() < deadline, "synthetic shell did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(host.runtime.list()[0].exit_code, Some(0));
        host.handle(Request::Forget {
            generation: host.generation.clone(),
            runtime_id: info.id,
        })
        .unwrap();
        assert!(host.records().is_empty());
        assert!(!host.try_idle_exit());
        assert!(
            storage::decode(&fs::read(dir.path().join("sessions.json")).unwrap())
                .unwrap()
                .1
        );
    }
    #[cfg(unix)]
    #[test]
    fn unread_ipc_blocks_seal_and_invalid_frame_pins_unknown_client() {
        let (dir, host, now) = pristine();
        let _ownership = transport::lock(dir.path()).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = transport::listener(dir.path()).unwrap();
                assert!(!host.try_idle_exit());
                let mut client = transport::connect(dir.path()).await.unwrap();
                let stream = listener.accept().await.unwrap();
                let task = tokio::spawn(serve(stream, host.clone()));
                tokio::task::yield_now().await;
                assert_eq!(host.retirement.lock().unwrap().in_flight, 1);
                advance(&now, 31);
                assert!(!host.try_idle_exit());
                transport::write_frame(&mut client, b"{}").await.unwrap();
                transport::read_frame(&mut client, 4096).await.unwrap();
                task.await.unwrap().unwrap();
                assert_eq!(host.retirement.lock().unwrap().in_flight, 0);
                advance(&now, 120);
                assert!(!host.try_idle_exit());
            });
    }
    #[test]
    fn delayed_writer_cannot_restore_pristine_bit() {
        let (dir, host, _now) = pristine();
        let writer = host.persisted.lock().unwrap();
        let other = host.clone();
        let thread = std::thread::spawn(move || other.mark_work_attempt());
        while !host.retirement.lock().unwrap().work_attempted {
            std::thread::yield_now();
        }
        drop(writer);
        host.persist().unwrap();
        thread.join().unwrap().unwrap();
        assert!(
            storage::decode(&fs::read(dir.path().join("sessions.json")).unwrap())
                .unwrap()
                .1
        );
    }
    #[test]
    fn seal_races_are_serialized_with_launch_admission() {
        for admit_first in [false, true] {
            let (_dir, host, now) = pristine();
            assert!(!host.try_idle_exit());
            advance(&now, 30);
            if admit_first {
                let admission = host.admit().unwrap();
                let other = host.clone();
                assert!(!std::thread::spawn(move || other.try_idle_exit())
                    .join()
                    .unwrap());
                host.mark_work_attempt().unwrap();
                drop(admission);
                assert!(!host.try_idle_exit());
            } else {
                assert!(host.try_idle_exit());
                let other = host.clone();
                assert!(!std::thread::spawn(move || other.admit().is_ok())
                    .join()
                    .unwrap());
            }
        }
    }
    #[test]
    fn faults_clock_rollback_and_poison_fail_closed() {
        for mode in ["fault", "clock", "gate", "lease", "writer", "entries"] {
            let (_dir, host, now) = pristine();
            assert!(!host.try_idle_exit());
            match mode {
                "fault" => host.mark_fault(),
                "clock" => {
                    *now.lock().unwrap() -= Duration::from_secs(1);
                }
                _ => {
                    let other = host.clone();
                    let _ = std::thread::spawn(move || match mode {
                        "gate" => {
                            let _g = other.retirement.lock().unwrap();
                            panic!("synthetic poison");
                        }
                        "lease" => {
                            let _g = other.ui_leases.lock().unwrap();
                            panic!("synthetic poison");
                        }
                        "writer" => {
                            let _g = other.persisted.lock().unwrap();
                            panic!("synthetic poison");
                        }
                        _ => {
                            let _g = other.entries.lock().unwrap();
                            panic!("synthetic poison");
                        }
                    })
                    .join();
                }
            }
            assert!(!host.try_idle_exit(), "{mode}");
            advance(&now, 120);
            assert!(!host.try_idle_exit(), "{mode}");
        }
    }
    #[test]
    fn failed_attempt_persistence_prevents_work_and_retirement() {
        let (dir, host, now) = pristine();
        fs::remove_file(dir.path().join("sessions.json")).unwrap();
        fs::create_dir(dir.path().join("sessions.json")).unwrap();
        assert!(host.mark_work_attempt().is_err());
        assert!(host.runtime.list().is_empty());
        advance(&now, 120);
        assert!(!host.try_idle_exit());
        assert!(host.retirement.lock().unwrap().uncertain);
    }
    #[test]
    fn legacy_missing_metadata_and_disabled_policy_remain_pinned() {
        for contents in [None, Some("[]")] {
            let dir = tempfile::tempdir().unwrap();
            if let Some(bytes) = contents {
                fs::write(dir.path().join("sessions.json"), bytes).unwrap();
            }
            let host = Host::open(dir.path().into()).unwrap();
            assert!(host.retirement.lock().unwrap().work_attempted);
            assert!(!host.try_idle_exit());
            assert!(serde_json::from_slice::<Vec<RuntimeRecord>>(
                &fs::read(dir.path().join("sessions.json")).unwrap()
            )
            .is_ok());
        }
        let (dir, _host, now) = pristine();
        let clock = now.clone();
        let host = Host::open_with_policy(
            dir.path().into(),
            Policy {
                enabled: false,
                grace: Duration::ZERO,
                now: Arc::new(move || *clock.lock().unwrap()),
            },
        )
        .unwrap();
        assert!(!host.try_idle_exit());
    }
    #[cfg(unix)]
    #[test]
    fn connect_rechecks_ownership_after_sealed_broker_releases_lock() {
        use std::sync::{atomic::AtomicUsize, mpsc};

        let root = tempfile::tempdir().unwrap();
        let directory = transport::private_directory(root.path()).unwrap();
        // private_directory briefly locks while initializing. A PTY test forking
        // in parallel can inherit that descriptor until it execs, so the fresh
        // lock may report WouldBlock for a moment; wait for it rather than flake.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let ownership = loop {
            match transport::lock(&directory) {
                Ok(lock) => break lock,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("{error}"),
            }
        };
        let host = Host::open_with_policy(
            directory.clone(),
            Policy {
                grace: Duration::ZERO,
                enabled: true,
                ..Policy::default()
            },
        )
        .unwrap();
        assert!(host.try_idle_exit());
        let old_generation = host.generation.clone();
        let (ready, listening) = mpsc::channel();
        let (paused, at_retry) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let old_directory = directory.clone();
        let old = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let listener = transport::listener(&old_directory).unwrap();
                    ready.send(()).unwrap();
                    let stream = listener.accept().await.unwrap();
                    assert!(serve(stream, host.clone()).await.is_err());
                    // A second Hello proves connect has already failed once
                    // and observed the still-held ownership lock.
                    let stream = listener.accept().await.unwrap();
                    paused.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    drop(listener);
                    drop(ownership);
                    assert!(serve(stream, host).await.is_err());
                });
        });
        listening.recv_timeout(Duration::from_secs(5)).unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let started = starts.clone();
        let replacement = Arc::new(Mutex::new(None));
        let running = replacement.clone();
        let parent = root.path().to_path_buf();
        let checked_directory = directory.clone();
        let (connected, result) = mpsc::channel();
        let connecting = std::thread::spawn(move || {
            let client = BrokerClient::connect_with_start(&parent, || {
                assert!(transport::ownership_available(&checked_directory).unwrap());
                started.fetch_add(1, Ordering::SeqCst);
                let parent = parent.clone();
                *running.lock().unwrap() = Some(std::thread::spawn(move || run(parent)));
                Ok(Arc::new(Mutex::new(None)))
            });
            connected.send(client).unwrap();
        });
        at_retry.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert!(!transport::ownership_available(&directory).unwrap());
        release.send(()).unwrap();
        old.join().unwrap();
        let client = result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        connecting.join().unwrap();
        assert_ne!(client.generation(), old_generation);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(
            transport::lock(&directory).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        client.shutdown_broker().unwrap();
        replacement
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .join()
            .unwrap()
            .unwrap();
        assert!(transport::ownership_available(&directory).unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn production_loop_retires_virgin_store_and_releases_owner_lock() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let broker = std::thread::spawn(move || {
            run_with_policy(
                root,
                Policy {
                    grace: Duration::from_millis(10),
                    ..Policy::default()
                },
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !broker.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            broker.is_finished(),
            "idle path must not await a Shutdown reply"
        );
        broker.join().unwrap().unwrap();
        let directory = dir.path().join("runtime-broker-v1");
        assert!(transport::ownership_available(&directory).unwrap());
        assert!(
            !storage::decode(&fs::read(directory.join("sessions.json")).unwrap())
                .unwrap()
                .1
        );
    }
}
