//! Read-only adapters for explicitly supported local JSONL shapes.
//! All examples and tests are synthetic; no live CLI history is inspected.
use crate::models::AgentKind;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

pub const PARSER_VERSION: i64 = 1;
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedState {
    pub external_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_user: Option<String>,
    pub event_at: Option<String>,
    pub parent_external: Option<String>,
    pub child: bool,
    pub recognized: bool,
    pub bad_lines: u64,
    pub unknown_events: u64,
    #[serde(default)]
    pub authoritative_cwd: bool,
    #[serde(default)]
    pub identity_conflict: bool,
    #[serde(default)]
    pub conflicting_context: bool,
}

#[derive(Debug, Clone)]
pub struct ParsedMessage {
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
    pub searchable: bool,
    pub fallback: bool,
}

pub fn normalized_time(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|t| {
        t.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

pub fn short_text(text: &str, max: usize) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result: String = clean.chars().take(max).collect();
    if clean.chars().count() > max {
        result.push('…');
    }
    result
}

pub fn fallback_id(path: &Path, kind: AgentKind) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    if kind == AgentKind::Codex && stem.len() >= 36 && stem.is_char_boundary(stem.len() - 36) {
        let candidate = &stem[stem.len() - 36..];
        if candidate.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        }) {
            return candidate.to_owned();
        }
    }
    stem.to_owned()
}

fn observe_timestamp(state: &mut ParsedState, value: &Value) -> Option<String> {
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(normalized_time);
    if let Some(ref timestamp) = timestamp {
        if state.event_at.as_ref().is_none_or(|old| timestamp > old) {
            state.event_at = Some(timestamp.clone());
        }
    }
    timestamp
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    let Some(blocks) = value.as_array() else {
        return String::new();
    };
    let mut parts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" | "input_text" | "output_text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            "image" | "input_image" | "image_url" => {
                parts.push("[Image attachment; preview unavailable]".into())
            }
            "document" | "file" | "input_file" => {
                parts.push("[File attachment; preview unavailable]".into())
            }
            "tool_use" => parts.push(format!(
                "[Tool call: {}]",
                block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            )),
            "tool_result" => parts.push("[Tool result omitted from search]".into()),
            "thinking" | "redacted_thinking" => parts.push("[Internal reasoning omitted]".into()),
            _ => parts.push("[Unsupported content block]".into()),
        }
    }
    parts.join("\n\n")
}

// Search indexes prose, never tool output, attachments, or hidden reasoning.
fn search_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    value
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(
                    |b| match b.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" | "input_text" | "output_text" => {
                            b.get("text").and_then(Value::as_str)
                        }
                        _ => None,
                    },
                )
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

fn message(
    role: &str,
    content: &Value,
    timestamp: Option<String>,
    fallback: bool,
    state: &mut ParsedState,
) -> Option<ParsedMessage> {
    let text = content_text(content);
    if text.is_empty() {
        return None;
    }
    let prose = search_content(content);
    if role == "user" && state.first_user.is_none() && !prose.trim().is_empty() {
        state.first_user = Some(short_text(&prose, 100));
    }
    Some(ParsedMessage {
        role: role.into(),
        text,
        timestamp,
        searchable: matches!(role, "user" | "assistant") && !prose.is_empty(),
        fallback,
    })
}

pub fn search_text(value: &Value, kind: AgentKind, parsed: &ParsedMessage) -> String {
    if !parsed.searchable {
        return String::new();
    }
    match kind {
        AgentKind::Codex => {
            let payload = value.get("payload").unwrap_or(value);
            if value.get("type").and_then(Value::as_str) == Some("event_msg") {
                payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            } else {
                search_content(payload.get("content").unwrap_or(&Value::Null))
            }
        }
        AgentKind::Claude => search_content(
            value
                .get("message")
                .and_then(|m| m.get("content"))
                .or_else(|| value.get("content"))
                .unwrap_or(&Value::Null),
        ),
    }
}

fn placeholder(text: &str, timestamp: Option<String>) -> ParsedMessage {
    ParsedMessage {
        role: "system".into(),
        text: text.into(),
        timestamp,
        searchable: false,
        fallback: false,
    }
}

pub fn parse_value(
    kind: AgentKind,
    value: &Value,
    state: &mut ParsedState,
    path: &Path,
) -> Option<ParsedMessage> {
    let timestamp = observe_timestamp(state, value);
    match kind {
        AgentKind::Codex => parse_codex(value, state, timestamp),
        AgentKind::Claude => parse_claude(value, state, timestamp, path),
    }
}

fn parse_codex(
    value: &Value,
    state: &mut ParsedState,
    timestamp: Option<String>,
) -> Option<ParsedMessage> {
    let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if state.conflicting_context && record_type != "session_meta" {
        return None;
    }
    match record_type {
        "session_meta" => {
            state.recognized = true;
            if let Some(id) = string(payload, "id") {
                if state
                    .external_id
                    .as_ref()
                    .is_some_and(|previous| previous != &id)
                {
                    state.identity_conflict = true;
                    state.conflicting_context = true;
                    state.bad_lines += 1;
                    return Some(placeholder(
                        "[Conflicting session identity; subsequent context omitted]",
                        timestamp,
                    ));
                }
                state.conflicting_context = false;
                state.external_id = Some(id);
            }
            if let Some(cwd) = string(payload, "cwd") {
                state.cwd = Some(cwd);
                state.authoritative_cwd = true;
            }
            if let Some(title) = string(payload, "title") {
                state.title = Some(title);
            }
            state.parent_external = string(payload, "forked_from_id")
                .or_else(|| string(payload, "parent_session_id"))
                .or_else(|| {
                    payload
                        .pointer("/source/subagent/thread_spawn/parent_thread_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .or_else(|| {
                    payload
                        .pointer("/source/subagent/parent_thread_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            state.child = payload.get("source").is_some_and(|source| {
                source.get("subagent").is_some() || source.as_str() == Some("subagent")
            });
            None
        }
        "turn_context" => {
            state.recognized = true;
            // If metadata has no cwd, the first recorded turn is the primary context.
            if state.cwd.is_none() {
                state.cwd = string(payload, "cwd");
            }
            None
        }
        "response_item" => {
            state.recognized = true;
            match payload.get("type").and_then(Value::as_str).unwrap_or("") {
                "message" => {
                    let role = payload
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    message(
                        role,
                        payload.get("content").unwrap_or(&Value::Null),
                        timestamp,
                        false,
                        state,
                    )
                }
                "function_call" | "custom_tool_call" | "local_shell_call" => {
                    Some(placeholder("[Tool call; arguments omitted]", timestamp))
                }
                "function_call_output" | "custom_tool_call_output" => {
                    Some(placeholder("[Tool output omitted from search]", timestamp))
                }
                "reasoning" => Some(placeholder("[Internal reasoning omitted]", timestamp)),
                "compaction" => Some(placeholder(
                    "[Conversation compacted; earlier context may be unavailable]",
                    timestamp,
                )),
                _ => {
                    state.unknown_events += 1;
                    Some(placeholder("[Unsupported Codex response item]", timestamp))
                }
            }
        }
        "event_msg" => {
            state.recognized = true;
            match payload.get("type").and_then(Value::as_str).unwrap_or("") {
                "user_message" => message(
                    "user",
                    payload.get("message").unwrap_or(&Value::Null),
                    timestamp,
                    true,
                    state,
                ),
                "agent_message" => message(
                    "assistant",
                    payload.get("message").unwrap_or(&Value::Null),
                    timestamp,
                    true,
                    state,
                ),
                "context_compacted" => Some(placeholder(
                    "[Conversation compacted; earlier context may be unavailable]",
                    timestamp,
                )),
                "token_count" | "task_started" | "task_complete" | "turn_aborted"
                | "agent_reasoning" | "item_completed" => None,
                _ => {
                    state.unknown_events += 1;
                    Some(placeholder("[Unsupported Codex event]", timestamp))
                }
            }
        }
        "compacted" => {
            state.recognized = true;
            Some(placeholder(
                "[Conversation compacted; earlier context may be unavailable]",
                timestamp,
            ))
        }
        _ => {
            state.unknown_events += 1;
            Some(placeholder("[Unsupported JSONL event]", timestamp))
        }
    }
}

fn parse_claude(
    value: &Value,
    state: &mut ParsedState,
    timestamp: Option<String>,
    path: &Path,
) -> Option<ParsedMessage> {
    let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let subagent = path.components().any(|c| c.as_os_str() == "subagents")
        || path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("agent-"));
    if let Some(session_id) = string(value, "sessionId") {
        if subagent || value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            state.child = true;
            state.parent_external = Some(session_id.clone());
            state.external_id = string(value, "agentId")
                .map(|id| format!("agent-{id}"))
                .or_else(|| Some(fallback_id(path, AgentKind::Claude)));
            if state.external_id.as_deref() == Some(session_id.as_str()) {
                state.external_id = Some(format!("sidechain-{session_id}"));
            }
        } else if state.external_id.is_none() {
            state.external_id = Some(session_id);
        } else if !state.child && state.external_id.as_ref() != Some(&session_id) {
            state.identity_conflict = true;
            state.bad_lines += 1;
            return Some(placeholder(
                "[Conflicting session identity; record omitted]",
                timestamp,
            ));
        }
    }
    if let Some(parent) =
        string(value, "parentSessionId").or_else(|| string(value, "forkedFromSessionId"))
    {
        state.parent_external = Some(parent);
    }
    match record_type {
        "user" | "assistant" => {
            state.recognized = true;
            // Claude has no separate initialization record: the first message cwd is primary.
            if state.cwd.is_none() {
                state.cwd = string(value, "cwd");
            }
            let content = value
                .get("message")
                .and_then(|m| m.get("content"))
                .or_else(|| value.get("content"))
                .unwrap_or(&Value::Null);
            message(record_type, content, timestamp, false, state)
        }
        "summary" | "custom-title" => {
            state.recognized = true;
            if let Some(title) = string(value, "customTitle").or_else(|| string(value, "summary")) {
                state.title = Some(title);
            }
            Some(placeholder(
                "[Saved summary; earlier context may be compacted]",
                timestamp,
            ))
        }
        "system" => {
            state.recognized = true;
            if value.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
                Some(placeholder(
                    "[Conversation compacted; earlier context may be unavailable]",
                    timestamp,
                ))
            } else {
                Some(placeholder("[System event]", timestamp))
            }
        }
        "progress" | "file-history-snapshot" | "queue-operation" | "last-prompt" | "pr-link" => {
            None
        }
        _ => {
            state.unknown_events += 1;
            Some(placeholder("[Unsupported Claude event]", timestamp))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_metadata_and_unicode_message() {
        let mut state = ParsedState::default();
        let path = Path::new("rollout-test.jsonl");
        parse_value(
            AgentKind::Codex,
            &json!({"type":"session_meta","payload":{"id":"test","cwd":"/synthetic/work"}}),
            &mut state,
            path,
        );
        let value = json!({"timestamp":"2026-01-01T10:00:00+08:00","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修正登入 parse_request"}]}});
        let message = parse_value(AgentKind::Codex, &value, &mut state, path).unwrap();
        assert_eq!(message.text, "修正登入 parse_request");
        assert_eq!(state.external_id.as_deref(), Some("test"));
        assert_eq!(state.event_at.as_deref(), Some("2026-01-01T02:00:00.000Z"));
    }

    #[test]
    fn claude_tool_output_is_not_searchable() {
        let value = json!({"type":"user","sessionId":"s","message":{"content":[{"type":"tool_result","content":"secret build output"}]}});
        let message = parse_value(
            AgentKind::Claude,
            &value,
            &mut ParsedState::default(),
            Path::new("s.jsonl"),
        )
        .unwrap();
        assert!(!message.searchable);
        assert!(!message.text.contains("secret build output"));
    }

    #[test]
    fn child_keeps_parent_and_does_not_merge_with_main() {
        let value = json!({"type":"assistant","sessionId":"parent","agentId":"abc","isSidechain":true,"message":{"content":"child answer"}});
        let mut state = ParsedState::default();
        parse_value(
            AgentKind::Claude,
            &value,
            &mut state,
            Path::new("projects/a/parent/subagents/agent-abc.jsonl"),
        );
        assert_eq!(state.external_id.as_deref(), Some("agent-abc"));
        assert_eq!(state.parent_external.as_deref(), Some("parent"));
        assert!(state.child);
    }

    #[test]
    fn initial_cwd_is_not_replaced_by_later_turns() {
        let mut state = ParsedState::default();
        let path = Path::new("s.jsonl");
        for cwd in ["/first", "/later"] {
            parse_value(
                AgentKind::Claude,
                &json!({"type":"user","sessionId":"s","cwd":cwd,"message":{"content":"test"}}),
                &mut state,
                path,
            );
        }
        assert_eq!(state.cwd.as_deref(), Some("/first"));
    }
}
