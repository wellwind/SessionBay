//! Read-only adapters for explicitly supported local JSONL shapes.
//! All examples and tests are synthetic; no live CLI history is inspected.
use crate::models::AgentKind;
use crate::providers::{self, ParserId};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub const PARSER_VERSION: i64 = 4;
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_INDEX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedState {
    pub external_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub custom_title: Option<String>,
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
    #[serde(default)]
    pub grok_metadata_hash: Option<String>,
    #[serde(default)]
    pub antigravity_metadata_hash: Option<String>,
    #[serde(default)]
    pub antigravity_updated_at: Option<String>,
    #[serde(default)]
    pub history_warning: Option<String>,
    #[serde(default)]
    pub grok_summary_at: Option<String>,
    #[serde(default)]
    pub grok_created_at: Option<String>,
    #[serde(default)]
    pub grok_model: Option<String>,
    #[serde(default)]
    pub grok_num_messages: Option<u64>,
    #[serde(default)]
    pub grok_prompt_starts: Vec<u64>,
    #[serde(default)]
    pub grok_seen_prompt_index: bool,
    #[serde(default)]
    pub grok_in_user: bool,
    #[serde(default)]
    pub grok_current_prompt_index: Option<u64>,
    #[serde(default)]
    pub grok_message_run: Option<GrokMessageRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrokMessageRun {
    pub start_line: u64,
    pub last_line: u64,
    pub role: String,
    pub prompt_index: Option<u64>,
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

// Only skip known leading harness context; keep transcript and search text intact.
fn task_title(text: &str) -> Option<String> {
    let mut remaining = text.trim();
    loop {
        if remaining.starts_with("# AGENTS.md instructions") {
            let (_, after) = remaining.split_once("</INSTRUCTIONS>")?;
            remaining = after.trim_start();
            continue;
        }
        let context = [
            ("<INSTRUCTIONS>", "</INSTRUCTIONS>"),
            ("<environment_context>", "</environment_context>"),
            ("<user_instructions>", "</user_instructions>"),
            ("<turn_aborted>", "</turn_aborted>"),
            ("<local-command-caveat>", "</local-command-caveat>"),
            ("<local-command-stdout>", "</local-command-stdout>"),
        ]
        .into_iter()
        .find(|(open, _)| remaining.starts_with(open));
        let Some((_, close)) = context else { break };
        let (_, after) = remaining.split_once(close)?;
        remaining = after.trim_start();
    }
    if remaining.is_empty() || remaining.starts_with("<command-name>") {
        return None;
    }
    Some(short_text(remaining, 100))
}

pub fn display_title(state: &ParsedState, kind: AgentKind, external_id: &str) -> String {
    state
        .custom_title
        .as_deref()
        .or(state.title.as_deref())
        .or(state.first_user.as_deref())
        .map(|text| short_text(text, 120))
        .unwrap_or_else(|| {
            format!(
                "{} {}",
                kind.as_str(),
                external_id.chars().take(12).collect::<String>()
            )
        })
}

// Codex names live outside rollouts. Read only the selected source's sidecar.
pub fn source_titles(kind: AgentKind, root: &Path) -> Result<HashMap<String, String>, String> {
    if providers::definition(kind).history.parser_id != Some(ParserId::Codex) {
        return Ok(HashMap::new());
    }
    let path = root.join("session_index.jsonl");
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err("Cannot read the Codex session name index.".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_TITLE_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the Codex session name index.")?;
    if bytes.len() as u64 > MAX_TITLE_INDEX_BYTES {
        return Err("Codex session name index exceeds the 16 MiB read limit.".into());
    }
    let mut titles: HashMap<String, (Option<String>, String)> = HashMap::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let (Some(id), Some(title)) = (string(&value, "id"), string(&value, "thread_name")) else {
            continue;
        };
        if id.len() > 256 {
            continue;
        }
        let updated = string(&value, "updated_at").and_then(|time| normalized_time(&time));
        if titles.get(&id).is_some_and(|(previous, _)| {
            previous
                .as_ref()
                .zip(updated.as_ref())
                .is_some_and(|(previous, updated)| previous > updated)
        }) {
            continue;
        }
        titles.insert(id, (updated, short_text(&title, 120)));
    }
    Ok(titles
        .into_iter()
        .map(|(id, (_, title))| (id, title))
        .collect())
}

pub fn fallback_id(path: &Path, kind: AgentKind) -> String {
    if kind == AgentKind::Grok {
        return path
            .parent()
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_owned();
    }
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
    if role == "user" && state.first_user.is_none() {
        state.first_user = task_title(&prose);
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
    match providers::definition(kind).history.parser_id {
        Some(ParserId::Codex) => {
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
        Some(ParserId::Claude) => search_content(
            value
                .get("message")
                .and_then(|m| m.get("content"))
                .or_else(|| value.get("content"))
                .unwrap_or(&Value::Null),
        ),
        Some(ParserId::Grok | ParserId::Antigravity) => parsed.text.clone(),
        None => String::new(),
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
    let timestamp = if kind == AgentKind::Antigravity {
        None
    } else {
        observe_timestamp(state, value)
    };
    match providers::definition(kind).history.parser_id {
        Some(ParserId::Codex) => parse_codex(value, state, timestamp),
        Some(ParserId::Claude) => parse_claude(value, state, timestamp, path),
        Some(ParserId::Grok) => parse_grok(value, state),
        Some(ParserId::Antigravity) => match crate::antigravity::parse_step(value) {
            Ok(step) => {
                state.recognized = true;
                if step.partial {
                    state.unknown_events += 1;
                }
                if let Some(time) = step.timestamp {
                    if state.event_at.as_ref().is_none_or(|old| old < &time) {
                        state.event_at = Some(time);
                    }
                }
                step.message
            }
            Err(_) => {
                state.unknown_events += 1;
                None
            }
        },
        None => None,
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
        "custom-title" => {
            state.recognized = true;
            if let Some(title) = string(value, "customTitle") {
                state.custom_title = Some(title);
            }
            None
        }
        "summary" => {
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

// ACP's durable envelope has Unix seconds; legacy records are raw notifications.
fn grok_params(value: &Value) -> Option<(&Value, bool)> {
    match value.get("method").and_then(Value::as_str) {
        Some("session/update") => Some((value.get("params")?, false)),
        Some("_x.ai/session/update") => Some((value.get("params")?, true)),
        None if value.get("method").is_none() => Some((value, false)),
        _ => None,
    }
}

fn parse_grok(value: &Value, state: &mut ParsedState) -> Option<ParsedMessage> {
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_i64)
        .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true));
    if let Some(time) = &timestamp {
        if state.event_at.as_ref().is_none_or(|old| time > old) {
            state.event_at = Some(time.clone());
        }
    }
    let Some((params, extension)) = grok_params(value) else {
        state.unknown_events += 1;
        return Some(placeholder("[Unsupported Grok notification]", timestamp));
    };
    let Some(id) = string(params, "sessionId") else {
        state.bad_lines += 1;
        return Some(placeholder(
            "[Grok notification without session identity]",
            timestamp,
        ));
    };
    if state
        .external_id
        .as_ref()
        .is_some_and(|expected| expected != &id)
    {
        state.identity_conflict = true;
        state.bad_lines += 1;
        return Some(placeholder(
            "[Conflicting session identity; record omitted]",
            timestamp,
        ));
    }
    state.external_id = Some(id);
    state.recognized = true;
    if state.conflicting_context {
        return None;
    }
    let Some(update) = params.get("update") else {
        state.bad_lines += 1;
        return Some(placeholder("[Malformed Grok update]", timestamp));
    };
    let tag = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match (extension, tag) {
        (false, "user_message_chunk" | "agent_message_chunk") => {
            if update.pointer("/_meta/hostTurn").and_then(Value::as_bool) == Some(true) {
                return Some(placeholder("[Host-generated context omitted]", timestamp));
            }
            let content = update.get("content").unwrap_or(&Value::Null);
            if content.pointer("/_meta/bashCommand").is_some() {
                return Some(placeholder("[Shell output omitted from search]", timestamp));
            }
            match content.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let Some(text) = content.get("text").filter(|text| text.is_string()) else {
                        state.bad_lines += 1;
                        return Some(placeholder("[Malformed Grok text chunk]", timestamp));
                    };
                    let role = if tag == "user_message_chunk" {
                        "user"
                    } else {
                        "assistant"
                    };
                    if text.as_str() == Some("") {
                        // Valid empty chunks are no-ops within a streaming run.
                        return Some(ParsedMessage {
                            role: role.into(),
                            text: String::new(),
                            timestamp,
                            searchable: true,
                            fallback: false,
                        });
                    }
                    message(role, text, timestamp, false, state)
                }
                Some("image" | "audio" | "resource" | "resource_link") => {
                    Some(placeholder("[Attachment; preview unavailable]", timestamp))
                }
                _ => {
                    state.unknown_events += 1;
                    Some(placeholder("[Unsupported Grok content block]", timestamp))
                }
            }
        }
        (false, "agent_thought_chunk") => {
            Some(placeholder("[Internal reasoning omitted]", timestamp))
        }
        (false, "tool_call" | "tool_call_update") => {
            Some(placeholder("[Tool output omitted from search]", timestamp))
        }
        (true, "rewind_marker") => {
            if update
                .get("target_prompt_index")
                .and_then(Value::as_u64)
                .is_none()
            {
                state.bad_lines += 1;
                return Some(placeholder("[Malformed Grok rewind marker]", timestamp));
            }
            None
        }
        (true, "compaction_checkpoint") => Some(placeholder(
            "[Conversation compacted; earlier context may be unavailable]",
            timestamp,
        )),
        (
            false,
            "plan"
            | "available_commands_update"
            | "current_mode_update"
            | "config_option_update"
            | "session_info_update"
            | "usage_update",
        ) => None,
        _ => {
            state.unknown_events += 1;
            Some(placeholder("[Unsupported Grok update]", timestamp))
        }
    }
}

// The saved physical-line boundaries let appended rewind markers delete an old
// branch without reparsing it. Match upstream's progressive promptIndex counting.
pub fn grok_timeline(value: &Value, state: &mut ParsedState, line: u64) -> Option<u64> {
    let Some((params, extension)) = grok_params(value) else {
        grok_end_user_run(state);
        return None;
    };
    if state.conflicting_context
        || params.get("sessionId").and_then(Value::as_str) != state.external_id.as_deref()
    {
        grok_end_user_run(state);
        return None;
    }
    let update = params.get("update").unwrap_or(&Value::Null);
    let tag = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    if extension && tag == "rewind_marker" {
        let boundary = update
            .get("target_prompt_index")
            .and_then(Value::as_u64)
            .and_then(|target| {
                let index = usize::try_from(target).ok()?;
                let boundary = state.grok_prompt_starts.get(index).copied();
                state.grok_prompt_starts.truncate(index);
                boundary
            });
        grok_end_user_run(state);
        return boundary;
    }
    if !extension
        && tag == "user_message_chunk"
        && update.pointer("/_meta/hostTurn").and_then(Value::as_bool) != Some(true)
    {
        let index = update.pointer("/_meta/promptIndex").and_then(Value::as_u64);
        state.grok_seen_prompt_index |= index.is_some();
        let new_run = !state.grok_in_user
            || (state.grok_seen_prompt_index && index != state.grok_current_prompt_index);
        if new_run {
            state.grok_current_prompt_index = index;
            if !state.grok_seen_prompt_index || index.is_some() {
                state.grok_prompt_starts.push(line);
            }
        }
        state.grok_in_user = true;
    } else {
        grok_end_user_run(state);
    }
    None
}

pub fn grok_end_user_run(state: &mut ParsedState) {
    state.grok_in_user = false;
    state.grok_current_prompt_index = None;
}

pub fn apply_grok_summary(state: &mut ParsedState, summary: &Value, directory_cwd: Option<String>) {
    let info = summary.get("info").unwrap_or(&Value::Null);
    let id = string(info, "id");
    if id.is_none() || id != state.external_id {
        state.bad_lines += 1;
        state.identity_conflict = true;
        state.conflicting_context = true;
        return;
    }
    let cwd = string(info, "cwd").filter(|cwd| Path::new(cwd).is_absolute() && !cwd.contains('\0'));
    if cwd
        .as_ref()
        .zip(directory_cwd.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        state.bad_lines += 1;
        state.identity_conflict = true;
        state.conflicting_context = true;
        state.cwd = None;
        return;
    }
    state.authoritative_cwd = cwd.is_some();
    state.cwd = cwd.or(directory_cwd);
    state.title = string(summary, "generated_title").or_else(|| string(summary, "session_summary"));
    state.grok_summary_at = ["last_active_at", "updated_at", "created_at"]
        .iter()
        .find_map(|key| {
            summary
                .get(key)
                .and_then(Value::as_str)
                .and_then(normalized_time)
        });
    state.grok_created_at = summary
        .get("created_at")
        .and_then(Value::as_str)
        .and_then(normalized_time);
    state.grok_num_messages = summary.get("num_messages").and_then(Value::as_u64);
    state.grok_model = string(summary, "current_model_id");
    state.parent_external = string(summary, "parent_session_id");
    state.child = summary
        .get("session_kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind.starts_with("subagent"));
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

    #[test]
    fn title_skips_leading_context_without_changing_searchable_content() {
        let mut state = ParsedState::default();
        let path = Path::new("s.jsonl");
        for text in [
            "# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>Use tests.</INSTRUCTIONS>",
            "<environment_context><cwd>/synthetic</cwd></environment_context>",
            "<turn_aborted>Previous turn interrupted.</turn_aborted>",
        ] {
            let value = json!({"type":"response_item","payload":{"type":"message","role":"user","content":text}});
            let parsed = parse_value(AgentKind::Codex, &value, &mut state, path).unwrap();
            assert_eq!(search_text(&value, AgentKind::Codex, &parsed), text);
            assert!(state.first_user.is_none());
        }
        let text = "<environment_context>Context</environment_context>\n修正登入流程與中文搜尋";
        let value = json!({"type":"response_item","payload":{"type":"message","role":"user","content":text}});
        parse_value(AgentKind::Codex, &value, &mut state, path);
        assert_eq!(state.first_user.as_deref(), Some("修正登入流程與中文搜尋"));
        assert_eq!(
            task_title("Please edit AGENTS.md to document testing."),
            Some("Please edit AGENTS.md to document testing.".into())
        );
        assert!(task_title("<environment_context>incomplete context").is_none());
    }

    #[test]
    fn claude_custom_name_survives_later_summaries_and_can_be_renamed() {
        let mut state = ParsedState::default();
        let path = Path::new("s.jsonl");
        for value in [
            json!({"type":"custom-title","sessionId":"s","customTitle":"登入修正"}),
            json!({"type":"summary","summary":"Later compaction summary"}),
        ] {
            parse_value(AgentKind::Claude, &value, &mut state, path);
        }
        assert_eq!(display_title(&state, AgentKind::Claude, "s"), "登入修正");
        parse_value(
            AgentKind::Claude,
            &json!({"type":"custom-title","sessionId":"s","customTitle":"驗證登入"}),
            &mut state,
            path,
        );
        assert_eq!(display_title(&state, AgentKind::Claude, "s"), "驗證登入");
    }

    #[test]
    fn codex_name_index_is_optional_bounded_and_tolerates_partial_records() {
        let temp = tempfile::tempdir().unwrap();
        assert!(source_titles(AgentKind::Codex, temp.path())
            .unwrap()
            .is_empty());
        let path = temp.path().join("session_index.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"id\":\"s\",\"thread_name\":\"Newest\",\"updated_at\":\"2026-10-15T12:00:00Z\"}\n",
                "malformed\n",
                "{\"id\":\"s\",\"thread_name\":\"Older\",\"updated_at\":\"2026-10-14T12:00:00Z\"}\n",
                "{\"id\":\"pending\",\"thread_name\":\"unfinished"
            ),
        ).unwrap();
        let titles = source_titles(AgentKind::Codex, temp.path()).unwrap();
        assert_eq!(titles.get("s").map(String::as_str), Some("Newest"));
        assert_eq!(titles.len(), 1);
        assert!(source_titles(AgentKind::Claude, temp.path())
            .unwrap()
            .is_empty());
        File::create(path)
            .unwrap()
            .set_len(MAX_TITLE_INDEX_BYTES + 1)
            .unwrap();
        assert!(source_titles(AgentKind::Codex, temp.path())
            .unwrap_err()
            .contains("read limit"));
    }
}
