//! Consume only ConPTY's first inherited-cursor DSR, which the backend answers.
//! Keeping it out of xterm prevents a second reply from becoming shell input.
const QUERY: &[u8] = b"\x1b[6n";

#[derive(Default)]
pub(super) struct InitialCursorQuery {
    matched: usize,
    answered: bool,
}

impl InitialCursorQuery {
    pub(super) fn filter(&mut self, bytes: &[u8]) -> (Vec<u8>, bool) {
        let mut output = Vec::with_capacity(bytes.len() + QUERY.len());
        let mut reply = false;
        for &byte in bytes {
            if self.answered {
                output.push(byte);
            } else if byte == QUERY[self.matched] {
                self.matched += 1;
                if self.matched == QUERY.len() {
                    self.matched = 0;
                    self.answered = true;
                    reply = true;
                }
            } else {
                output.extend_from_slice(&QUERY[..self.matched]);
                self.matched = 0;
                if byte == QUERY[0] {
                    self.matched = 1;
                } else {
                    output.push(byte);
                }
            }
        }
        (output, reply)
    }

    pub(super) fn finish(&mut self) -> Vec<u8> {
        let tail = QUERY[..self.matched].to_vec();
        self.matched = 0;
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_query_is_consumed_at_every_split_boundary_only_once() {
        for split in 0..=QUERY.len() {
            let mut parser = InitialCursorQuery::default();
            let (first, reply1) = parser.filter(&QUERY[..split]);
            let (second, reply2) = parser.filter(&QUERY[split..]);
            assert!(first.is_empty());
            assert!(second.is_empty());
            assert_ne!(reply1, reply2);
            assert_eq!(parser.filter(QUERY), (QUERY.to_vec(), false));
        }
    }

    #[test]
    fn preserves_unicode_and_other_escape_sequences() {
        let prefix = "中文\x1b[?25l\x1b\x1b[".as_bytes();
        let suffix = b"done\x1b[6n";
        let mut parser = InitialCursorQuery::default();
        let mut output = Vec::new();
        let mut replies = 0;
        for byte in prefix.iter().chain(QUERY).chain(suffix) {
            let (data, reply) = parser.filter(&[*byte]);
            output.extend(data);
            replies += usize::from(reply);
        }
        output.extend(parser.finish());
        assert_eq!(output, [prefix, suffix].concat());
        assert_eq!(replies, 1);
    }

    #[test]
    fn preserves_partial_sequence_at_eof() {
        for length in 0..QUERY.len() {
            let mut parser = InitialCursorQuery::default();
            assert_eq!(parser.filter(&QUERY[..length]), (Vec::new(), false));
            assert_eq!(parser.finish(), QUERY[..length]);
        }
    }
}
