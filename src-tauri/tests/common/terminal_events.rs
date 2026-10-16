//! Stateful test consumer shared by readiness and completion checks. Keeping the
//! cursor with the stream catches a missing/duplicate frame at the phase boundary.
use sessionbay_lib::runtime::TerminalEvent;
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub struct TerminalEvents<'a, F> {
    receiver: &'a mpsc::Receiver<TerminalEvent>,
    acknowledge: F,
    previous: u64,
    output: Vec<u8>,
}

impl<'a, F: FnMut(&str, u64)> TerminalEvents<'a, F> {
    pub fn new(receiver: &'a mpsc::Receiver<TerminalEvent>, acknowledge: F) -> Self {
        Self {
            receiver,
            acknowledge,
            previous: 0,
            output: Vec::new(),
        }
    }

    fn receive(&mut self, deadline: Instant) -> TerminalEvent {
        let event = self
            .receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("terminal event timeout");
        if let TerminalEvent::Output {
            runtime_id,
            sequence,
            data,
        } = &event
        {
            assert_eq!(
                *sequence,
                self.previous + 1,
                "terminal output must remain consecutive across readiness and completion"
            );
            self.previous = *sequence;
            self.output.extend_from_slice(data);
            (self.acknowledge)(runtime_id, *sequence);
        }
        event
    }

    pub fn until_text(&mut self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match self.receive(deadline) {
                TerminalEvent::Output { .. } => {
                    let text = String::from_utf8_lossy(&self.output);
                    if text.contains(needle) {
                        return text.into_owned();
                    }
                }
                event => panic!("unexpected readiness event: {event:?}"),
            }
        }
    }

    pub fn collect(&mut self) -> (String, Option<i32>) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match self.receive(deadline) {
                TerminalEvent::Output { .. } => (),
                TerminalEvent::Exit { exit_code, .. } => {
                    return (String::from_utf8(self.output.clone()).unwrap(), exit_code);
                }
                TerminalEvent::Error { message, .. } => panic!("terminal error: {message}"),
            }
        }
    }
}
