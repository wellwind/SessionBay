//! Defensive reader for the observed Antigravity persisted transcript step shape.
//!
//! The log location is documented by https://antigravity.google/docs/hooks.
//! Field evidence comes from the public capture in
//! https://github.com/google-antigravity/antigravity-cli/issues/618 (labelled 1.1.3),
//! CLEARED records in https://github.com/google-antigravity/antigravity-cli/issues/968,
//! and the community-maintained 1.2.12 capture at
//! https://github.com/lefos13/paseo-plugin-antigravity-cli/blob/9732a84dac308717004b8e70d0be592eaa8052ea/fixtures/20-transcript-error-checkpoint.jsonl.
//! These observations are not a versioned storage contract or validation of 1.3.5.
//! Tests below are independently authored synthetic data, not captured conversation prose.

use crate::adapters::{normalized_time, ParsedMessage};
use serde_json::Value;

/// One supported persisted step. The caller owns ordering and duplicate quarantine.
#[derive(Debug, Clone)]
pub struct Step {
    /// Leaves room for the catalog's one-based signed integer message index.
    pub index: u64,
    pub message: Option<ParsedMessage>,
    pub timestamp: Option<String>,
    /// Cleared content must never be reconstructed from an older cached record.
    pub cleared: bool,
    /// A timestamp is missing, or the native record explicitly reports truncation.
    pub partial: bool,
}

/// Parse a persisted JSONL row, never a hook payload or stdout `step_update` envelope.
/// Only exact user/planner pairs can contribute searchable message text. Thinking,
/// tool arguments/results, checkpoints, and other system content are never indexed.
pub fn parse_step(value: &Value) -> Result<Step, String> {
    if !value.is_object() {
        return Err("Antigravity transcript step must be an object.".into());
    }
    let index = value
        .get("step_index")
        .and_then(Value::as_u64)
        .filter(|index| *index < i64::MAX as u64)
        .ok_or("Antigravity step_index must be an integer from 0 to i64::MAX - 1.")?;
    let source = required_string(value, "source")?;
    let kind = required_string(value, "type")?;
    let status = required_string(value, "status")?;
    let cleared = match status {
        "DONE" | "RUNNING" => false,
        "CLEARED" => true,
        _ => return Err("Unsupported Antigravity transcript status.".into()),
    };

    // MODEL also labels tool results. Do not infer an assistant message from source alone.
    let role = match (source, kind) {
        ("USER_EXPLICIT", "USER_INPUT") => Some("user"),
        ("MODEL", "PLANNER_RESPONSE") => Some("assistant"),
        (
            "MODEL",
            "RUN_COMMAND" | "GREP_SEARCH" | "VIEW_FILE" | "CODE_ACTION" | "SEARCH_WEB"
            | "LIST_DIRECTORY" | "GENERIC" | "ASK_QUESTION",
        )
        | ("SYSTEM", "SYSTEM_MESSAGE" | "CHECKPOINT" | "CONVERSATION_HISTORY" | "ERROR_MESSAGE") => {
            None
        }
        _ => return Err("Unsupported Antigravity transcript source/type pair.".into()),
    };

    let timestamp = optional_string(value, "created_at")?
        .map(|time| {
            normalized_time(time)
                .ok_or_else(|| "Antigravity created_at must be an RFC3339 timestamp.".to_owned())
        })
        .transpose()?;
    let truncated = match value.get("truncated_fields") {
        None => false,
        Some(Value::Array(fields)) if fields.iter().all(Value::is_string) => !fields.is_empty(),
        Some(_) => return Err("Antigravity truncated_fields must be an array of strings.".into()),
    };
    let partial = timestamp.is_none() || truncated;
    let content = optional_string(value, "content")?;
    let message = if cleared {
        // Even a CLEARED row with stale text must not expose that text.
        None
    } else {
        match role {
            Some("user") => {
                let content = content.ok_or("Antigravity user step is missing content.")?;
                Some(message("user", user_content(content), timestamp.clone()))
            }
            Some("assistant") => content
                .filter(|text| !text.trim().is_empty())
                .map(|text| message("assistant", text, timestamp.clone())),
            _ => None,
        }
    };

    Ok(Step {
        index,
        message,
        timestamp,
        cleared,
        partial,
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Antigravity {field} must be a string."))
}

fn optional_string<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>, String> {
    value
        .get(field)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("Antigravity {field} must be a string when present."))
        })
        .transpose()
}

fn message(role: &str, text: &str, timestamp: Option<String>) -> ParsedMessage {
    ParsedMessage {
        role: role.to_owned(),
        text: text.to_owned(),
        timestamp,
        searchable: true,
        fallback: false,
    }
}

// Strip only the known outer harness. Preserve every byte of the enclosed request,
// including whitespace and literal tags. Unrecognized text is ordinary user prose.
fn user_content(content: &str) -> &str {
    let Some(after_open) = content.strip_prefix("<USER_REQUEST>") else {
        return content;
    };
    let outer = after_open.trim_end();
    for (end, _) in outer.rmatch_indices("</USER_REQUEST>") {
        let suffix = outer[end + "</USER_REQUEST>".len()..].trim_start();
        if suffix.is_empty()
            || suffix
                .strip_prefix("<ADDITIONAL_METADATA>")
                .and_then(|metadata| metadata.strip_suffix("</ADDITIONAL_METADATA>"))
                .is_some()
        {
            return &after_open[..end];
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Synthetic shape fixtures only. No live Antigravity data or executable is used.
    fn row(source: &str, kind: &str) -> Value {
        json!({
            "step_index": 12,
            "source": source,
            "type": kind,
            "status": "DONE",
            "created_at": "2026-10-01T08:00:00+08:00"
        })
    }

    #[test]
    fn user_and_planner_text_are_searchable_without_thinking_or_tool_arguments() {
        for (source, kind, role) in [
            ("USER_EXPLICIT", "USER_INPUT", "user"),
            ("MODEL", "PLANNER_RESPONSE", "assistant"),
        ] {
            let mut value = row(source, kind);
            value["content"] = json!("  Synthetic message.\n第二行。  ");
            value["thinking"] = json!({"deliberately": ["not read or interpreted"]});
            value["tool_calls"] = json!([{
                "name": "example_tool",
                "args": {"text": "excluded tool text", "count": 3, "enabled": true}
            }]);
            let parsed = parse_step(&value).unwrap();
            assert_eq!(parsed.index, 12);
            assert_eq!(
                parsed.timestamp.as_deref(),
                Some("2026-10-01T00:00:00.000Z")
            );
            assert!(!parsed.cleared);
            assert!(!parsed.partial);
            let message = parsed.message.unwrap();
            assert_eq!(message.role, role);
            assert_eq!(message.text, "  Synthetic message.\n第二行。  ");
            assert_eq!(message.timestamp, parsed.timestamp);
            assert!(message.searchable);
            assert!(!message.fallback);
        }
    }

    #[test]
    fn only_exact_leading_user_harness_is_unwrapped() {
        for (content, expected) in [
            (
                "<USER_REQUEST>  Keep spacing.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored harness</ADDITIONAL_METADATA>\n",
                "  Keep spacing.\n",
            ),
            ("<USER_REQUEST>Only request</USER_REQUEST>", "Only request"),
            (
                "<USER_REQUEST>Literal <USER_REQUEST>tag</USER_REQUEST> remains.</USER_REQUEST><ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>",
                "Literal <USER_REQUEST>tag</USER_REQUEST> remains.",
            ),
            (
                "<USER_REQUEST><ADDITIONAL_METADATA>user text</ADDITIONAL_METADATA></USER_REQUEST>",
                "<ADDITIONAL_METADATA>user text</ADDITIONAL_METADATA>",
            ),
            (
                "<USER_REQUEST>Literal </USER_REQUEST> in request.</USER_REQUEST><ADDITIONAL_METADATA>Literal </USER_REQUEST> in metadata.</ADDITIONAL_METADATA>",
                "Literal </USER_REQUEST> in request.",
            ),
            ("<USER_REQUEST></USER_REQUEST>", ""),
        ] {
            let mut value = row("USER_EXPLICIT", "USER_INPUT");
            value["content"] = json!(content);
            assert_eq!(parse_step(&value).unwrap().message.unwrap().text, expected);
        }
    }

    #[test]
    fn arbitrary_user_tags_and_incomplete_harnesses_remain_unchanged() {
        for content in [
            "Please explain <USER_REQUEST>literal tags</USER_REQUEST>.",
            " <USER_REQUEST>leading space is prose</USER_REQUEST>",
            "<user_request>different casing</user_request>",
            "<USER_REQUEST>missing close",
            "<USER_REQUEST>request</USER_REQUEST>additional user prose",
            "<USER_REQUEST>request</USER_REQUEST><ADDITIONAL_METADATA>unclosed",
            "<USER_REQUEST>request</USER_REQUEST><ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>tail",
            "<ADDITIONAL_METADATA>ordinary user text</ADDITIONAL_METADATA>",
            "",
        ] {
            let mut value = row("USER_EXPLICIT", "USER_INPUT");
            value["content"] = json!(content);
            assert_eq!(parse_step(&value).unwrap().message.unwrap().text, content);
        }
        let mut planner = row("MODEL", "PLANNER_RESPONSE");
        planner["content"] = json!("<USER_REQUEST>assistant literal</USER_REQUEST>");
        assert_eq!(
            parse_step(&planner).unwrap().message.unwrap().text,
            "<USER_REQUEST>assistant literal</USER_REQUEST>"
        );
    }

    #[test]
    fn known_tools_and_system_records_never_become_messages() {
        for (source, types) in [
            (
                "MODEL",
                &[
                    "RUN_COMMAND",
                    "GREP_SEARCH",
                    "VIEW_FILE",
                    "CODE_ACTION",
                    "SEARCH_WEB",
                    "LIST_DIRECTORY",
                    "GENERIC",
                    "ASK_QUESTION",
                ][..],
            ),
            (
                "SYSTEM",
                &[
                    "SYSTEM_MESSAGE",
                    "CHECKPOINT",
                    "CONVERSATION_HISTORY",
                    "ERROR_MESSAGE",
                ][..],
            ),
        ] {
            for kind in types {
                let mut value = row(source, kind);
                value["content"] = json!("Synthetic non-message payload.");
                value["error"] = json!("Synthetic failure payload.");
                assert!(parse_step(&value).unwrap().message.is_none());
                value.as_object_mut().unwrap().remove("content");
                assert!(parse_step(&value).unwrap().message.is_none());
            }
        }
    }

    #[test]
    fn missing_empty_and_tool_only_planner_content_is_not_invented() {
        let mut value = row("MODEL", "PLANNER_RESPONSE");
        value["thinking"] = json!("Synthetic hidden content.");
        assert!(parse_step(&value).unwrap().message.is_none());
        value["tool_calls"] = json!([{"name": "synthetic_tool", "args": {"text": "excluded"}}]);
        assert!(parse_step(&value).unwrap().message.is_none());
        for content in ["", " \t\n"] {
            value["content"] = json!(content);
            assert!(parse_step(&value).unwrap().message.is_none());
        }
        assert!(parse_step(&row("USER_EXPLICIT", "USER_INPUT")).is_err());
    }

    #[test]
    fn cleared_steps_never_expose_content_and_can_lack_timestamp() {
        for (source, kind) in [
            ("USER_EXPLICIT", "USER_INPUT"),
            ("MODEL", "PLANNER_RESPONSE"),
            ("MODEL", "GENERIC"),
        ] {
            let mut value = row(source, kind);
            value["status"] = json!("CLEARED");
            let parsed = parse_step(&value).unwrap();
            assert!(parsed.cleared);
            assert!(parsed.message.is_none());
            value["content"] = json!("Stale content must remain unavailable.");
            assert!(parse_step(&value).unwrap().message.is_none());
            value.as_object_mut().unwrap().remove("created_at");
            let parsed = parse_step(&value).unwrap();
            assert!(parsed.partial);
            assert!(parsed.timestamp.is_none());
            assert!(parsed.message.is_none());
        }
    }

    #[test]
    fn missing_timestamps_and_explicit_truncation_mark_partial() {
        let mut value = row("MODEL", "PLANNER_RESPONSE");
        value["content"] = json!("Visible fragment.");
        value["truncated_fields"] = json!([]);
        assert!(!parse_step(&value).unwrap().partial);
        for fields in [
            json!(["content"]),
            json!(["thinking"]),
            json!(["unknown_field"]),
        ] {
            value["truncated_fields"] = fields;
            let parsed = parse_step(&value).unwrap();
            assert!(parsed.partial);
            assert_eq!(parsed.message.unwrap().text, "Visible fragment.");
        }
        value.as_object_mut().unwrap().remove("truncated_fields");
        value.as_object_mut().unwrap().remove("created_at");
        let parsed = parse_step(&value).unwrap();
        assert!(parsed.partial);
        assert!(parsed.timestamp.is_none());
        assert!(parsed.message.unwrap().timestamp.is_none());
    }

    #[test]
    fn indices_are_bounded_and_preserved_independently_of_arrival_order() {
        let mut value = row("MODEL", "PLANNER_RESPONSE");
        let indices = [1196, 0, 866, i64::MAX as u64 - 1];
        let parsed: Vec<_> = indices
            .into_iter()
            .map(|index| {
                value["step_index"] = json!(index);
                parse_step(&value).unwrap().index
            })
            .collect();
        assert_eq!(parsed, indices);
        for index in [
            json!(-1),
            json!(1.5),
            json!(1.0),
            json!("1"),
            json!(null),
            json!(true),
            json!(i64::MAX),
            json!(u64::MAX),
        ] {
            value["step_index"] = index;
            assert!(parse_step(&value).is_err());
        }
    }

    #[test]
    fn unknown_source_type_status_and_mismatched_pairs_are_rejected() {
        for (source, kind) in [
            ("TOOL", "RUN_COMMAND"),
            ("UNKNOWN", "USER_INPUT"),
            ("MODEL", "UNKNOWN"),
            ("USER_EXPLICIT", "PLANNER_RESPONSE"),
            ("SYSTEM", "PLANNER_RESPONSE"),
            ("MODEL", "USER_INPUT"),
            ("MODEL", "SYSTEM_MESSAGE"),
            ("SYSTEM", "RUN_COMMAND"),
            ("", ""),
        ] {
            assert!(parse_step(&row(source, kind)).is_err());
        }
        for status in ["ERROR", "PENDING", "done", ""] {
            let mut value = row("MODEL", "PLANNER_RESPONSE");
            value["status"] = json!(status);
            assert!(parse_step(&value).is_err());
        }
        let mut running = row("MODEL", "RUN_COMMAND");
        running["status"] = json!("RUNNING");
        assert!(!parse_step(&running).unwrap().cleared);
    }

    #[test]
    fn required_and_consumed_optional_fields_reject_incorrect_types() {
        for field in ["step_index", "source", "type", "status"] {
            let mut value = row("MODEL", "PLANNER_RESPONSE");
            value.as_object_mut().unwrap().remove(field);
            assert!(parse_step(&value).is_err());
            for invalid in [json!(null), json!(false), json!([]), json!({})] {
                value[field] = invalid;
                assert!(parse_step(&value).is_err());
            }
        }
        for field in ["content", "created_at"] {
            for invalid in [json!(null), json!(false), json!(42), json!([]), json!({})] {
                let mut value = row("MODEL", "PLANNER_RESPONSE");
                value[field] = invalid;
                assert!(parse_step(&value).is_err());
            }
        }
        for invalid in [
            json!(null),
            json!("content"),
            json!(false),
            json!({}),
            json!(["content", 1]),
        ] {
            let mut value = row("MODEL", "PLANNER_RESPONSE");
            value["truncated_fields"] = invalid;
            assert!(parse_step(&value).is_err());
        }
        for invalid in [
            "",
            "yesterday",
            "2026-10-01",
            "2026-10-01T00:00:00",
            "2026-99-99T00:00:00Z",
        ] {
            let mut value = row("MODEL", "PLANNER_RESPONSE");
            value["created_at"] = json!(invalid);
            assert!(parse_step(&value).is_err());
        }
    }

    #[test]
    fn malformed_rows_and_stdout_envelopes_are_not_transcript_steps() {
        for value in [
            json!(null),
            json!([]),
            json!("text"),
            json!(42),
            json!({}),
            json!({"type": "step_update", "step": row("MODEL", "PLANNER_RESPONSE")}),
            json!({"event": "step_update", "data": row("USER_EXPLICIT", "USER_INPUT")}),
            json!({"conversationId": "synthetic-id", "transcriptPath": "/synthetic/transcript.jsonl"}),
        ] {
            assert!(parse_step(&value).is_err());
        }
    }
}
