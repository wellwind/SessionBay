//! OSC 7501 program status for plain shell panes. Any program in the shell may
//! report, so this is display-only metadata: it never binds provider identity,
//! never carries report text, and has no publisher capability to authorize.
use super::{activity::Cursor, lock, Host, UiEvent};
use crate::terminal_status::Status;
use uuid::Uuid;

const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

pub(super) struct ShellStatus {
    generation: String,
    revision: u64,
    status: Option<Status>,
    live: bool,
}
impl ShellStatus {
    fn new() -> Self {
        Self {
            generation: Uuid::new_v4().to_string(),
            revision: 1,
            status: None,
            live: true,
        }
    }
    fn advance(&mut self) {
        self.revision = (self.revision + 1).min(MAX_SAFE_REVISION);
    }
    fn publish(&mut self, status: Option<Status>) {
        if self.live && self.status != status {
            self.status = status;
            self.advance();
        }
    }
    /// Finished results outlive the process; transient states end with it.
    fn process_exit(&mut self) {
        if !self.live {
            return;
        }
        self.live = false;
        if !matches!(self.status, Some(Status::Done | Status::Error)) && self.status.is_some() {
            self.status = None;
            self.advance();
        }
    }
    fn poll(&self, runtime_id: &str, after: Option<&Cursor>) -> Option<UiEvent> {
        if after.is_some_and(|after| {
            after.generation == self.generation && after.revision == self.revision
        }) {
            return None;
        }
        Some(UiEvent::TerminalStatus {
            runtime_id: runtime_id.into(),
            generation: self.generation.clone(),
            revision: self.revision,
            status: self.status,
        })
    }
}

impl Host {
    pub(super) fn receive_shell_terminal_status(&self, runtime_id: &str, status: Option<Status>) {
        let mut states = lock(&self.shell_status);
        // Records are bounded by runtime entries; a quiet shell never allocates one.
        if status.is_none() && !states.contains_key(runtime_id) {
            return;
        }
        states
            .entry(runtime_id.into())
            .or_insert_with(ShellStatus::new)
            .publish(status);
    }
    pub(super) fn finish_shell_terminal_status(&self, runtime_id: &str, status: Option<Status>) {
        if let Some(state) = lock(&self.shell_status).get_mut(runtime_id) {
            state.publish(status);
            state.process_exit();
        }
    }
    pub(super) fn poll_shell_status(
        &self,
        runtime_id: &str,
        after: Option<&Cursor>,
    ) -> Option<UiEvent> {
        let mut states = lock(&self.shell_status);
        let state = states.get_mut(runtime_id)?;
        if !self
            .runtime
            .list()
            .iter()
            .any(|info| info.id == runtime_id && info.state == "running")
        {
            state.process_exit();
        }
        state.poll(runtime_id, after)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(state: &ShellStatus) -> Cursor {
        Cursor {
            generation: state.generation.clone(),
            revision: state.revision,
        }
    }

    #[test]
    fn publishes_only_changes_and_resumes_after_a_cursor() {
        let mut state = ShellStatus::new();
        state.publish(Some(Status::Working));
        let seen = cursor(&state);
        assert!(state.poll("r", Some(&seen)).is_none());
        state.publish(Some(Status::Working));
        assert!(state.poll("r", Some(&seen)).is_none());
        state.publish(Some(Status::Done));
        assert!(matches!(
            state.poll("r", Some(&seen)),
            Some(UiEvent::TerminalStatus {
                status: Some(Status::Done),
                ..
            })
        ));
    }

    #[test]
    fn exit_drops_transient_states_and_keeps_results() {
        for (reported, kept) in [
            (Status::Working, None),
            (Status::Blocked, None),
            (Status::Idle, None),
            (Status::Done, Some(Status::Done)),
            (Status::Error, Some(Status::Error)),
        ] {
            let mut state = ShellStatus::new();
            state.publish(Some(reported));
            state.process_exit();
            assert_eq!(state.status, kept);
            // Nothing a dead process left behind can change the status afterwards.
            state.publish(Some(Status::Working));
            assert_eq!(state.status, kept);
        }
    }
}
