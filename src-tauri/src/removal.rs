//! Permanent-removal policy. Permanent deletion stays closed; the reversible
//! move to the OS trash lives in `os_trash`, which reuses the inspection.
use crate::models::AgentKind;

/// Every provider uses the same policy boundary, including unsupported stores.
/// A filesystem snapshot is not an exclusive lease on the provider's live data.
pub fn blockers(kind: AgentKind) -> Vec<String> {
    let provider = match kind {
        AgentKind::Codex => "Codex：需確認 rollout、索引與其他關聯資料的清除規則，不能只刪 JSONL。",
        AgentKind::Claude => "Claude：需確認主對話、subagent 與其他關聯資料的清除規則，不能只刪 JSONL。",
        AgentKind::Grok => "Grok：需確認對話與 metadata 的一致性及完整清除規則。",
        AgentKind::Antigravity => "Antigravity：共用 conversation_summaries.db 必須逐筆處理；禁止刪除整個資料庫。",
        AgentKind::OpenCode => "OpenCode：共用 opencode.db 與 WAL 必須以已驗證 schema 交易逐筆處理；禁止刪除整個資料庫。",
    };
    vec![
        provider.into(),
        "回收筒未保存移入時的來源檔案雜湊；此處檢查目前索引，不能證明與移入時內容相同。".into(),
        "尚無可排除外部 Agent 寫入的協定；停止 Session Bay 中的工作仍不足以證明來源未被使用。"
            .into(),
        "永久移除尚未開放。執行前仍需重新驗證完整來源、排除並行變更並逐次明確確認。".into(),
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
        assert!(blockers(AgentKind::OpenCode)[0].contains("禁止刪除整個資料庫"));
        assert!(blockers(AgentKind::Antigravity)[0].contains("禁止刪除整個資料庫"));
    }
}
