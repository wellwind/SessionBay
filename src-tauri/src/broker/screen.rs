use super::UiEvent;
use crate::runtime::TerminalEvent;
use std::collections::VecDeque;
const REPLAY_BYTES: usize = 1024 * 1024;
const REPLAY_FRAMES: usize = 128;
const POLL_BYTES: usize = 64 * 1024;
const SCROLLBACK: usize = 200;
const MAX_ESCAPE: usize = 4096;
pub fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=320).contains(&cols) || !(1..=120).contains(&rows) {
        return Err("Persistent terminal dimensions must be 2–320 columns and 1–120 rows".into());
    }
    Ok(())
}
#[derive(Default, Clone)]
struct Modes {
    region: Option<(u16, u16)>,
    origin: bool,
    saved: Option<(u16, u16, Vec<u8>)>,
}
impl Modes {
    fn restore(&self, screen: &vt100::Screen) -> Vec<u8> {
        let mut bytes = Vec::new();
        if let Some((top, bottom)) = self.region {
            bytes.extend_from_slice(format!("\x1b[{top};{bottom}r").as_bytes());
        }
        if let Some((row, col, attrs)) = &self.saved {
            bytes.extend_from_slice(format!("\x1b[{};{}H", row + 1, col + 1).as_bytes());
            bytes.extend(attrs);
            bytes.extend(b"\x1b7");
        }
        // state_formatted deliberately recreates the right-margin pending-wrap
        // flag. A plain CUP here would clear it and overwrite the final cell on
        // the next byte. Use vt100's wrap-aware cursor restoration instead.
        if self.origin {
            bytes.extend(b"\x1b[?6h");
        }
        let cursor = screen.cursor_state_formatted();
        if self.origin {
            bytes.extend(relative_cursor(
                &cursor,
                self.region.map(|r| r.0 - 1).unwrap_or(0),
            ));
        } else {
            bytes.extend(cursor);
        }
        bytes.extend(screen.attributes_formatted());
        bytes
    }
}
// Convert the absolute CUP sequences produced by vt100 into DEC-origin
// coordinates, leaving SGR, printable characters and wrap reconstruction intact.
fn relative_cursor(bytes: &[u8], top: u16) -> Vec<u8> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"\x1b[") {
            let start = index + 2;
            let end = bytes[start..]
                .iter()
                .position(|byte| !byte.is_ascii_digit())
                .map(|offset| start + offset);
            if let Some(end) = end.filter(|end| bytes.get(*end) == Some(&b';')) {
                let column_start = end + 1;
                let column_end = bytes[column_start..]
                    .iter()
                    .position(|byte| !byte.is_ascii_digit())
                    .map(|offset| column_start + offset);
                // Only CUP (row;column H) contains coordinates. In particular,
                // SGR 38;5;196m and 38;2;r;g;bm must remain byte-for-byte intact.
                if let Some(column_end) = column_end.filter(|column_end| {
                    *column_end > column_start && bytes.get(*column_end) == Some(&b'H')
                }) {
                    if let Ok(row) = std::str::from_utf8(&bytes[start..end])
                        .unwrap_or("")
                        .parse::<u16>()
                    {
                        result
                            .extend(format!("\x1b[{}", row.saturating_sub(top).max(1)).as_bytes());
                        result.extend_from_slice(&bytes[end..=column_end]);
                        index = column_end + 1;
                        continue;
                    }
                }
            }
        }
        result.push(bytes[index]);
        index += 1;
    }
    result
}
#[derive(Default)]
struct Queries {
    replies: Vec<u8>,
    terminal_status: bool,
}
impl vt100::Callbacks for Queries {
    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if self.replies.len() >= 4096 || params.get(1) != Some(&b"?".as_slice()) {
            return;
        }
        if self.terminal_status && params.first() == Some(&b"7501".as_slice()) {
            self.replies.extend(b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\");
            return;
        }
        // A detached terminal still has a deterministic default palette. This
        // capability query cannot be delegated to a WebView that may not exist.
        let color = match params.first().copied() {
            Some(b"10") => "d9d9/e1e1/e8e8",
            Some(b"11") => "1111/1515/1a1a",
            Some(b"12") => "9b9b/d9d9/bdbd",
            _ => return,
        };
        self.replies.extend(
            format!(
                "\x1b]{};rgb:{color}\x1b\\",
                String::from_utf8_lossy(params[0])
            )
            .as_bytes(),
        );
    }
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        _: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        if self.replies.len() >= 4096 {
            return;
        }
        match (
            i1,
            params.first().and_then(|p| p.first()).copied().unwrap_or(0),
            c,
        ) {
            (None, 5, 'n') => self.replies.extend(b"\x1b[0n"),
            (None, 6, 'n') => {
                let (r, c) = screen.cursor_position();
                self.replies
                    .extend(format!("\x1b[{};{}R", r + 1, c + 1).as_bytes());
            }
            (Some(b'?'), 6, 'n') => {
                let (r, c) = screen.cursor_position();
                self.replies
                    .extend(format!("\x1b[?{};{}R", r + 1, c + 1).as_bytes());
            }
            (None, 0, 'c') => self.replies.extend(b"\x1b[?1;2c"),
            (Some(b'>'), 0, 'c') => self.replies.extend(b"\x1b[>0;1;0c"),
            _ => (),
        }
    }
}
pub struct TerminalScreen {
    parser: vt100::Parser<Queries>,
    tokenizer: Tokens,
    normal: Modes,
    alternate: Modes,
    sequence: u64,
    replay: VecDeque<(u64, Vec<u8>)>,
    replay_bytes: usize,
    truncated: bool,
    exit: Option<Option<i32>>,
    error: Option<String>,
}
impl TerminalScreen {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(rows, cols, SCROLLBACK, Queries::default()),
            tokenizer: Tokens::default(),
            normal: Modes::default(),
            alternate: Modes::default(),
            sequence: 0,
            replay: VecDeque::new(),
            replay_bytes: 0,
            truncated: false,
            exit: None,
            error: None,
        }
    }
    pub fn enable_terminal_status(&mut self) {
        self.parser.callbacks_mut().terminal_status = true;
    }
    pub fn event(&mut self, event: TerminalEvent) {
        match event {
            TerminalEvent::Output { data, .. } => {
                let mut output = Vec::with_capacity(data.len());
                for token in self.tokenizer.feed(&data) {
                    let screen = self.parser.screen();
                    let modes = if screen.alternate_screen() {
                        &mut self.alternate
                    } else {
                        &mut self.normal
                    };
                    if token == b"\x1b7" || token == b"\x1b[s" || token == b"\x1b[?1049h" {
                        let (r, c) = screen.cursor_position();
                        modes.saved = Some((r, c, screen.attributes_formatted()));
                    }
                    if token == b"\x1b[?6h" {
                        modes.origin = true;
                    } else if token == b"\x1b[?6l" {
                        modes.origin = false;
                    }
                    if token.starts_with(b"\x1b[") && token.ends_with(b"r") {
                        let value = String::from_utf8_lossy(&token[2..token.len() - 1]);
                        let values: Vec<_> = value
                            .split(';')
                            .map(|v| v.parse::<u16>().unwrap_or(0))
                            .collect();
                        let rows = screen.size().0;
                        let top = values.first().copied().unwrap_or(1).max(1);
                        let bottom = values.get(1).copied().unwrap_or(rows);
                        modes.region = (top < bottom && bottom <= rows).then_some((top, bottom));
                    }
                    self.parser.process(&token);
                    // Terminal capability/cursor queries are answered by the host
                    // even with no UI. Do not forward them and generate duplicate replies.
                    let query = (token.starts_with(b"\x1b[")
                        && matches!(token.last(), Some(b'n' | b'c')))
                        || [b"\x1b]10;?".as_slice(), b"\x1b]11;?", b"\x1b]12;?"]
                            .iter()
                            .any(|prefix| token.starts_with(prefix));
                    // Clipboard OSC never enters live output or persisted replay.
                    if !query && !token.starts_with(b"\x1b]52;") {
                        output.extend(token);
                    }
                }
                if !output.is_empty() {
                    self.sequence += 1;
                    self.replay_bytes += output.len();
                    self.replay.push_back((self.sequence, output));
                }
                while self.replay_bytes > REPLAY_BYTES || self.replay.len() > REPLAY_FRAMES {
                    if let Some((_, data)) = self.replay.pop_front() {
                        self.replay_bytes -= data.len();
                        self.truncated = true;
                    }
                }
                self.truncated |= self.tokenizer.discarded;
            }
            TerminalEvent::Exit { exit_code, .. } => self.exit = Some(exit_code),
            TerminalEvent::Error { message, .. } => self.error = Some(message),
        }
    }
    pub fn replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.parser.callbacks_mut().replies)
    }
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.screen_mut().set_size(rows, cols);
        self.normal.region = None;
        self.alternate.region = None;
    }
    fn snapshot(&self) -> Result<Vec<u8>, String> {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let mut scratch = vt100::Parser::new(rows, cols, SCROLLBACK);
        *scratch.screen_mut() = screen.clone();
        if screen.alternate_screen() {
            scratch.process(b"\x1b[?47l");
        }
        let normal = scratch.screen().clone();
        let mut data = Vec::new();
        // Rebuild only the retained, bounded scrollback. The current screen is
        // rendered afterward with cursor/attributes/input modes restored.
        let mut history = normal.clone();
        history.set_scrollback(usize::MAX);
        let depth = history.scrollback();
        for offset in (1..=depth).rev() {
            history.set_scrollback(offset);
            if let Some(line) = history.rows(0, cols).next() {
                if data.len() + line.len() > 128 * 1024 {
                    break;
                }
                data.extend(line.as_bytes());
                data.extend(b"\r\n");
            }
        }
        data.extend(normal.state_formatted());
        data.extend(self.normal.restore(&normal));
        if screen.alternate_screen() {
            data.extend(b"\x1b[?1049h");
            data.extend(screen.state_formatted());
            data.extend(self.alternate.restore(screen));
        }
        if data.len() > 3 * 1024 * 1024 {
            return Err("Terminal screen exceeds the reconnect frame limit".into());
        }
        Ok(data)
    }
    pub fn poll(&self, id: &str, after: Option<u64>) -> Result<Vec<UiEvent>, String> {
        if after.is_some_and(|seq| seq > self.sequence) {
            return Err("Invalid terminal replay cursor".into());
        }
        let oldest = self
            .replay
            .front()
            .map(|p| p.0)
            .unwrap_or(self.sequence + 1);
        let snapshot = after.is_none_or(|seq| seq + 1 < oldest);
        let mut events = Vec::new();
        let mut last = after.unwrap_or(0);
        if snapshot {
            let (rows, cols) = self.parser.screen().size();
            events.push(UiEvent::Snapshot {
                runtime_id: id.into(),
                sequence: self.sequence,
                data: self.snapshot()?,
                cols,
                rows,
                truncated: self.truncated,
            });
            last = self.sequence;
        } else {
            let mut bytes = 0;
            for (sequence, data) in &self.replay {
                if *sequence > last {
                    if bytes > 0 && bytes + data.len() > POLL_BYTES {
                        break;
                    }
                    bytes += data.len();
                    last = *sequence;
                    events.push(UiEvent::Output {
                        runtime_id: id.into(),
                        sequence: *sequence,
                        data: data.clone(),
                    });
                }
            }
        }
        if last == self.sequence {
            if let Some(message) = &self.error {
                events.push(UiEvent::Error {
                    runtime_id: id.into(),
                    message: message.clone(),
                });
            }
            if let Some(exit_code) = self.exit {
                events.push(UiEvent::Exit {
                    runtime_id: id.into(),
                    exit_code,
                });
            }
        }
        Ok(events)
    }
}

/// Never hand an incomplete UTF-8 or escape sequence to the emulator. Snapshot
/// cursors therefore cannot split a sequence and corrupt the resumed renderer.
/// Long OSC/DCS strings are discarded without ever allocating them in vt100.
#[derive(Default)]
struct Tokens {
    pending: Vec<u8>,
    state: u8,
    remaining: u8,
    escaped: bool,
    discarded: bool,
    overflow: bool,
}
impl Tokens {
    fn feed(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        let mut tokens = Vec::new();
        for &byte in data {
            if self.pending.len() < MAX_ESCAPE {
                self.pending.push(byte);
            } else {
                self.overflow = true;
                self.discarded = true;
            }
            let done = match self.state {
                0 => match byte {
                    0x1b => {
                        self.state = 1;
                        false
                    }
                    0xc2..=0xdf => {
                        self.state = 5;
                        self.remaining = 1;
                        false
                    }
                    0xe0..=0xef => {
                        self.state = 5;
                        self.remaining = 2;
                        false
                    }
                    0xf0..=0xf4 => {
                        self.state = 5;
                        self.remaining = 3;
                        false
                    }
                    _ => true,
                },
                1 => match byte {
                    b'[' => {
                        self.state = 2;
                        false
                    }
                    b']' | b'P' | b'^' | b'_' => {
                        self.state = 3;
                        false
                    }
                    0x20..=0x2f => {
                        self.state = 4;
                        false
                    }
                    _ => true,
                },
                2 => (0x40..=0x7e).contains(&byte) || matches!(byte, 0x18 | 0x1a),
                3 => {
                    let end =
                        byte == 7 || (self.escaped && byte == b'\\') || matches!(byte, 0x18 | 0x1a);
                    self.escaped = byte == 0x1b;
                    end
                }
                4 => (0x30..=0x7e).contains(&byte),
                5 => {
                    self.remaining = self.remaining.saturating_sub(1);
                    self.remaining == 0
                }
                _ => true,
            };
            if done {
                if !self.overflow {
                    tokens.push(std::mem::take(&mut self.pending));
                } else {
                    self.pending.clear();
                }
                self.state = 0;
                self.escaped = false;
                self.overflow = false;
            }
        }
        tokens
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn output(screen: &mut TerminalScreen, bytes: &[u8]) {
        screen.event(TerminalEvent::Output {
            runtime_id: "r".into(),
            sequence: 1,
            data: bytes.into(),
        });
    }
    fn render(screen: &TerminalScreen) -> vt100::Parser {
        let mut parser = vt100::Parser::new(24, 80, SCROLLBACK);
        parser.process(&screen.snapshot().unwrap());
        parser
    }
    #[test]
    fn reconnect_restores_unicode_cursor_colors_modes_and_alternate_screen() {
        let mut screen = TerminalScreen::new(80, 24);
        output(
            &mut screen,
            b"normal\r\n\x1b[?1049h\x1b[31magent\x1b[3;8H\x1b[?2004h",
        );
        output(&mut screen, "中文".as_bytes());
        let restored = render(&screen);
        assert_eq!(
            restored.screen().contents(),
            screen.parser.screen().contents()
        );
        assert_eq!(
            restored.screen().cursor_position(),
            screen.parser.screen().cursor_position()
        );
        assert!(restored.screen().alternate_screen());
        assert!(restored.screen().bracketed_paste());
    }
    #[test]
    fn snapshot_does_not_split_utf8_or_escape_sequences() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, &[0xe4, 0xb8]);
        assert_eq!(screen.sequence, 0);
        let mut restored = render(&screen);
        output(&mut screen, &[0xad]);
        let events = screen.poll("r", Some(0)).unwrap();
        for event in events {
            if let UiEvent::Output { data, .. } = event {
                restored.process(&data);
            }
        }
        assert_eq!(restored.screen().contents(), "中");
        output(&mut screen, b"\x1b[31");
        assert_eq!(screen.sequence, 1);
        output(&mut screen, b"mred");
        assert_eq!(render(&screen).screen().contents(), "中red");
    }
    #[test]
    fn replay_and_osc_memory_are_bounded() {
        let mut screen = TerminalScreen::new(80, 24);
        for _ in 0..300 {
            output(&mut screen, &vec![b'x'; 16384]);
        }
        assert!(screen.replay_bytes <= REPLAY_BYTES);
        assert!(screen.replay.len() <= REPLAY_FRAMES);
        assert!(matches!(
            screen.poll("r", Some(0)).unwrap()[0],
            UiEvent::Snapshot {
                truncated: true,
                ..
            }
        ));
        output(&mut screen, b"\x1b]52;c;");
        for _ in 0..100 {
            output(&mut screen, &vec![b'a'; 16384]);
        }
        assert!(screen.tokenizer.pending.len() <= MAX_ESCAPE);
        output(&mut screen, b"\x07safe");
        assert!(screen.parser.screen().contents().ends_with("safe"));
    }
    #[test]
    fn queries_are_answered_without_any_ui() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"abc\x1b[6n\x1b[c");
        assert_eq!(screen.replies(), b"\x1b[1;4R\x1b[?1;2c");
        assert_eq!(screen.replay.back().unwrap().1, b"abc");
    }
    #[test]
    fn reconnect_preserves_pending_wrap_at_ascii_and_wide_character_margin() {
        for ending in ["aa", "中"] {
            let mut screen = TerminalScreen::new(80, 24);
            output(
                &mut screen,
                format!("{}{}", "a".repeat(78), ending).as_bytes(),
            );
            let mut restored = render(&screen);
            output(&mut screen, b"B");
            restored.process(b"B");
            assert_eq!(
                restored.screen().contents(),
                screen.parser.screen().contents()
            );
            assert_eq!(
                restored.screen().cursor_position(),
                screen.parser.screen().cursor_position()
            );
        }
    }
    #[test]
    fn reconnect_retains_scroll_region_origin_and_pending_wrap() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"\x1b[3;20r\x1b[?6h");
        output(&mut screen, &[b'x'; 80]);
        let mut restored = render(&screen);
        output(&mut screen, b"B");
        restored.process(b"B");
        assert_eq!(
            restored.screen().contents(),
            screen.parser.screen().contents()
        );
        assert_eq!(
            restored.screen().cursor_position(),
            screen.parser.screen().cursor_position()
        );
    }
    #[test]
    fn colored_origin_pending_wrap_preserves_sgr_and_cell_attributes() {
        for attributes in [
            b"\x1b[38;5;196;48;5;25m".as_slice(),
            b"\x1b[38;2;1;2;3;48;2;4;5;6m",
        ] {
            let mut screen = TerminalScreen::new(80, 24);
            output(&mut screen, b"\x1b[3;20r\x1b[?6h");
            output(&mut screen, attributes);
            output(&mut screen, &[b'a'; 80]);
            let mut restored = render(&screen);
            for (row, column) in [(2, 0), (2, 79)] {
                assert_eq!(
                    restored.screen().cell(row, column),
                    screen.parser.screen().cell(row, column)
                );
            }
            output(&mut screen, b"B");
            restored.process(b"B");
            assert_eq!(
                restored.screen().cell(3, 0),
                screen.parser.screen().cell(3, 0)
            );
        }
    }
    #[test]
    fn color_queries_are_consumed_and_answered_without_ui() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"\x1b]11;?\x07");
        assert_eq!(screen.replies(), b"\x1b]11;rgb:1111/1515/1a1a\x1b\\");
        assert_eq!(screen.sequence, 0);
        assert!(screen.replay.is_empty());
    }
    #[test]
    fn program_status_negotiation_is_opt_in_and_precedes_device_attributes() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"\x1b]7501;?\x07");
        assert!(screen.replies().is_empty());
        screen.enable_terminal_status();
        output(&mut screen, b"\x1b]7501;?\x07\x1b[c");
        assert_eq!(screen.replies(), b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\\x1b[?1;2c");
    }
}
