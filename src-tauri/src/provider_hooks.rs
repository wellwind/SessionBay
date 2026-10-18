//! Launch-local provider hooks. No user/project configuration files are edited.
//! The callback returns only `{}`: it cannot grant permissions or steer a model.
use crate::{models::AgentKind, runtime::LaunchSpec};
use serde::{Deserialize, Serialize};
use serde_json::json;
const MAX_RAW_INPUT: usize = 4 * 1024 * 1024;
use std::{io::Read, path::Path};

pub const OPT_IN: &str = "SESSIONBAY_ACTIVITY_HOOKS";
pub const DIRECTORY: &str = "SESSIONBAY_HOOK_DIRECTORY";
pub const GENERATION: &str = "SESSIONBAY_HOOK_GENERATION";
pub const LAUNCH: &str = "SESSIONBAY_HOOK_LAUNCH";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateReport {
    pub session: String,
    pub turn: Option<String>,
    pub sequence: u64,
    pub observation: crate::agent_activity::Observation,
}
impl StateReport {
    pub fn validate(&self) -> Result<(), String> {
        use crate::agent_activity::Observation::*;
        let valid_id =
            |s: &str| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control);
        if !valid_id(&self.session)
            || self.turn.as_deref().is_some_and(|s| !valid_id(s))
            || self.sequence == 0
            || self.sequence > 9_007_199_254_740_991
            || !matches!(
                self.observation,
                Busy | Idle | AwaitingInput | AwaitingPermission | Failed | Interrupted | Unknown
            )
        {
            return Err("Invalid provider state metadata".into());
        }
        Ok(())
    }
}

pub const CAPABILITY: &str = "launchLocalStateV2";

pub fn supported(kind: AgentKind) -> bool {
    cfg!(unix) && matches!(kind, AgentKind::Codex | AgentKind::Claude)
}

// Provider command-hook APIs require shell strings. Quote only the trusted
// application executable and fixed event names; never interpolate hook payloads.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn configure(spec: &mut LaunchSpec, kind: AgentKind, helper: &Path) -> Result<(), String> {
    if !supported(kind) {
        return Err("此工具／平台尚未支援 launch-local hooks".into());
    }
    let helper = helper
        .to_str()
        .filter(|s| !s.chars().any(char::is_control))
        .ok_or("Hook helper path cannot be represented safely")?;
    let mut events = vec![
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "Stop",
        "SessionEnd",
    ];
    match kind {
        AgentKind::Codex => events.push("Interrupt"),
        AgentKind::Claude => events.extend(["StopFailure", "Notification"]),
        _ => unreachable!(),
    }
    if kind == AgentKind::Codex && !spec.args.iter().any(|arg| arg == "--no-daemon") {
        // A pre-existing shared app-server does not inherit this launch's ephemeral
        // callback routing environment. Keep the hook-owning process in this PTY.
        spec.args.push("--no-daemon".into());
    }
    let mut hooks = serde_json::Map::new();
    for event in events {
        let command = format!(
            "{} --sessionbay-provider-hook {}",
            quote(helper),
            quote(event)
        );
        let handler = json!({"type":"command", "command":command, "timeout":2});
        let group = if event == "Notification" {
            json!({"matcher":"^(idle_prompt|permission_prompt|elicitation_dialog|elicitation_url_dialog)$", "hooks":[handler]})
        } else {
            json!({"hooks":[handler]})
        };
        if kind == AgentKind::Codex {
            // JSON string escaping is valid for these TOML basic strings.
            let command = serde_json::to_string(&command).map_err(|e| e.to_string())?;
            spec.args.extend([
                "-c".into(),
                format!(
                    "hooks.{event}=[{{hooks=[{{type=\"command\",command={command},timeout=2}}]}}]"
                ),
            ]);
        } else {
            hooks.insert(event.into(), json!([group]));
        }
    }
    if kind == AgentKind::Claude {
        spec.args
            .extend(["--settings".into(), json!({"hooks": hooks}).to_string()]);
    }
    Ok(())
}

/// The only data crossing IPC is a bounded allowlist of identifiers and state.
/// Prompts, transcripts, paths, tool inputs, reasons and assistant text are dropped.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Callback {
    pub event: String,
    pub session: String,
    pub turn: Option<String>,
    pub notification: Option<String>,
    pub source: Option<String>,
}
#[derive(Deserialize)]
struct RawCallback {
    hook_event_name: String,
    session_id: String,
    turn_id: Option<String>,
    prompt_id: Option<String>,
    notification_type: Option<String>,
    source: Option<String>,
    agent_id: Option<String>,
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
impl Callback {
    pub fn parse(event: &str, payload: &[u8]) -> Result<Option<Self>, String> {
        if payload.len() > MAX_RAW_INPUT {
            return Err("Hook payload exceeds limit".into());
        }
        // Unknown fields deserialize as IgnoredAny; do not construct a JSON tree
        // containing prompts, assistant messages, paths or tool inputs.
        let value: RawCallback =
            serde_json::from_slice(payload).map_err(|_| "Invalid hook payload")?;
        if value.hook_event_name != event {
            return Err("Hook registration mismatch".into());
        }
        if value.agent_id.is_some() {
            return Ok(None);
        }
        if !matches!(
            event,
            "SessionStart"
                | "UserPromptSubmit"
                | "PermissionRequest"
                | "Stop"
                | "SessionEnd"
                | "Interrupt"
                | "StopFailure"
                | "Notification"
        ) {
            return Err("Unsupported lifecycle callback".into());
        }
        if event == "SessionStart" {
            match value.source.as_deref() {
                Some("fork") => return Ok(None),
                Some("startup" | "resume" | "clear" | "compact") => (),
                _ => return Err("Unrecognized parent SessionStart source".into()),
            }
        }
        let turn = value.turn_id.or(value.prompt_id);
        if !valid_identifier(&value.session_id)
            || turn.as_ref().is_some_and(|v| !valid_identifier(v))
            || value
                .notification_type
                .as_ref()
                .is_some_and(|v| !valid_identifier(v))
        {
            return Err("Invalid hook identifier".into());
        }
        Ok(Some(Self {
            event: event.into(),
            session: value.session_id,
            turn,
            notification: value.notification_type,
            source: value
                .source
                .filter(|v| matches!(v.as_str(), "startup" | "resume" | "clear" | "compact")),
        }))
    }
    pub(crate) fn payload(&self, kind: AgentKind) -> Vec<u8> {
        let turn_key = if kind == AgentKind::Codex {
            "turn_id"
        } else {
            "prompt_id"
        };
        let mut value = json!({"hook_event_name":self.event,"session_id":self.session,"notification_type":self.notification,"source":self.source});
        if let Some(turn) = &self.turn {
            value[turn_key] = json!(turn);
        }
        serde_json::to_vec(&value).expect("bounded callback serializes")
    }
}

/// Called before GUI startup in the desktop executable and the headless harness.
/// Always non-blocking to the provider's decision semantics, even if IPC fails.
pub fn run_callback_if_requested() -> bool {
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new("--sessionbay-provider-state"))
    {
        let result = (|| -> Result<(), String> {
            if std::env::args_os().count() != 2 {
                return Err("Unexpected state arguments".into());
            }
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(4097)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read state")?;
            if bytes.len() > 4096 {
                return Err("State too large".into());
            }
            let report: StateReport =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid state")?;
            report.validate()?;
            crate::broker::send_provider_state(report)
        })();
        if result.is_err() {
            let _ = crate::broker::send_provider_callback(None);
        }
        println!("{{}}");
        if result.is_err() {
            std::process::exit(1);
        }
        return true;
    }
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--sessionbay-provider-hook")) {
        return false;
    }
    let mut run = || -> Result<(), String> {
        let event = args
            .next()
            .and_then(|s| s.into_string().ok())
            .ok_or("Missing hook event")?;
        if args.next().is_some() {
            return Err("Unexpected callback argument".into());
        }
        let mut payload = Vec::new();
        std::io::stdin()
            .take(MAX_RAW_INPUT as u64 + 1)
            .read_to_end(&mut payload)
            .map_err(|_| "Cannot read callback")?;
        if let Some(callback) = Callback::parse(&event, &payload)? {
            // Broker rejection can be an expected stale/wrong-root callback. It
            // must not revoke the valid parent route. Transport loss expires the
            // last evidence naturally; malformed input is invalidated below.
            let _ = crate::broker::send_provider_callback(Some(callback));
        }
        Ok(())
    };
    if run().is_err() {
        // A lost lifecycle barrier invalidates evidence rather than retaining a
        // previous turn until its TTL. Never send the bad payload or an error log.
        let _ = crate::broker::send_provider_callback(None);
    }
    // A valid neutral JSON object is required by Codex Stop hooks.
    println!("{{}}");
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drops_private_fields_and_child_callbacks() {
        let bytes = br#"{"hook_event_name":"Stop","session_id":"s","turn_id":"t","prompt":"SECRET","transcript_path":"PRIVATE","last_assistant_message":"PRIVATE"}"#;
        let callback = Callback::parse("Stop", bytes).unwrap().unwrap();
        let encoded = serde_json::to_string(&callback).unwrap();
        assert!(!encoded.contains("PRIVATE") && !encoded.contains("SECRET"));
        assert!(Callback::parse(
            "Stop",
            br#"{"hook_event_name":"Stop","session_id":"s","agent_id":"child"}"#
        )
        .unwrap()
        .is_none());
        assert!(Callback::parse("SessionEnd", bytes).is_err());
    }
    #[test]
    fn large_private_fields_are_ignored_and_background_forks_cannot_bind() {
        let payload = json!({"hook_event_name":"UserPromptSubmit", "session_id":"s", "turn_id":"t", "prompt":"x".repeat(128 * 1024)}).to_string();
        let callback = Callback::parse("UserPromptSubmit", payload.as_bytes())
            .unwrap()
            .unwrap();
        assert!(serde_json::to_vec(&callback).unwrap().len() < 512);
        assert!(Callback::parse(
            "SessionStart",
            br#"{"hook_event_name":"SessionStart","session_id":"s","source":"fork"}"#
        )
        .unwrap()
        .is_none());
        assert!(Callback::parse(
            "SessionStart",
            br#"{"hook_event_name":"SessionStart","session_id":"s"}"#
        )
        .is_err());
        assert!(Callback::parse("Stop", &vec![b' '; MAX_RAW_INPUT + 1]).is_err());
    }
    #[test]
    fn registration_is_launch_local_and_never_bypasses_trust() {
        for kind in [AgentKind::Claude, AgentKind::Codex] {
            let mut spec = LaunchSpec {
                executable: "provider".into(),
                args: vec!["resume".into(), "id".into()],
                cwd: "/tmp".into(),
                env: Default::default(),
                session_id: None,
                resume_key: None,
                pane_id: "p".into(),
            };
            if !supported(kind) {
                continue;
            }
            configure(&mut spec, kind, Path::new("/app path/Session'Bay")).unwrap();
            assert_eq!(&spec.args[..2], &["resume", "id"]);
            let joined = spec.args.join(" ");
            assert!(!joined.contains("bypass") && !joined.contains("async"));
            assert!(joined.contains("SessionStart") && joined.contains("UserPromptSubmit"));
        }
    }
}

#[cfg(test)]
mod state_report_tests {
    use super::*;
    use crate::agent_activity::Observation;
    #[test]
    fn state_contract_only_accepts_minimal_current_state_metadata() {
        let mut report = StateReport {
            session: "root".into(),
            turn: Some("turn".into()),
            sequence: 1,
            observation: Observation::Busy,
        };
        assert!(report.validate().is_ok());
        report.observation = Observation::PromptSubmitted;
        assert!(report.validate().is_err());
        report.observation = Observation::Busy;
        report.sequence = 0;
        assert!(report.validate().is_err());
        assert!(serde_json::from_str::<StateReport>(
            r#"{"session":"s","turn":null,"sequence":1,"observation":"busy","prompt":"private"}"#
        )
        .is_err());
    }
}
