//! Broker-owned lifecycle bridge for synchronous, launch-local provider hooks.
//! Only main-session barrier events are registered. Parallel tool completions
//! never become a fabricated current state; Stop remains a gateable observation.
use super::{activity, lock, Host, Request, Response};
use crate::{
    models::AgentKind,
    provider_hooks::{self as hooks, Callback},
};
use std::{path::PathBuf, time::Instant};

pub(super) struct Lease {
    pub launch: String,
    pub runtime_id: String,
    pub provider: AgentKind,
    pub expected_session: Option<String>,
    pub session: Option<String>,
    pub activity_generation: Option<String>,
    pub ended: bool,
    pub source_sequence: u64,
    pub live: bool,
    pub terminal: bool,
    pub retired_sessions: std::collections::HashSet<String>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Also covers host teardown when a runtime callback can no longer
        // upgrade its weak host reference. Never follow a callback-supplied path.
        crate::claude_state::cleanup(&self.launch);
        crate::opencode_state::cleanup(&self.launch);
    }
}
impl Host {
    pub(super) fn receive_terminal_status(
        &self,
        launch: &str,
        runtime_id: &str,
        status: Option<crate::terminal_status::Status>,
    ) {
        let mut leases = lock(&self.provider_hooks);
        let Some(lease) = leases
            .get_mut(launch)
            .filter(|lease| lease.terminal && lease.runtime_id == runtime_id && !lease.ended)
        else {
            return;
        };
        let mut states = lock(&self.activity);
        if lease.activity_generation.is_none() {
            // This identity is the owned terminal launch, never a claim about a
            // native provider session or about who wrote bytes into the PTY.
            let Ok(state) = activity::State::new(runtime_id, lease.provider, launch) else {
                return;
            };
            lease.activity_generation = Some(state.hook_generation().to_owned());
            states.insert(runtime_id.into(), state);
        }
        if let Some(state) = states
            .get_mut(runtime_id)
            .filter(|state| lease.activity_generation.as_deref() == Some(state.hook_generation()))
        {
            state.publish_terminal(status);
        }
    }

    pub(super) fn receive_provider_hook(
        &self,
        launch: &str,
        callback: Callback,
    ) -> Result<Response, String> {
        let mut leases = lock(&self.provider_hooks);
        let lease = leases
            .get_mut(launch)
            .ok_or("Hook launch revoked or not registered")?;
        if !self
            .runtime
            .list()
            .iter()
            .any(|r| r.id == lease.runtime_id && r.state == "running")
        {
            return Err("Hook runtime is no longer running".into());
        }
        // Once the launch-local lifecycle observer is admitted, gateable command
        // hooks cannot overwrite its current-state snapshots.
        if lease.live || lease.source_sequence > 0 {
            return Ok(Response::Ok);
        }
        // Validate again after IPC; clients cannot smuggle state or private data.
        let payload = callback.payload(lease.provider);
        let callback = Callback::parse(&callback.event, &payload)?.ok_or("Child callback")?;
        let rotating = lease.ended && callback.event == "SessionStart";
        if rotating {
            if lease.session.as_deref() == Some(callback.session.as_str())
                || lease.retired_sessions.contains(&callback.session)
                || lease.retired_sessions.len() >= 128
            {
                return Err(
                    "Cannot safely rebind a retired provider session; restart the pane".into(),
                );
            }
            if let Some(old) = lease.session.take() {
                lease.retired_sessions.insert(old);
            }
            lease.activity_generation = None;
            lease.ended = false;
        } else if lease.ended {
            return Err("Provider session ended; waiting for a fresh SessionStart".into());
        }
        if lease.session.is_none()
            && lease
                .expected_session
                .as_ref()
                .is_some_and(|s| s != &callback.session)
        {
            return Err("Hook session differs from resume identity".into());
        }
        if lease
            .session
            .as_ref()
            .is_some_and(|s| s != &callback.session)
        {
            return Err("Hook session differs from bound parent".into());
        }
        let mut activity = lock(&self.activity);
        if lease.session.is_none() {
            // Root SessionStart is the causal binding handshake. A skipped/untrusted
            // startup hook cannot bind from an arbitrary tool/subagent callback.
            if callback.event != "SessionStart" {
                return Err("Waiting for parent SessionStart hook".into());
            }
            let state = activity::State::new(&lease.runtime_id, lease.provider, &callback.session)?;
            lease.activity_generation = Some(state.hook_generation().to_owned());
            activity.insert(lease.runtime_id.clone(), state);
            lease.session = Some(callback.session.clone());
            lease.expected_session = None;
        }
        let state = activity
            .get_mut(&lease.runtime_id)
            .ok_or("Hook activity retired")?;
        if lease.activity_generation.as_deref() != Some(state.hook_generation()) {
            return Err("Hook activity generation superseded".into());
        }
        // Without prompt/turn identity there is no fence against delayed callbacks.
        // Older providers stay unknown rather than ordering callbacks by arrival.
        if !matches!(callback.event.as_str(), "SessionStart" | "SessionEnd")
            && callback.turn.is_none()
        {
            state.invalidate_hook_observation();
            return Ok(Response::Ok);
        }
        state.publish_hook(&callback.event, &payload, Instant::now())?;
        if callback.event == "SessionEnd" {
            lease.ended = true;
        }
        let bound = self.bind_provider_session(&lease.runtime_id, lease.session.as_deref());
        drop(activity);
        drop(leases);
        if bound {
            self.persist()?;
        }
        Ok(Response::Ok)
    }
    pub(super) fn receive_provider_state(
        &self,
        launch: &str,
        report: hooks::StateReport,
    ) -> Result<Response, String> {
        report.validate()?;
        let mut leases = lock(&self.provider_hooks);
        let lease = leases
            .get_mut(launch)
            .ok_or("State launch revoked or not registered")?;
        if !self
            .runtime
            .list()
            .iter()
            .any(|r| r.id == lease.runtime_id && r.state == "running")
        {
            return Err("State runtime is no longer running".into());
        }
        if !lease.live || lease.terminal {
            return Err("State source is not registered for this launch".into());
        }
        // Reports are full snapshots and sources stop refreshing after a lost
        // report, so a gap only means a later authoritative restart.
        if report.sequence <= lease.source_sequence {
            return Err("Provider state sequence replay".into());
        }
        if lease.source_sequence == 0
            && lease
                .expected_session
                .as_ref()
                .is_some_and(|id| id != &report.session)
        {
            return Err("Provider state differs from resume identity".into());
        }
        let mut activity = lock(&self.activity);
        // Direct snapshots come from the app-owned single ordered source, not
        // concurrent command callbacks. A new root session rotates the UI epoch.
        if lease.source_sequence == 0 || lease.session.as_deref() != Some(&report.session) {
            let state = activity::State::new(&lease.runtime_id, lease.provider, &report.session)?;
            lease.activity_generation = Some(state.hook_generation().to_owned());
            activity.insert(lease.runtime_id.clone(), state);
            lease.session = Some(report.session);
            lease.expected_session = None;
        }
        let state = activity
            .get_mut(&lease.runtime_id)
            .ok_or("State activity retired")?;
        if lease.activity_generation.as_deref() != Some(state.hook_generation()) {
            return Err("Provider state generation superseded".into());
        }
        state.publish_source(report.observation, Instant::now());
        lease.source_sequence = report.sequence;
        let bound = self.bind_provider_session(&lease.runtime_id, lease.session.as_deref());
        drop(activity);
        drop(leases);
        if bound {
            self.persist()?;
        }
        Ok(Response::Ok)
    }
    /// Records the first provider session for a runtime. Returns whether the
    /// record changed, so hook traffic does not rewrite runtime state each time.
    fn bind_provider_session(&self, runtime_id: &str, session: Option<&str>) -> bool {
        let Some(session) = session else { return false };
        match lock(&self.entries).get_mut(runtime_id) {
            Some(entry) if entry.record.provider_session_id.is_none() => {
                entry.record.provider_session_id = Some(session.to_owned());
                true
            }
            _ => false,
        }
    }
    pub(super) fn fail_provider_hook(&self, launch: &str) {
        if let Some(lease) = lock(&self.provider_hooks).remove(launch) {
            self.close_runtime_activity(&lease.runtime_id);
        }
    }
    pub(super) fn revoke_provider_hooks(&self, provider: AgentKind) {
        lock(&self.provider_hooks).retain(|_, lease| lease.provider != provider);
        self.revoke_provider_activity(provider);
    }
    pub(super) fn finish_runtime_hooks(&self, runtime_id: &str) {
        lock(&self.provider_hooks).retain(|_, lease| lease.runtime_id != runtime_id);
        if let Some(state) = lock(&self.activity).get_mut(runtime_id) {
            state.process_exit();
        }
    }
    pub(super) fn revoke_runtime_hooks(&self, runtime_id: &str) {
        lock(&self.provider_hooks).retain(|_, lease| lease.runtime_id != runtime_id);
        self.close_runtime_activity(runtime_id);
    }
}

pub fn send_provider_callback(callback: Option<Callback>) -> Result<(), String> {
    let directory =
        PathBuf::from(std::env::var_os(hooks::DIRECTORY).ok_or("Missing hook directory")?);
    let generation = std::env::var(hooks::GENERATION).map_err(|_| "Missing hook generation")?;
    let launch = std::env::var(hooks::LAUNCH).map_err(|_| "Missing hook launch")?;
    // Existing owner-authenticated socket only; never starts or discovers a broker.
    let request = match callback {
        Some(callback) => Request::ProviderHook {
            generation,
            launch,
            callback,
        },
        None => Request::ProviderHookFailed { generation, launch },
    };
    match super::client::exchange(&directory, &request)? {
        Response::Ok => Ok(()),
        _ => Err("Invalid hook response".into()),
    }
}

/// Publish a privacy-minimal snapshot from the one app-owned provider observer.
pub fn send_provider_state(report: hooks::StateReport) -> Result<(), String> {
    report.validate()?;
    let directory =
        PathBuf::from(std::env::var_os(hooks::DIRECTORY).ok_or("Missing hook directory")?);
    let generation = std::env::var(hooks::GENERATION).map_err(|_| "Missing hook generation")?;
    let launch = std::env::var(hooks::LAUNCH).map_err(|_| "Missing hook launch")?;
    match super::client::exchange(
        &directory,
        &Request::ProviderState {
            generation,
            launch,
            report,
        },
    )? {
        Response::Ok => Ok(()),
        _ => Err("Invalid state response".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_metadata_roundtrip_contains_no_source_payload() {
        let event = Callback::parse("UserPromptSubmit", br#"{"hook_event_name":"UserPromptSubmit","session_id":"s","turn_id":"t","prompt":"private","cwd":"/private"}"#).unwrap().unwrap();
        let bytes = event.payload(AgentKind::Codex);
        assert!(!String::from_utf8_lossy(&bytes).contains("private"));
        let normalized =
            crate::agent_activity::normalize(AgentKind::Codex, "UserPromptSubmit", &bytes)
                .unwrap()
                .unwrap();
        assert_eq!(normalized.turn_id.as_deref(), Some("t"));
    }
}

#[cfg(all(test, unix))]
mod opencode_tests {
    use super::*;
    use crate::{agent_activity::Observation, broker::UiEvent, runtime::LaunchSpec};
    use std::{collections::HashMap, os::unix::fs::PermissionsExt, path::Path, sync::Arc};

    fn launch(
        host: &Arc<Host>,
        root: &Path,
        pane: &str,
        resume: Option<&str>,
    ) -> Result<Response, String> {
        let executable = root.join("synthetic-opencode");
        std::fs::write(&executable,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '1.19.2\\n'; exit; fi\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        host.handle(Request::Launch {
            generation: host.generation.clone(),
            spec: Box::new(LaunchSpec {
                executable: executable.to_str().unwrap().into(),
                args: vec!["--session".into(), "ses_indexedRoot".into()],
                cwd: root.into(),
                env: HashMap::from([
                    (hooks::OPT_IN.into(), "live".into()),
                    ("OPENCODE_CONFIG_CONTENT".into(), "{}".into()),
                ]),
                session_id: Some("catalog-id-not-provider-id".into()),
                resume_key: Some("provider-opaque-database-and-session-key".into()),
                pane_id: pane.into(),
            }),
            kind: "opencode".into(),
            project_id: None,
            profile_id: None,
            resume_id: resume.map(str::to_owned),
            home_directory: false,
            cols: 80,
            rows: 24,
        })
    }

    fn state(
        host: &Host,
        launch: &str,
        session: &str,
        sequence: u64,
        observation: Observation,
    ) -> Result<Response, String> {
        host.receive_provider_state(
            launch,
            hooks::StateReport {
                session: session.into(),
                turn: None,
                sequence,
                observation,
            },
        )
    }

    fn observation(host: &Host, runtime: &str) -> Option<Observation> {
        let UiEvent::AgentActivity { observation, .. } =
            host.poll_activity(runtime, None, Instant::now()).unwrap()
        else {
            panic!("missing activity");
        };
        observation
    }

    #[test]
    fn opencode_native_root_sequence_retry_and_revoke_use_existing_state_pipeline() {
        let root = tempfile::tempdir().unwrap();
        let host = Host::open(root.path().into()).unwrap();
        let Response::Runtime { info: Some(info) } =
            launch(&host, root.path(), "live-pane", None).unwrap()
        else {
            panic!("missing runtime");
        };
        let launch = lock(&host.provider_hooks).keys().next().unwrap().clone();
        let path = crate::opencode_state::staged_path(&launch).unwrap();
        assert!(path.exists());
        assert_eq!(
            lock(&host.provider_hooks)[&launch]
                .expected_session
                .as_deref(),
            Some("ses_indexedRoot")
        );
        assert!(lock(&host.provider_hooks)[&launch].live);
        assert!(state(&host, &launch, "ses_wrongRoot", 1, Observation::Busy).is_err());
        assert_eq!(lock(&host.provider_hooks)[&launch].source_sequence, 0);
        state(&host, &launch, "ses_indexedRoot", 1, Observation::Busy).unwrap();
        assert_eq!(observation(&host, &info.id), Some(Observation::Busy));
        for sequence in [0, 1] {
            assert!(state(
                &host,
                &launch,
                "ses_indexedRoot",
                sequence,
                Observation::Idle
            )
            .is_err());
            assert_eq!(observation(&host, &info.id), Some(Observation::Busy));
        }
        state(&host, &launch, "ses_indexedRoot", 2, Observation::Retry).unwrap();
        assert_eq!(observation(&host, &info.id), Some(Observation::Retry));
        state(
            &host,
            &launch,
            "ses_indexedRoot",
            3,
            Observation::AwaitingInput,
        )
        .unwrap();
        assert_eq!(
            observation(&host, &info.id),
            Some(Observation::AwaitingInput)
        );
        state(&host, &launch, "ses_indexedRoot", 4, Observation::Unknown).unwrap();
        assert_eq!(observation(&host, &info.id), None);
        state(&host, &launch, "ses_nextRoot", 5, Observation::Idle).unwrap();
        assert_eq!(
            host.records()
                .iter()
                .find(|record| record.info.id == info.id)
                .unwrap()
                .provider_session_id
                .as_deref(),
            Some("ses_indexedRoot")
        );

        assert_eq!(observation(&host, &info.id), Some(Observation::Idle));
        // A source restarting after a lost report skips sequence numbers.
        state(&host, &launch, "ses_nextRoot", 7, Observation::Busy).unwrap();
        assert_eq!(observation(&host, &info.id), Some(Observation::Busy));
        assert!(state(&host, &launch, "ses_nextRoot", 6, Observation::Idle).is_err());
        assert_eq!(observation(&host, &info.id), Some(Observation::Busy));
        let expired = host
            .poll_activity(
                &info.id,
                None,
                Instant::now() + std::time::Duration::from_secs(31),
            )
            .unwrap();
        assert!(matches!(
            expired,
            UiEvent::AgentActivity {
                observation: None,
                ..
            }
        ));
        host.revoke_provider_hooks(AgentKind::OpenCode);
        assert!(lock(&host.provider_hooks).is_empty());
        assert!(!path.exists());
        assert_eq!(observation(&host, &info.id), None);
        assert!(state(&host, &launch, "ses_nextRoot", 8, Observation::Busy).is_err());
        assert_eq!(host.runtime.list()[0].state, "running");
        host.runtime.shutdown().unwrap();
    }

    #[test]
    fn opencode_failed_callback_runtime_exit_and_host_drop_remove_staging() {
        for cleanup_mode in 0..3 {
            let root = tempfile::tempdir().unwrap();
            let host = Host::open(root.path().into()).unwrap();
            let Response::Runtime { info: Some(info) } =
                launch(&host, root.path(), "cleanup-pane", Some("ses_indexedRoot")).unwrap()
            else {
                panic!("missing runtime");
            };
            let launch = lock(&host.provider_hooks).keys().next().unwrap().clone();
            let path = crate::opencode_state::staged_path(&launch).unwrap();
            if cleanup_mode == 0 {
                host.fail_provider_hook(&launch);
                assert!(!path.exists());
                host.runtime.shutdown().unwrap();
            } else if cleanup_mode == 1 {
                host.runtime.stop(&info.id).unwrap();
                let deadline = Instant::now() + std::time::Duration::from_secs(2);
                while path.exists() && Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                assert!(!path.exists());
            } else {
                // Lease-owned cleanup also works if callbacks lose their host.
                drop(host);
                assert!(!path.exists());
            }
        }
    }

    #[test]
    fn opencode_resume_metadata_mismatch_is_rejected_before_launch() {
        let root = tempfile::tempdir().unwrap();
        let host = Host::open(root.path().into()).unwrap();
        assert!(
            launch(&host, root.path(), "mismatch-pane", Some("ses_otherRoot"))
                .unwrap_err()
                .contains("resume metadata")
        );
        assert!(host.runtime.list().is_empty());
        assert!(lock(&host.provider_hooks).is_empty());
    }
}
