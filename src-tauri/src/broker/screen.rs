use super::UiEvent;
use crate::runtime::TerminalEvent;
use ghostty_vt::Terminal;
use std::collections::VecDeque;
// Replay is only the incremental catch-up buffer. Reconnect repaints the
// libghostty-vt screen, so visible history follows SCROLLBACK. The snapshot
// includes at most SNAPSHOT_SCROLLBACK_BYTES of the newest scrollback; the live
// screen with its modes, cursor and pen follows it. The frame stays under
// MAX_SNAPSHOT_BYTES because it is JSON-encoded as an array of bytes.
const REPLAY_BYTES: usize = 4 * 1024 * 1024;
const REPLAY_FRAMES: usize = 4096;
const POLL_BYTES: usize = 64 * 1024;
// Lines a reconnect restores; matches the renderer's scrollback.
const SCROLLBACK: usize = 10_000;
// libghostty-vt caps retained history by memory, not lines.
const SCROLLBACK_MEMORY: usize = 16 * 1024 * 1024;
const SNAPSHOT_SCROLLBACK_BYTES: usize = 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 3 * 1024 * 1024;
const MAX_ESCAPE: usize = 4096;
const PROGRAM_STATUS_CAPABILITIES: &[u8] =
    b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";
// A detached terminal answers color queries with SessionBay's default palette.
const DEFAULT_FOREGROUND: [u8; 3] = [0xd9, 0xe1, 0xe8];
const DEFAULT_BACKGROUND: [u8; 3] = [0x11, 0x15, 0x1a];
const DEFAULT_CURSOR: [u8; 3] = [0x9b, 0xd9, 0xbd];
pub fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=320).contains(&cols) || !(1..=120).contains(&rows) {
        return Err("Persistent terminal dimensions must be 2–320 columns and 1–120 rows".into());
    }
    Ok(())
}
/// Queries the broker answers even with no UI. They are never forwarded, so a
/// renderer that later attaches cannot answer them a second time.
fn is_query(token: &[u8]) -> bool {
    (token.starts_with(b"\x1b[") && matches!(token.last(), Some(b'n' | b'c')))
        || [b"\x1b]10;?".as_slice(), b"\x1b]11;?", b"\x1b]12;?"]
            .iter()
            .any(|prefix| token.starts_with(prefix))
}
fn is_program_status_query(token: &[u8]) -> bool {
    token.starts_with(b"\x1b]7501;?") && matches!(token.len(), 9 | 10)
}
pub struct TerminalScreen {
    terminal: Terminal,
    tokenizer: Tokens,
    replies: Vec<u8>,
    terminal_status: bool,
    sequence: u64,
    replay: VecDeque<(u64, Vec<u8>)>,
    replay_bytes: usize,
    truncated: bool,
    // Lines currently retained above the primary screen. History that shrinks
    // without an explicit clear means the memory cap dropped old lines.
    history: u32,
    exit: Option<Option<i32>>,
    error: Option<String>,
}
impl TerminalScreen {
    pub fn new(cols: u16, rows: u16) -> Self {
        let mut terminal = Terminal::new(cols, rows, SCROLLBACK_MEMORY);
        terminal.set_display(
            Some(DEFAULT_FOREGROUND),
            Some(DEFAULT_BACKGROUND),
            Some(DEFAULT_CURSOR),
            None,
        );
        Self {
            terminal,
            tokenizer: Tokens::default(),
            replies: Vec::new(),
            terminal_status: false,
            sequence: 0,
            replay: VecDeque::new(),
            replay_bytes: 0,
            truncated: false,
            history: 0,
            exit: None,
            error: None,
        }
    }
    pub fn enable_terminal_status(&mut self) {
        self.terminal_status = true;
    }
    pub fn event(&mut self, event: TerminalEvent) {
        match event {
            TerminalEvent::Output { data, .. } => {
                let mut output = Vec::with_capacity(data.len());
                let mut cleared = false;
                for token in self.tokenizer.feed(&data) {
                    let query = is_query(&token);
                    // libghostty-vt answers many more queries than the broker
                    // forwards. Keep only replies to queries the UI never sees.
                    let keep = self.terminal.pending_responses();
                    self.terminal.write(&token);
                    if !query {
                        self.terminal.drop_responses_after(keep);
                    }
                    if self.replies.len() < 4096 {
                        if self.terminal_status && is_program_status_query(&token) {
                            self.replies.extend(PROGRAM_STATUS_CAPABILITIES);
                        }
                        self.replies.extend(self.terminal.take_responses());
                    } else {
                        self.terminal.take_responses();
                    }
                    cleared |= token == b"\x1b[3J";
                    // Clipboard OSC never enters live output or persisted replay.
                    if !query && !token.starts_with(b"\x1b]52;") {
                        output.extend(token);
                    }
                }
                if !output.is_empty() {
                    self.note_history(cleared);
                    self.sequence += 1;
                    self.replay_bytes += output.len();
                    self.replay.push_back((self.sequence, output));
                }
                while self.replay_bytes > REPLAY_BYTES || self.replay.len() > REPLAY_FRAMES {
                    if let Some((_, data)) = self.replay.pop_front() {
                        self.replay_bytes -= data.len();
                    }
                }
                self.truncated |= self.tokenizer.discarded;
            }
            TerminalEvent::Exit { exit_code, .. } => self.exit = Some(exit_code),
            TerminalEvent::Error { message, .. } => self.error = Some(message),
        }
    }
    pub fn replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.replies)
    }
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.terminal.resize(cols, rows);
        if !self.terminal.alt_screen() {
            self.history = self.terminal.history_rows();
        }
    }
    fn note_history(&mut self, cleared: bool) {
        if self.terminal.alt_screen() {
            return;
        }
        let history = self.terminal.history_rows();
        if history < self.history && !cleared {
            self.truncated = true;
        }
        self.history = history;
    }
    fn snapshot(&self) -> Result<(Vec<u8>, bool), String> {
        let available = self.terminal.history_rows() as usize;
        let base = self.terminal.paint(0).len();
        // Halve the history until the scrollback part fits its budget, keeping
        // the lines closest to the current screen.
        let mut history = available.min(SCROLLBACK);
        let mut data = self.terminal.paint(history);
        while history > 0 && data.len().saturating_sub(base) > SNAPSHOT_SCROLLBACK_BYTES {
            history /= 2;
            data = self.terminal.paint(history);
        }
        if data.len() > MAX_SNAPSHOT_BYTES {
            return Err("Terminal screen exceeds the reconnect frame limit".into());
        }
        Ok((data, history < available))
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
            let (cols, rows) = self.terminal.size();
            let (data, omitted) = self.snapshot()?;
            events.push(UiEvent::Snapshot {
                runtime_id: id.into(),
                sequence: self.sequence,
                data,
                cols,
                rows,
                truncated: self.truncated || omitted,
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
/// Long OSC/DCS strings are discarded without ever reaching the emulator.
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
    /// A fresh viewer that only ever sees the reconnect snapshot.
    fn render(screen: &TerminalScreen) -> Terminal {
        let (cols, rows) = screen.terminal.size();
        let mut viewer = Terminal::new(cols, rows, SCROLLBACK_MEMORY);
        viewer.write(&screen.snapshot().unwrap().0);
        viewer
    }
    /// Same screen and same cursor: one more byte lands in the same cell.
    fn assert_continues_identically(screen: &mut TerminalScreen, viewer: &mut Terminal) {
        assert_eq!(viewer.screen_rows(), screen.terminal.screen_rows());
        output(screen, b"B");
        viewer.write(b"B");
        assert_eq!(viewer.screen_rows(), screen.terminal.screen_rows());
    }
    #[test]
    fn reconnect_restores_unicode_cursor_colors_modes_and_alternate_screen() {
        let mut screen = TerminalScreen::new(80, 24);
        output(
            &mut screen,
            b"normal\r\n\x1b[?1049h\x1b[31magent\x1b[3;8H\x1b[?2004h",
        );
        output(&mut screen, "中文".as_bytes());
        let mut restored = render(&screen);
        assert!(restored.alt_screen());
        assert!(restored.dec_mode(2004));
        assert_continues_identically(&mut screen, &mut restored);
        // The hidden primary screen comes back when the program leaves.
        output(&mut screen, b"\x1b[?1049l");
        restored.write(b"\x1b[?1049l");
        assert_eq!(restored.screen_rows()[0].trim_end(), "normal");
        assert_eq!(restored.screen_rows(), screen.terminal.screen_rows());
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
                restored.write(&data);
            }
        }
        assert_eq!(restored.screen_rows()[0].trim_end(), "中");
        output(&mut screen, b"\x1b[31");
        assert_eq!(screen.sequence, 1);
        output(&mut screen, b"mred");
        assert_eq!(render(&screen).screen_rows()[0].trim_end(), "中red");
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
        assert!(screen.terminal.plain_text().ends_with("safe"));
    }
    #[test]
    fn snapshot_keeps_thousands_of_scrollback_lines() {
        let mut screen = TerminalScreen::new(80, 24);
        for i in 0..2_500 {
            output(&mut screen, format!("line-{i}\r\n").as_bytes());
        }
        let (data, omitted) = screen.snapshot().unwrap();
        assert!(!omitted);
        let text = String::from_utf8(data).unwrap();
        assert!(text.contains("line-0\r\n"));
        assert!(text.contains("line-2499"));
        assert!(matches!(
            screen.poll("r", None).unwrap()[0],
            UiEvent::Snapshot {
                truncated: false,
                ..
            }
        ));
    }
    #[test]
    fn scrollback_beyond_the_cap_keeps_the_newest_lines() {
        let mut screen = TerminalScreen::new(80, 24);
        let total = SCROLLBACK + 40;
        for i in 0..total {
            output(&mut screen, format!("L{i:05}\r\n").as_bytes());
        }
        let (data, omitted) = screen.snapshot().unwrap();
        assert!(omitted);
        let text = String::from_utf8_lossy(&data);
        assert!(!text.contains("L00000\r\n"));
        assert!(text.contains(&format!("L{:05}\r\n", total - 100)));
        assert!(text.contains(&format!("L{:05}", total - 1)));
        assert!(matches!(
            screen.poll("r", None).unwrap()[0],
            UiEvent::Snapshot {
                truncated: true,
                ..
            }
        ));
    }
    #[test]
    fn history_dropped_by_the_memory_cap_marks_the_screen_truncated() {
        let mut screen = TerminalScreen::new(320, 24);
        let body = "M".repeat(300);
        let mut i = 0;
        while !screen.truncated && i < 200_000 {
            output(&mut screen, format!("{body}{i:06}\r\n").as_bytes());
            i += 1;
        }
        assert!(screen.truncated, "history never reached the memory cap");
        // An explicit clear is not lost history.
        let mut cleared = TerminalScreen::new(80, 24);
        for i in 0..100 {
            output(&mut cleared, format!("line-{i}\r\n").as_bytes());
        }
        output(&mut cleared, b"\x1b[H\x1b[2J\x1b[3J");
        assert!(!cleared.truncated);
    }
    #[test]
    fn snapshot_scrollback_budget_keeps_the_newest_lines() {
        let mut screen = TerminalScreen::new(320, 24);
        let body = "W".repeat(300);
        let count = 4_000;
        for i in 0..count {
            output(&mut screen, format!("{body}{i:04}\r\n").as_bytes());
        }
        let (data, omitted) = screen.snapshot().unwrap();
        assert!(omitted);
        assert!(data.len() <= MAX_SNAPSHOT_BYTES);
        let text = String::from_utf8(data).unwrap();
        assert!(!text.contains(&format!("{body}0000")));
        let newest = format!("{body}{:04}", count - 1);
        let newest_at = text.find(&newest).expect("newest line");
        let older = format!("{body}{:04}", count - 400);
        let older_at = text.find(&older).expect("recent line");
        assert!(older_at < newest_at);
        assert!(matches!(
            screen.poll("r", None).unwrap()[0],
            UiEvent::Snapshot {
                truncated: true,
                ..
            }
        ));
    }
    #[test]
    fn dropping_replay_frames_keeps_a_screen_that_still_fits() {
        let mut screen = TerminalScreen::new(80, 24);
        for _ in 0..=REPLAY_FRAMES {
            output(&mut screen, b"x");
        }
        assert!(screen.replay.len() <= REPLAY_FRAMES);
        assert!(!screen.truncated);
        assert!(matches!(
            screen.poll("r", None).unwrap()[0],
            UiEvent::Snapshot {
                truncated: false,
                ..
            }
        ));
    }
    #[test]
    fn queries_are_answered_without_any_ui() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"abc\x1b[6n\x1b[c");
        // Ghostty's own device attributes: VT220-class with ANSI color.
        assert_eq!(screen.replies(), b"\x1b[1;4R\x1b[?62;22c");
        assert_eq!(screen.replay.back().unwrap().1, b"abc");
    }
    #[test]
    fn queries_the_ui_still_sees_are_not_answered_twice() {
        let mut screen = TerminalScreen::new(80, 24);
        // XTVERSION and a DEC mode request reach the renderer, which answers them.
        output(&mut screen, b"\x1b[>0q\x1b[?2004$p");
        assert!(screen.replies().is_empty());
        assert_eq!(screen.replay.back().unwrap().1, b"\x1b[>0q\x1b[?2004$p");
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
            assert_continues_identically(&mut screen, &mut restored);
        }
    }
    #[test]
    fn reconnect_retains_scroll_region_origin_and_pending_wrap() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"\x1b[3;20r\x1b[?6h");
        output(&mut screen, &[b'x'; 80]);
        let mut restored = render(&screen);
        assert!(restored.dec_mode(6));
        assert_continues_identically(&mut screen, &mut restored);
        // The scroll region survives: a newline at its bottom scrolls only it.
        for _ in 0..20 {
            output(&mut screen, b"\r\nR");
            restored.write(b"\r\nR");
        }
        assert_eq!(restored.screen_rows(), screen.terminal.screen_rows());
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
            output(&mut screen, b"B");
            restored.write(b"B");
            assert_eq!(restored.replay(), screen.terminal.replay());
        }
    }
    #[test]
    fn color_queries_are_consumed_and_answered_without_ui() {
        let mut screen = TerminalScreen::new(80, 24);
        output(&mut screen, b"\x1b]11;?\x07");
        // The reply ends with the query's own terminator, as xterm does.
        assert_eq!(screen.replies(), b"\x1b]11;rgb:1111/1515/1a1a\x07");
        output(&mut screen, b"\x1b]11;?\x1b\\");
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
        assert_eq!(screen.replies(), b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\\x1b[?62;22c");
    }
}
