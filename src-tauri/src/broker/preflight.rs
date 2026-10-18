//! Typed local refusals before any Launch IPC is sent.
//! This is not a retry capability: rejected-intent retention and explicit
//! single-use confirmation must be implemented before offering a fallback.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchPreflightError {
    MissingProviderHooks,
}

impl std::fmt::Display for LaunchPreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingProviderHooks => f.write_str(
                "目前背景 broker 尚不支援真實活動 hooks；這次未啟動 Agent，既有工作不受影響。請到「設定 → 來源與工具」關閉此工具的「啟用真實活動 hooks」並儲存，再手動建立新工作（暫無活動回報）。不必停止既有 Agent，也不會自動重試。",
            ),
        }
    }
}
