//! Proof for this manager's owned runtimes, never a broker/UI-liveness inference.
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeQuiescence {
    /// Every retained runtime completed with positive platform cleanup evidence.
    Proven,
    /// At least one supervisor is still starting, running, draining, or stopping.
    Active,
    /// Cleanup, rollback, ownership, or mutex integrity cannot be proved.
    Unverified,
}

impl Control {
    pub(super) fn cleanup_proven(&self) -> bool {
        self.done
            && self.cleanup_verified
            && self.cleanup_error.is_none()
            && matches!(self.info.state.as_str(), "exited" | "failed")
    }
}

impl Registry {
    pub(super) fn prune_completed(&mut self) {
        let mut uncertain = false;
        self.runtimes.retain(|_, runtime| {
            let poisoned = runtime.control.is_poisoned();
            let control = lock(&runtime.control);
            if poisoned || (control.done && !control.cleanup_proven()) {
                uncertain = true;
            }
            !control.done
        });
        self.cleanup_uncertain |= uncertain;
    }
}

fn assess(registry: &Registry) -> RuntimeQuiescence {
    if registry.cleanup_uncertain {
        return RuntimeQuiescence::Unverified;
    }
    let mut active = false;
    for runtime in registry.runtimes.values() {
        let Ok(control) = runtime.control.lock() else {
            return RuntimeQuiescence::Unverified;
        };
        if control.cleanup_error.is_some() {
            return RuntimeQuiescence::Unverified;
        }
        if !control.done {
            active = true;
        } else if !control.cleanup_proven() {
            return RuntimeQuiescence::Unverified;
        }
    }
    if active {
        RuntimeQuiescence::Active
    } else {
        RuntimeQuiescence::Proven
    }
}

fn seal(registry: &mut Registry) -> Result<(), RuntimeQuiescence> {
    match assess(registry) {
        RuntimeQuiescence::Proven => {
            registry.shutting_down = true;
            Ok(())
        }
        blocked => Err(blocked),
    }
}

impl RuntimeManager {
    /// Snapshot only. It says nothing about UI leases, broker request preparation,
    /// historical metadata, or other owners, and cannot authorize broker exit.
    pub fn quiescence(&self) -> RuntimeQuiescence {
        self.registry
            .lock()
            .map(|registry| assess(&registry))
            .unwrap_or(RuntimeQuiescence::Unverified)
    }

    /// Atomically seal this manager's launch admission only when cleanup is proved.
    /// This never sends signals, stops a process, or exits the broker. A future
    /// caller must separately fence broker operations and validate UI/legacy leases.
    pub fn try_close_if_quiescent(&self) -> Result<(), RuntimeQuiescence> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| RuntimeQuiescence::Unverified)?;
        // launch_environment holds this same lock through spawn/registration.
        seal(&mut registry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(state: &str, done: bool, verified: bool, error: Option<&str>) -> Arc<Runtime> {
        Arc::new(Runtime {
            control: Mutex::new(Control {
                info: RuntimeInfo {
                    id: "synthetic".into(),
                    pane_id: "synthetic".into(),
                    session_id: None,
                    state: state.into(),
                    cwd: "/synthetic".into(),
                    exit_code: Some(0),
                },
                resume_key: None,
                flow: FlowControl::default(),
                input: VecDeque::new(),
                stop_requested: false,
                input_closed: done,
                cleanup_error: error.map(str::to_owned),
                cleanup_verified: verified,
                done,
            }),
            changed: Condvar::new(),
            master: Mutex::new(None),
        })
    }
    fn registry_with(runtime: Arc<Runtime>) -> Registry {
        Registry {
            runtimes: HashMap::from([("synthetic".into(), runtime)]),
            ..Registry::default()
        }
    }

    #[test]
    fn public_terminal_labels_and_exit_codes_are_never_cleanup_proof() {
        for state in [
            "starting",
            "running",
            "stopping",
            "unknown",
            "exited",
            "failed",
            "interrupted",
        ] {
            let mut registry = registry_with(record(state, false, false, None));
            assert_eq!(assess(&registry), RuntimeQuiescence::Active, "{state}");
            assert_eq!(seal(&mut registry), Err(RuntimeQuiescence::Active));
            assert!(!registry.shutting_down);
            let mut completed = registry_with(record(state, true, false, None));
            assert_eq!(seal(&mut completed), Err(RuntimeQuiescence::Unverified));
            assert!(!completed.shutting_down);
        }
    }
    #[test]
    fn only_positive_cleanup_and_terminal_completion_allow_sealing() {
        for state in ["exited", "failed"] {
            let mut registry = registry_with(record(state, true, true, None));
            assert_eq!(seal(&mut registry), Ok(()));
            assert!(registry.shutting_down);
            assert_eq!(seal(&mut registry), Ok(()));
        }
        for state in ["starting", "running", "stopping", "unknown", "interrupted"] {
            let mut registry = registry_with(record(state, true, true, None));
            assert_eq!(seal(&mut registry), Err(RuntimeQuiescence::Unverified));
        }
    }
    #[test]
    fn cleanup_failure_and_unknown_rollback_survive_record_eviction() {
        for (verified, error) in [
            (false, None),
            (true, Some("ownership lost")),
            (true, Some("cleanup failed")),
        ] {
            let mut registry = registry_with(record("failed", true, verified, error));
            registry.prune_completed();
            assert!(registry.runtimes.is_empty());
            assert_eq!(seal(&mut registry), Err(RuntimeQuiescence::Unverified));
        }
        let mut registry = Registry {
            cleanup_uncertain: true,
            ..Registry::default()
        };
        assert_eq!(seal(&mut registry), Err(RuntimeQuiescence::Unverified));
    }
    #[test]
    fn poisoned_control_and_registry_never_authorize_exit() {
        let runtime = record("exited", true, true, None);
        let _ = std::panic::catch_unwind(|| {
            let _guard = runtime.control.lock().unwrap();
            panic!("synthetic poison");
        });
        let mut registry = registry_with(runtime);
        assert_eq!(assess(&registry), RuntimeQuiescence::Unverified);
        registry.prune_completed();
        assert_eq!(assess(&registry), RuntimeQuiescence::Unverified);
        let manager = RuntimeManager::new();
        let _ = std::panic::catch_unwind(|| {
            let _guard = manager.registry.lock().unwrap();
            panic!("synthetic poison");
        });
        assert_eq!(manager.quiescence(), RuntimeQuiescence::Unverified);
        assert_eq!(
            manager.try_close_if_quiescent(),
            Err(RuntimeQuiescence::Unverified)
        );
    }
    #[test]
    fn a_launch_waiting_on_the_registry_cannot_cross_the_idle_seal() {
        let manager = RuntimeManager::new();
        let mut guard = manager.registry.lock().unwrap();
        let (entered, received) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let pending = scope.spawn(|| {
                entered.send(()).unwrap();
                manager.launch(
                    LaunchSpec {
                        executable: "must-not-run".into(),
                        args: vec![],
                        cwd: std::env::temp_dir(),
                        env: HashMap::new(),
                        session_id: None,
                        resume_key: None,
                        pane_id: "synthetic".into(),
                    },
                    80,
                    24,
                    Arc::new(|_| panic!("must not emit")),
                )
            });
            received.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(seal(&mut guard), Ok(()));
            drop(guard);
            assert!(pending
                .join()
                .unwrap()
                .unwrap_err()
                .contains("shutting down"));
        });
        assert!(manager.list().is_empty());
    }
}
