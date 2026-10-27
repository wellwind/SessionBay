//! Typed local refusals before any Launch IPC is sent.
//! Fresh launch retains this refusal for explicit single-use confirmation only.
use crate::tr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchPreflightError {
    MissingProviderHooks,
}

impl std::fmt::Display for LaunchPreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingProviderHooks => f.write_str(
                &tr!("The background broker does not support activity hooks yet, so the agent was not started this time and existing work is not affected. A new agent can start after you choose to skip activity reporting this time; resuming history keeps the original identity. Existing work and global hook settings are unchanged, and nothing is retried automatically."),
            ),
        }
    }
}
