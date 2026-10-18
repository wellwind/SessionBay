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
    pub(super) fn fail_provider_hook(&self, launch: &str) {
        if let Some(lease) = lock(&self.provider_hooks).remove(launch) {
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
        leases.retain(|_, lease| lease.provider != provider);
        for id in ids {
            self.close_runtime_activity(&id);
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
