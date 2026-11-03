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
    pub terminal: bool,
    pub retired_sessions: std::collections::HashSet<String>,
}
impl Host {
    pub(super) fn receive_terminal_session_hint(&self, launch: &str, runtime_id: &str, id: &str) {
        if !crate::opencode::valid_session_id(id) || id.len() > 32 {
            return;
        }
        let leases = lock(&self.provider_hooks);
        if !leases.get(launch).is_some_and(|lease| {
            lease.terminal
                && !lease.ended
                && lease.provider == AgentKind::OpenCode
                && lease.runtime_id == runtime_id
        }) {
            return;
        }
        let mut entries = lock(&self.entries);
        if let Some(hint) = entries
            .get_mut(runtime_id)
            .and_then(|entry| entry.record.terminal_session_hint.as_mut())
        {
            if hint.ids.len() < 64 && !hint.ids.iter().any(|known| known == id) {
                hint.ids.push(id.to_owned());
            }
        }
        // Hints stay ephemeral; they are never a broker-authorized identity.
    }
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
        // Validate again after IPC; clients cannot smuggle state or private data.
        let payload = callback.payload(lease.provider);
        let callback = Callback::parse(&callback.event, &payload)?.ok_or("Child callback")?;
        if lease.provider == AgentKind::Claude {
            if callback.event != "SessionStart" {
                return Err("Claude hooks report session identity only".into());
            }
            if lease
                .expected_session
                .as_ref()
                .is_some_and(|id| id != &callback.session)
                || lease
                    .session
                    .as_ref()
                    .is_some_and(|id| id != &callback.session)
            {
                return Err("Hook session differs from bound or resumed identity".into());
            }
            lease.session = Some(callback.session);
            let bound = self.bind_provider_session(&lease.runtime_id, lease.session.as_deref());
            drop(leases);
            if bound {
                self.persist()?;
            }
            return Ok(Response::Ok);
        }
        if lease.live {
            return Ok(Response::Ok);
        }
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
            // Legacy hooks require the startup handshake.
            if !lease.live && callback.event != "SessionStart" {
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
        // Without turn identity there is no fence against delayed callbacks.
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
        if !lease.live || lease.terminal || lease.provider != AgentKind::Codex {
            return Err("State source is not registered for this launch".into());
        }
        // Reports are full snapshots and sources stop refreshing after a lost
        // report, so a gap only means a later authoritative restart.
        if report.sequence <= lease.source_sequence {
            return Err("Provider state sequence replay".into());
        }
        if lease.session.is_none()
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
        if lease.session.as_deref() != Some(&report.session) {
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
        let mut leases = lock(&self.provider_hooks);
        if leases
            .get(launch)
            .is_some_and(|lease| lease.provider == AgentKind::Claude && lease.terminal)
        {
            // Identity-hook transport errors must not disable terminal status.
            return;
        }
        if let Some(lease) = leases.remove(launch) {
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
