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
    pub runtime_id: String,
    pub provider: AgentKind,
    pub expected_session: Option<String>,
    pub session: Option<String>,
    pub activity_generation: Option<String>,
    pub ended: bool,
    pub source_sequence: u64,
    pub live: bool,
    pub retired_sessions: std::collections::HashSet<String>,
}
impl Host {
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
        if !lease.live {
            return Err("State source is not registered for this launch".into());
        }
        if lease.source_sequence.checked_add(1) != Some(report.sequence) {
            return Err("Provider state sequence replay or gap".into());
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
        Ok(Response::Ok)
    }
    pub(super) fn fail_provider_hook(&self, launch: &str) {
        if let Some(lease) = lock(&self.provider_hooks).remove(launch) {
            crate::claude_state::cleanup(launch);
            self.close_runtime_activity(&lease.runtime_id);
        }
    }
    pub(super) fn revoke_provider_hooks(&self, provider: AgentKind) {
        let mut leases = lock(&self.provider_hooks);
        let ids: Vec<_> = leases
            .values()
            .filter(|lease| lease.provider == provider)
            .map(|lease| lease.runtime_id.clone())
            .collect();
        leases.retain(|launch, lease| {
            if lease.provider == provider {
                crate::claude_state::cleanup(launch);
                false
            } else {
                true
            }
        });
        for id in ids {
            self.close_runtime_activity(&id);
        }
    }
    pub(super) fn revoke_runtime_hooks(&self, runtime_id: &str) {
        lock(&self.provider_hooks).retain(|launch, lease| {
            if lease.runtime_id == runtime_id {
                crate::claude_state::cleanup(launch);
                false
            } else {
                true
            }
        });
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
