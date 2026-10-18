//! Bounded OSC 7501 status decoder. Bytes are terminal-reported, never
//! authenticated provider identity. No free text, app names or ids leave here.
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};

const MAX_SEQUENCE: usize = 4096;
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Idle,
    Working,
    Done,
    Blocked,
    Permission,
    Question,
    Authentication,
    Error,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Set { id: String, status: Status },
    Clear { id: String },
    Query,
    Prompt,
}
#[derive(Default)]
pub struct Decoder {
    mode: u8,
    bytes: Vec<u8>,
    length: usize,
}
impl Decoder {
    /// Incremental, bounded framing. DCS/APC/PM/SOS strings are opaque so a quoted
    /// OSC inside them cannot masquerade as a top-level terminal report.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Change> {
        let mut changes = Vec::new();
        for &byte in bytes {
            match self.mode {
                0 => {
                    if byte == 27 {
                        self.mode = 1;
                    }
                }
                1 => match byte {
                    b']' => {
                        self.mode = 2;
                        self.bytes.clear();
                        self.length = 2;
                    }
                    b'P' | b'_' | b'^' | b'X' => self.mode = 4,
                    b'c' => {
                        changes.push(Change::Clear { id: String::new() });
                        self.mode = 0;
                    }
                    27 => (),
                    _ => self.mode = 0,
                },
                2 => {
                    self.length = self.length.saturating_add(1);
                    if byte == 7 {
                        self.finish(&mut changes);
                    } else if byte == 27 {
                        self.mode = 3;
                    } else if byte == 24 || byte == 26 {
                        self.mode = 0;
                        self.bytes.clear();
                    } else if self.length <= MAX_SEQUENCE {
                        self.bytes.push(byte);
                    }
                }
                3 => {
                    self.length = self.length.saturating_add(1);
                    if byte == b'\\' {
                        self.finish(&mut changes);
                    } else {
                        self.bytes.clear();
                        self.mode = match byte {
                            b'c' => {
                                changes.push(Change::Clear { id: String::new() });
                                0
                            }
                            b']' => {
                                self.length = 2;
                                2
                            }
                            27 => 1,
                            _ => 0,
                        };
                    }
                }
                4 => {
                    if byte == 27 {
                        self.mode = 5;
                    } else if byte == 24 || byte == 26 {
                        self.mode = 0;
                    }
                }
                5 => {
                    self.mode = match byte {
                        b'c' => {
                            changes.push(Change::Clear { id: String::new() });
                            0
                        }
                        b'\\' | 24 | 26 => 0,
                        27 => 5,
                        _ => 4,
                    }
                }
                _ => unreachable!(),
            }
        }
        changes
    }
    fn finish(&mut self, changes: &mut Vec<Change>) {
        if self.length <= MAX_SEQUENCE {
            if let Some(change) = parse(&self.bytes) {
                changes.push(change);
            }
        }
        self.mode = 0;
        self.bytes.clear();
    }
}
fn free_text(value: &str, encoded: usize, decoded: usize) -> bool {
    if value.len() > encoded {
        return false;
    }
    let Ok(bytes) = STANDARD
        .decode(value)
        .or_else(|_| STANDARD_NO_PAD.decode(value))
    else {
        return false;
    };
    bytes.len() <= decoded
        && std::str::from_utf8(&bytes).is_ok_and(|text| !text.chars().any(char::is_control))
}
fn parse(bytes: &[u8]) -> Option<Change> {
    if bytes == b"133;A" || bytes.starts_with(b"133;A;") {
        return Some(Change::Prompt);
    }
    let body = std::str::from_utf8(bytes.strip_prefix(b"7501;")?).ok()?;
    if body == "?" {
        return Some(Change::Query);
    }
    let (mut state, mut kind, mut id) = (None, None, None);
    for pair in body.split(':') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key.len() > 16 {
            return None;
        }
        if key == "id"
            && !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.+-/".contains(&b))
        {
            return None;
        }
        if key.is_empty()
            || !key.bytes().all(|b| b.is_ascii_lowercase())
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.,+/=-".contains(&b))
        {
            continue;
        }
        match key {
            "state" => state = Some(value),
            "kind" => kind = Some(value),
            "id" => {
                if value.len() > 128 {
                    return None;
                }
                let parts: Vec<_> = value.split('/').collect();
                if parts.len() > 8
                    || parts.iter().any(|s| {
                        s.is_empty()
                            || s.len() > 32
                            || !s
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
                    })
                {
                    return None;
                }
                id = Some(value);
            }
            "app" if value.len() > 32 => return None,
            "msg" if !free_text(value, 2732, 2048) => return None,
            "title" if !free_text(value, 256, 192) => return None,
            _ => (),
        }
    }
    let id = id.unwrap_or_default().to_owned();
    if state == Some("clear") {
        return Some(Change::Clear { id });
    }
    let status = match state? {
        "idle" => Status::Idle,
        "working" => Status::Working,
        "done" => Status::Done,
        "error" => Status::Error,
        "blocked" => match kind {
            Some("permission") => Status::Permission,
            Some("question") => Status::Question,
            Some("auth") => Status::Authentication,
            _ => Status::Blocked,
        },
        _ => return None,
    };
    Some(Change::Set { id, status })
}
/// Terminal records are event-maintained, never inferred from output cadence.
/// Named records are retained for protocol clearing. Only an explicit root or a
/// single top-level record is presented; multiple roots are ambiguous.
#[derive(Default)]
pub struct Records {
    entries: std::collections::HashMap<String, (Status, u64)>,
    revision: u64,
}
impl Records {
    pub fn apply(&mut self, change: Change) {
        match change {
            Change::Set { id, status } => {
                self.revision = self.revision.saturating_add(1);
                if !self.entries.contains_key(&id) && self.entries.len() >= 64 {
                    if let Some(oldest) = self
                        .entries
                        .iter()
                        .min_by_key(|(_, (_, at))| at)
                        .map(|(id, _)| id.clone())
                    {
                        self.entries.remove(&oldest);
                    }
                }
                self.entries.insert(id, (status, self.revision));
            }
            Change::Clear { id } => {
                self.entries.retain(|key, _| {
                    !id.is_empty()
                        && key != &id
                        && !key
                            .strip_prefix(&id)
                            .is_some_and(|tail| tail.starts_with('/'))
                });
            }
            Change::Prompt => self.process_exit(),
            Change::Query => (),
        }
    }
    pub fn process_exit(&mut self) {
        self.entries
            .retain(|_, (status, _)| matches!(status, Status::Done | Status::Error));
    }
    pub fn status(&self) -> Option<Status> {
        if let Some((status, _)) = self.entries.get("") {
            return Some(*status);
        }
        let mut roots = self.entries.iter().filter(|(id, _)| !id.contains('/'));
        let (_, (status, _)) = roots.next()?;
        roots.next().is_none().then_some(*status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(status: Status) -> Change {
        Change::Set {
            id: String::new(),
            status,
        }
    }
    #[test]
    fn every_chunk_boundary_and_both_terminators() {
        for end in ["\x07", "\x1b\\"] {
            let frame = format!("noise\x1b]7501;state=blocked:kind=permission{end}tail");
            for split in 0..=frame.len() {
                let mut d = Decoder::default();
                let mut got = d.feed(&frame.as_bytes()[..split]);
                got.extend(d.feed(&frame.as_bytes()[split..]));
                assert_eq!(got, [root(Status::Permission)]);
            }
        }
    }
    #[test]
    fn ids_are_preserved_and_never_fall_back_to_root() {
        assert_eq!(
            parse(b"7501;state=working:id=agent/child"),
            Some(Change::Set {
                id: "agent/child".into(),
                status: Status::Working
            })
        );
        for body in [
            "state=working:id=",
            "state=working:id=bad!",
            "state=working:id=bad id",
            "state=working:id=中文",
            "state=working:id=/child",
            "state=working:id=a//b",
            "state=future",
            "state=working:msg=Cg==",
            "state=working:msg=/w==",
        ] {
            assert_eq!(parse(format!("7501;{body}").as_bytes()), None, "{body}");
        }
        assert_eq!(
            parse(b"7501;state=working:msg=T0s="),
            Some(root(Status::Working))
        );
        assert_eq!(
            parse(b"7501;state=working:future=ok:state=done"),
            Some(root(Status::Done))
        );
    }
    #[test]
    fn oversized_and_nested_strings_cannot_emit_status() {
        let mut d = Decoder::default();
        assert!(d
            .feed(format!("\x1b]7501;state=done:msg={}\x07", "A".repeat(5000)).as_bytes())
            .is_empty());
        assert!(d.bytes.len() <= MAX_SEQUENCE);
        assert!(d
            .feed(b"\x1bPquoted \x1b]7501;state=done\x07\x1b\\")
            .is_empty());
        assert_eq!(
            d.feed(b"\x1b]7501;state=working\x07"),
            [root(Status::Working)]
        );
    }
    #[test]
    fn full_reset_prompt_and_query_have_explicit_meanings() {
        assert_eq!(
            Decoder::default().feed(b"\x1b]7501;?\x1b\\\x1bc\x1b]133;A\x07"),
            [
                Change::Query,
                Change::Clear { id: String::new() },
                Change::Prompt
            ]
        );
        assert!(Decoder::default().feed(b"\x1b[!p").is_empty());
    }
    #[test]
    fn records_keep_root_identity_clear_subtrees_and_survive_exit_only_when_settled() {
        let mut records = Records::default();
        records.apply(Change::Set {
            id: "worker/child".into(),
            status: Status::Working,
        });
        assert_eq!(records.status(), None);
        records.apply(Change::Set {
            id: "worker".into(),
            status: Status::Done,
        });
        assert_eq!(records.status(), Some(Status::Done));
        records.apply(Change::Set {
            id: "other".into(),
            status: Status::Working,
        });
        assert_eq!(records.status(), None);
        records.apply(root(Status::Permission));
        assert_eq!(records.status(), Some(Status::Permission));
        records.process_exit();
        assert_eq!(records.status(), Some(Status::Done));
        records.apply(Change::Clear {
            id: "worker".into(),
        });
        assert_eq!(records.status(), None);
    }
    #[test]
    fn record_count_is_bounded() {
        let mut records = Records::default();
        for n in 0..100 {
            records.apply(Change::Set {
                id: format!("id{n}"),
                status: Status::Working,
            });
        }
        assert_eq!(records.entries.len(), 64);
        records.apply(Change::Clear { id: String::new() });
        assert!(records.entries.is_empty());
    }

    #[test]
    fn reset_and_cancellation_recover_from_partial_control_strings() {
        for bytes in [b"\x1b]0;incomplete\x1bc".as_slice(), b"\x1bPqquoted\x1bc"] {
            assert_eq!(
                Decoder::default().feed(bytes),
                [Change::Clear { id: String::new() }]
            );
        }
        assert_eq!(
            Decoder::default().feed(b"\x1bPquoted\x1b\x18\x1b]7501;state=working\x07"),
            [root(Status::Working)]
        );
    }
}
