//! Pure provider adapters and short-lived observations used by an explicitly ordered broker bridge.
//!
//! A normalized observation is evidence that a hook fired, not proof that a process
//! is currently working or awaiting human input. In particular Stop is gateable.
//! Transport must authenticate and order events BEFORE constructing an envelope.
use crate::{models::AgentKind, providers};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_TRACKED_TURNS: usize = 128;
pub const OBSERVATION_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActivityAdapter {
    CodexHooks,
    ClaudeHooks,
    GrokHooks,
    AntigravityHooks,
    OpenCodeV1Events,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Observation {
    PromptSubmitted,
    ToolPending,
    ToolFinished,
    PermissionRequested,
    AwaitingInput,
    AwaitingPermission,
    WaitingInput,
    WaitingPermission,
    TurnStopRequested,
    InvocationStarted,
    InvocationEnded,
    SessionEnded,
    Interrupted,
    Failed,
    Busy,
    Idle,
    Retry,
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
pub struct NormalizedEvent {
    pub session_id: String,
    pub observation: Observation,
    pub turn_id: Option<String>,
}

fn identifier(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
}

/// `registered_event` is provided by the trusted hook registration, not terminal
/// output. Required because Antigravity has no documented event-name payload field.
/// Unknown events invalidate prior observations; child events never update a parent.
/// No prompt/tool arguments, paths, transcript text or permission reasons are retained.
pub fn normalize(
    kind: AgentKind,
    registered_event: &str,
    payload: &[u8],
) -> Result<Option<NormalizedEvent>, &'static str> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err("Hook payload exceeds size limit");
    }
    let value: Value = serde_json::from_slice(payload).map_err(|_| "Invalid hook JSON")?;
    if !value.is_object() {
        return Err("Hook payload must be an object");
    }
    let adapter = providers::definition(kind).activity.adapter;
    let (session, observation) = match adapter {
        ActivityAdapter::CodexHooks | ActivityAdapter::ClaudeHooks => {
            let event = identifier(value.get("hook_event_name")).ok_or("Missing hook event")?;
            if event != registered_event {
                return Err("Hook event does not match registration");
            }
            let session = identifier(value.get("session_id")).ok_or("Missing session identity")?;
            // Claude subagent common events share the parent session ID. Codex
            // SubagentStart/Stop are child notifications, not parent turn changes.
            if event.starts_with("Subagent") || value.get("agent_id").is_some_and(|v| !v.is_null())
            {
                return Ok(None);
            }
            let observation = match event {
                "UserPromptSubmit" => Observation::PromptSubmitted,
                "PreToolUse" => Observation::ToolPending,
                "PostToolUse" => Observation::ToolFinished,
                "PermissionRequest" => Observation::PermissionRequested,
                "Notification" if adapter == ActivityAdapter::ClaudeHooks => {
                    match value.get("notification_type").and_then(Value::as_str) {
                        Some("idle_prompt" | "elicitation_dialog" | "elicitation_url_dialog") => {
                            Observation::WaitingInput
                        }
                        Some("permission_prompt") => Observation::WaitingPermission,
                        _ => Observation::Unknown,
                    }
                }
                "Stop" => Observation::TurnStopRequested,
                "SessionEnd" => Observation::SessionEnded,
                "Interrupt" if adapter == ActivityAdapter::CodexHooks => Observation::Interrupted,
                "StopFailure" if adapter == ActivityAdapter::ClaudeHooks => Observation::Failed,
                _ => Observation::Unknown,
            };
            (session, observation)
        }
        ActivityAdapter::GrokHooks => {
            if value.get("subagentType").is_some_and(|v| !v.is_null())
                || value.get("subagentId").is_some_and(|v| !v.is_null())
            {
                return Ok(None);
            }
            normalize_grok(registered_event, &value)?
        }
        ActivityAdapter::AntigravityHooks => {
            let session =
                identifier(value.get("conversationId")).ok_or("Missing conversation identity")?;
            let observation = match registered_event {
                "PreInvocation" => Observation::InvocationStarted,
                "PostInvocation" => Observation::InvocationEnded,
                "PreToolUse" => Observation::ToolPending,
                "PostToolUse" => Observation::ToolFinished,
                "Stop" => Observation::TurnStopRequested,
                _ => Observation::Unknown,
            };
            (session, observation)
        }
        ActivityAdapter::OpenCodeV1Events => normalize_opencode(registered_event, &value)?,
    };
    let turn_key = match adapter {
        ActivityAdapter::CodexHooks => Some("turn_id"),
        ActivityAdapter::ClaudeHooks => Some("prompt_id"),
        ActivityAdapter::GrokHooks => Some("promptId"),
        _ => None,
    };
    let turn_id = turn_key
        .and_then(|key| identifier(value.get(key)))
        .map(str::to_owned);
    if turn_key.is_some_and(|key| value.get(key).is_some_and(|v| !v.is_null()) && turn_id.is_none())
    {
        return Err("Invalid turn identity");
    }
    Ok(Some(NormalizedEvent {
        session_id: session.to_owned(),
        observation,
        turn_id,
    }))
}

// Provider-specific schemas stay separate even where event names overlap.
fn normalize_grok<'a>(
    event: &str,
    value: &'a Value,
) -> Result<(&'a str, Observation), &'static str> {
    let payload_event = identifier(value.get("hook_event_name")).ok_or("Missing hook event")?;
    if payload_event != event {
        return Err("Hook event does not match registration");
    }
    let session = identifier(value.get("sessionId")).ok_or("Missing session identity")?;
    let observation = match event {
        "UserPromptSubmit" => Observation::PromptSubmitted,
        "PreToolUse" => Observation::ToolPending,
        "PostToolUse" => Observation::ToolFinished,
        "Stop" => Observation::TurnStopRequested,
        "SessionEnd" => Observation::SessionEnded,
        "Notification"
            if value.get("notificationType").and_then(Value::as_str)
                == Some("permission_prompt") =>
        {
            Observation::PermissionRequested
        }
        _ => Observation::Unknown,
    };
    Ok((session, observation))
}

fn normalize_opencode<'a>(
    event: &str,
    value: &'a Value,
) -> Result<(&'a str, Observation), &'static str> {
    if identifier(value.get("type")) != Some(event) {
        return Err("Event does not match registration");
    }
    // Deliberately v1 only: do not guess at the incompatible v2 `data` envelope.
    if value.get("data").is_some() {
        return Err("Unsupported OpenCode event envelope");
    }
    let props = value
        .get("properties")
        .filter(|v| v.is_object())
        .ok_or("Missing event properties")?;
    let session = identifier(props.get("sessionID")).ok_or("Missing session identity")?;
    let observation = match event {
        "session.status" => match props
            .get("status")
            .and_then(|s| s.get("type"))
            .and_then(Value::as_str)
        {
            Some("busy") => Observation::Busy,
            Some("idle") => Observation::Idle,
            Some("retry") => Observation::Retry,
            _ => Observation::Unknown,
        },
        _ => Observation::Unknown,
    };
    Ok((session, observation))
}

/// Non-secret routing identity. Comparing this is NOT authentication. The future
/// transport must verify a per-launch capability and assign an ordered sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub runtime_id: String,
    pub generation: String,
    pub kind: AgentKind,
    pub session_id: String,
}

pub struct Envelope {
    pub binding: Binding,
    pub sequence: u64,
    pub event: NormalizedEvent,
}

/// Ephemeral, per-runtime state. Never persisted into workspace/catalog history.
/// Reset with a new generation on reconnect, invalidate on gaps/errors, and close
/// on runtime exit. Silence expires to unknown; it never becomes idle.
pub struct ActivityTracker {
    binding: Binding,
    sequence: u64,
    latest: Option<(Observation, Instant)>,
    closed: bool,
    turn_id: Option<String>,
    seen_turns: HashSet<String>,
}

impl ActivityTracker {
    pub fn new(binding: Binding) -> Result<Self, &'static str> {
        for s in [
            &binding.runtime_id,
            &binding.generation,
            &binding.session_id,
        ] {
            if s.is_empty() || s.len() > 512 || s.chars().any(char::is_control) {
                return Err("Invalid activity binding");
            }
        }
        Ok(Self {
            binding,
            sequence: 0,
            latest: None,
            closed: false,
            turn_id: None,
            seen_turns: HashSet::new(),
        })
    }

    pub fn apply(&mut self, envelope: Envelope, now: Instant) -> bool {
        if self.closed
            || envelope.binding != self.binding
            || envelope.event.session_id != self.binding.session_id
            || envelope.sequence <= self.sequence
        {
            return false;
        }
        let contiguous = self.sequence.checked_add(1) == Some(envelope.sequence);
        self.sequence = envelope.sequence;
        if !contiguous {
            // Lost causality cannot be recovered by the next arriving callback.
            // Require a new authenticated generation / authoritative resync.
            self.close();
            return false;
        }
        if envelope.event.observation == Observation::Unknown {
            self.invalidate();
            return true;
        }
        if envelope.event.observation == Observation::PromptSubmitted {
            if let Some(turn) = &envelope.event.turn_id {
                if self.seen_turns.contains(turn) {
                    return false;
                }
                if self.seen_turns.len() >= MAX_TRACKED_TURNS {
                    self.close();
                    return false;
                }
                self.seen_turns.insert(turn.clone());
            } else if self.turn_id.is_some() {
                self.close();
                return false;
            }
            self.turn_id = envelope.event.turn_id.clone();
        } else if self.turn_id.is_some()
            && envelope.event.turn_id != self.turn_id
            && envelope.event.observation != Observation::SessionEnded
        {
            // A delayed old-prompt callback cannot overwrite the current turn.
            // Still consume the transport sequence; the next event is not a gap.
            if envelope.event.turn_id.is_none() {
                self.invalidate();
            }
            return false;
        }
        self.latest = if envelope.event.observation != Observation::Unknown {
            Some((envelope.event.observation, now))
        } else {
            None
        };
        if envelope.event.observation == Observation::SessionEnded {
            self.closed = true;
        }
        true
    }

    pub fn observation(&self, now: Instant) -> Option<Observation> {
        self.snapshot(now).map(|(observation, _)| observation)
    }
    /// Remaining validity is anchored to receipt time, never renewed by polling.
    pub fn snapshot(&self, now: Instant) -> Option<(Observation, Duration)> {
        self.latest.and_then(|(observation, at)| {
            now.checked_duration_since(at)
                .and_then(|elapsed| OBSERVATION_TTL.checked_sub(elapsed))
                .filter(|remaining| !remaining.is_zero())
                .map(|remaining| (observation, remaining))
        })
    }
    /// Consume an authenticated, ordered child event without changing its parent.
    pub fn skip(&mut self, sequence: u64) -> bool {
        if self.closed || sequence <= self.sequence {
            return false;
        }
        if self.sequence.checked_add(1) != Some(sequence) {
            self.close();
            return false;
        }
        self.sequence = sequence;
        true
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn invalidate(&mut self) {
        self.latest = None;
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.invalidate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(kind: AgentKind, name: &str, value: Value) -> Option<NormalizedEvent> {
        normalize(kind, name, &serde_json::to_vec(&value).unwrap()).unwrap()
    }
    fn hook(kind: AgentKind, name: &str) -> Value {
        match kind {
            AgentKind::Codex | AgentKind::Claude => {
                json!({"hook_event_name":name,"session_id":"synthetic-session"})
            }
            AgentKind::Grok => json!({"hook_event_name":name,"sessionId":"synthetic-session"}),
            AgentKind::Antigravity => json!({"conversationId":"synthetic-session"}),
            AgentKind::OpenCode => {
                json!({"type":name,"properties":{"sessionID":"synthetic-session","status":{"type":"busy"}}})
            }
        }
    }
    fn binding() -> Binding {
        Binding {
            runtime_id: "runtime-1".into(),
            generation: "launch-1".into(),
            kind: AgentKind::Claude,
            session_id: "synthetic-session".into(),
        }
    }
    fn envelope(sequence: u64, observation: Observation) -> Envelope {
        Envelope {
            binding: binding(),
            sequence,
            event: NormalizedEvent {
                session_id: "synthetic-session".into(),
                turn_id: None,
                observation,
            },
        }
    }
    #[test]
    fn every_registered_adapter_normalizes_only_reviewed_observations() {
        for kind in [AgentKind::Codex, AgentKind::Claude, AgentKind::Grok] {
            for (name, expected) in [
                ("UserPromptSubmit", Observation::PromptSubmitted),
                ("PreToolUse", Observation::ToolPending),
                ("PostToolUse", Observation::ToolFinished),
                ("Stop", Observation::TurnStopRequested),
                ("SessionEnd", Observation::SessionEnded),
            ] {
                let event = parse(kind, name, hook(kind, name)).unwrap();
                assert_eq!(event.observation, expected);
                assert_eq!(event.session_id, "synthetic-session");
            }
        }
        for (name, expected) in [
            ("PreInvocation", Observation::InvocationStarted),
            ("PostInvocation", Observation::InvocationEnded),
            ("PreToolUse", Observation::ToolPending),
            ("PostToolUse", Observation::ToolFinished),
            ("Stop", Observation::TurnStopRequested),
        ] {
            let mut payload = hook(AgentKind::Antigravity, name);
            payload["fullyIdle"] = json!(true);
            assert_eq!(
                parse(AgentKind::Antigravity, name, payload)
                    .unwrap()
                    .observation,
                expected
            );
        }
        for (status, expected) in [
            ("busy", Observation::Busy),
            ("idle", Observation::Idle),
            ("retry", Observation::Retry),
            ("future", Observation::Unknown),
        ] {
            let mut payload = hook(AgentKind::OpenCode, "session.status");
            payload["properties"]["status"]["type"] = json!(status);
            assert_eq!(
                parse(AgentKind::OpenCode, "session.status", payload)
                    .unwrap()
                    .observation,
                expected
            );
        }
    }
    #[test]
    fn permission_and_failure_support_are_provider_specific() {
        for kind in [AgentKind::Claude, AgentKind::Codex] {
            assert_eq!(
                parse(kind, "PermissionRequest", hook(kind, "PermissionRequest"))
                    .unwrap()
                    .observation,
                Observation::PermissionRequested
            );
        }
        assert_eq!(
            parse(
                AgentKind::Grok,
                "PermissionRequest",
                hook(AgentKind::Grok, "PermissionRequest")
            )
            .unwrap()
            .observation,
            Observation::Unknown
        );
        let mut grok = hook(AgentKind::Grok, "Notification");
        grok["notificationType"] = json!("permission_prompt");
        assert_eq!(
            parse(AgentKind::Grok, "Notification", grok.clone())
                .unwrap()
                .observation,
            Observation::PermissionRequested
        );
        grok["notificationType"] = json!("new_feature");
        assert_eq!(
            parse(AgentKind::Grok, "Notification", grok)
                .unwrap()
                .observation,
            Observation::Unknown
        );
        for (kind, name, expected) in [
            (AgentKind::Codex, "Interrupt", Observation::Interrupted),
            (AgentKind::Claude, "StopFailure", Observation::Failed),
            (AgentKind::Codex, "StopFailure", Observation::Unknown),
        ] {
            assert_eq!(
                parse(kind, name, hook(kind, name)).unwrap().observation,
                expected
            );
        }
    }
    #[test]
    fn children_and_teammates_do_not_finish_parent_turns() {
        for kind in [AgentKind::Codex, AgentKind::Claude] {
            assert!(parse(kind, "SubagentStop", hook(kind, "SubagentStop")).is_none());
            let mut child = hook(kind, "Stop");
            child["agent_id"] = json!("child");
            assert!(parse(kind, "Stop", child).is_none());
        }
        for field in ["subagentType", "subagentId"] {
            let mut child = hook(AgentKind::Grok, "Stop");
            child[field] = json!("child");
            assert!(parse(AgentKind::Grok, "Stop", child).is_none());
        }
    }
    #[test]
    fn unknown_events_invalidate_instead_of_manufacturing_activity() {
        for kind in AgentKind::ALL {
            assert_eq!(
                parse(kind, "FutureEvent", hook(kind, "FutureEvent"))
                    .unwrap()
                    .observation,
                Observation::Unknown
            );
        }
        let mut tracker = ActivityTracker::new(binding()).unwrap();
        let now = Instant::now();
        assert!(tracker.apply(envelope(1, Observation::Busy), now));
        assert!(tracker.apply(envelope(2, Observation::Unknown), now));
        assert_eq!(tracker.observation(now), None);
    }
    #[test]
    fn malformed_and_oversized_payloads_are_rejected_without_exposing_content() {
        for bytes in [b"not json".as_slice(), b"[]", b"null", b"{}"] {
            assert!(normalize(AgentKind::Claude, "Stop", bytes).is_err());
        }
        assert!(normalize(
            AgentKind::Claude,
            "Stop",
            &vec![b' '; MAX_PAYLOAD_BYTES + 1]
        )
        .is_err());
        for session in ["", "bad\nidentity"] {
            let mut value = hook(AgentKind::Claude, "Stop");
            value["session_id"] = json!(session);
            assert!(normalize(AgentKind::Claude, "Stop", value.to_string().as_bytes()).is_err());
        }
        let mut value = hook(AgentKind::Claude, "Stop");
        value["prompt_id"] = json!({"invalid":true});
        assert!(normalize(AgentKind::Claude, "Stop", value.to_string().as_bytes()).is_err());
        value = hook(AgentKind::Claude, "Stop");
        value["prompt"] = json!("synthetic private prompt");
        value["tool_input"] = json!({"secret":"not retained"});
        let normalized = parse(AgentKind::Claude, "Stop", value.clone()).unwrap();
        assert!(!format!("{normalized:?}").contains("private"));
        assert!(normalize(
            AgentKind::Claude,
            "PreToolUse",
            value.to_string().as_bytes()
        )
        .is_err());
    }
    #[test]
    fn opencode_versions_are_not_silently_conflated() {
        let mut value = hook(AgentKind::OpenCode, "session.status");
        value["data"] = value["properties"].clone();
        assert!(normalize(
            AgentKind::OpenCode,
            "session.status",
            value.to_string().as_bytes()
        )
        .is_err());
        value.as_object_mut().unwrap().remove("properties");
        assert!(normalize(
            AgentKind::OpenCode,
            "session.status",
            value.to_string().as_bytes()
        )
        .is_err());
    }
    #[test]
    fn binding_duplicate_replay_gaps_and_close_are_fenced() {
        let now = Instant::now();
        let mut tracker = ActivityTracker::new(binding()).unwrap();
        for field in 0..5 {
            let mut event = envelope(1, Observation::Busy);
            match field {
                0 => event.binding.runtime_id = "other".into(),
                1 => event.binding.generation = "old".into(),
                2 => event.binding.kind = AgentKind::Grok,
                3 => event.binding.session_id = "other".into(),
                _ => event.event.session_id = "child".into(),
            }
            assert!(!tracker.apply(event, now));
            assert_eq!(tracker.observation(now), None);
        }
        assert!(!tracker.apply(envelope(0, Observation::Busy), now));
        assert!(tracker.apply(envelope(1, Observation::Busy), now));
        assert!(!tracker.apply(envelope(1, Observation::Idle), now));
        assert_eq!(tracker.observation(now), Some(Observation::Busy));
        assert!(!tracker.apply(envelope(3, Observation::Idle), now));
        assert_eq!(tracker.observation(now), None);
        assert!(!tracker.apply(envelope(4, Observation::Retry), now));
        tracker.close();
        assert!(!tracker.apply(envelope(5, Observation::Busy), now));
        assert_eq!(tracker.observation(now), None);
    }
    #[test]
    fn session_end_seals_the_binding_without_claiming_the_process_exited() {
        let now = Instant::now();
        let mut tracker = ActivityTracker::new(binding()).unwrap();
        assert!(tracker.apply(envelope(1, Observation::SessionEnded), now));
        assert!(!tracker.apply(envelope(2, Observation::Busy), now));
        assert_eq!(tracker.observation(now), Some(Observation::SessionEnded));
        assert_eq!(tracker.observation(now + OBSERVATION_TTL), None);
    }

    #[test]
    fn silence_and_clock_regression_never_mean_idle() {
        let now = Instant::now();
        let mut tracker = ActivityTracker::new(binding()).unwrap();
        tracker.apply(envelope(1, Observation::Busy), now);
        assert_eq!(
            tracker.observation(now + OBSERVATION_TTL - Duration::from_millis(1)),
            Some(Observation::Busy)
        );
        assert_eq!(tracker.observation(now + OBSERVATION_TTL), None);
        assert_eq!(tracker.observation(now - Duration::from_millis(1)), None);
        tracker.invalidate();
        assert_eq!(tracker.observation(now), None);
    }
    #[test]
    fn late_prior_turn_callbacks_cannot_finish_the_next_prompt() {
        let now = Instant::now();
        let mut tracker = ActivityTracker::new(binding()).unwrap();
        let mut prompt = envelope(1, Observation::PromptSubmitted);
        prompt.event.turn_id = Some("opaque-new".into());
        assert!(tracker.apply(prompt, now));
        let mut old = envelope(2, Observation::TurnStopRequested);
        old.event.turn_id = Some("opaque-old".into());
        assert!(!tracker.apply(old, now));
        assert_eq!(tracker.observation(now), Some(Observation::PromptSubmitted));
        let mut current = envelope(3, Observation::ToolPending);
        current.event.turn_id = Some("opaque-new".into());
        assert!(tracker.apply(current, now));
        assert!(!tracker.apply(envelope(4, Observation::PermissionRequested), now));
        assert_eq!(tracker.observation(now), None);
    }
}

#[cfg(test)]
mod ordering_regressions {
    use super::*;
    fn event(sequence: u64, turn: &str, observation: Observation) -> Envelope {
        Envelope {
            binding: Binding {
                runtime_id: "r".into(),
                generation: "g".into(),
                kind: AgentKind::Claude,
                session_id: "s".into(),
            },
            sequence,
            event: NormalizedEvent {
                session_id: "s".into(),
                turn_id: Some(turn.into()),
                observation,
            },
        }
    }
    #[test]
    fn gaps_require_a_new_generation_not_the_next_old_stop() {
        let now = Instant::now();
        let mut tracker =
            ActivityTracker::new(event(1, "new", Observation::PromptSubmitted).binding).unwrap();
        assert!(tracker.apply(event(1, "new", Observation::PromptSubmitted), now));
        assert!(!tracker.apply(event(3, "old", Observation::TurnStopRequested), now));
        assert!(!tracker.apply(event(4, "old", Observation::TurnStopRequested), now));
        assert!(!tracker.apply(event(5, "next", Observation::PromptSubmitted), now));
        assert_eq!(tracker.observation(now), None);
    }
    #[test]
    fn repeated_source_prompts_do_not_reopen_retired_turns_or_refresh_freshness() {
        let now = Instant::now();
        let mut tracker =
            ActivityTracker::new(event(1, "a", Observation::PromptSubmitted).binding).unwrap();
        assert!(tracker.apply(event(1, "a", Observation::PromptSubmitted), now));
        assert!(tracker.apply(event(2, "b", Observation::PromptSubmitted), now));
        assert!(!tracker.apply(event(3, "a", Observation::PromptSubmitted), now));
        assert!(!tracker.apply(event(4, "a", Observation::TurnStopRequested), now));
        assert!(!tracker.apply(
            event(5, "b", Observation::PromptSubmitted),
            now + OBSERVATION_TTL
        ));
        assert_eq!(tracker.observation(now + OBSERVATION_TTL), None);
        assert!(tracker.apply(
            event(6, "b", Observation::ToolPending),
            now + OBSERVATION_TTL
        ));
    }
    #[test]
    fn retired_turn_memory_is_bounded_without_forgetting_replay_fences() {
        let now = Instant::now();
        let mut tracker =
            ActivityTracker::new(event(1, "a", Observation::PromptSubmitted).binding).unwrap();
        for i in 1..=MAX_TRACKED_TURNS {
            assert!(tracker.apply(
                event(i as u64, &i.to_string(), Observation::PromptSubmitted),
                now
            ));
        }
        assert!(!tracker.apply(
            event(
                MAX_TRACKED_TURNS as u64 + 1,
                "overflow",
                Observation::PromptSubmitted
            ),
            now
        ));
        assert_eq!(tracker.observation(now), None);
        assert_eq!(tracker.seen_turns.len(), MAX_TRACKED_TURNS);
    }
}
