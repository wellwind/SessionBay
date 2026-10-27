//! Permanent-removal policy. Permanent deletion stays closed; the reversible
//! move to the OS trash lives in `os_trash`, which reuses the inspection.
use crate::models::AgentKind;
use crate::tr;

/// Every provider uses the same policy boundary, including unsupported stores.
/// A filesystem snapshot is not an exclusive lease on the provider's live data.
pub fn blockers(kind: AgentKind) -> Vec<String> {
    let provider = match kind {
        AgentKind::Codex => tr!("Codex: the cleanup rules for rollouts, indexes and other related data must be confirmed; deleting the JSONL alone is not enough."),
        AgentKind::Claude => tr!("Claude: the cleanup rules for the main conversation, subagents and other related data must be confirmed; deleting the JSONL alone is not enough."),
        AgentKind::Grok => tr!("Grok: consistency between conversations and metadata and the full cleanup rules must be confirmed."),
        AgentKind::Antigravity => tr!("Antigravity: the shared conversation_summaries.db must be handled row by row; deleting the whole database is not allowed."),
        AgentKind::OpenCode => tr!("OpenCode: the shared opencode.db and WAL must be handled row by row in transactions on a verified schema; deleting the whole database is not allowed."),
    };
    vec![
        provider,
        tr!("The recycle bin did not save source file hashes when items were moved in; this check uses the current index and cannot prove the content is unchanged."),
        tr!("There is no protocol yet to rule out writes by an external agent; stopping work in Session Bay does not prove the source is unused."),
        tr!("Permanent removal is not available yet. It would still need to re-verify the full source, rule out concurrent changes and get explicit confirmation each time."),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_provider_is_explicitly_blocked() {
        for kind in [
            AgentKind::Codex,
            AgentKind::Claude,
            AgentKind::Grok,
            AgentKind::Antigravity,
            AgentKind::OpenCode,
        ] {
            assert_eq!(blockers(kind).len(), 4);
        }
        assert!(
            blockers(AgentKind::OpenCode)[0].contains("deleting the whole database is not allowed")
        );
        assert!(blockers(AgentKind::Antigravity)[0]
            .contains("deleting the whole database is not allowed"));
    }
}
