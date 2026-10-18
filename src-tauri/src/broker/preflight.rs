//! Typed local refusals before any Launch IPC is sent.
//! Fresh launch retains this refusal for explicit single-use confirmation only.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchPreflightError {
    MissingProviderHooks,
}

impl std::fmt::Display for LaunchPreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingProviderHooks => f.write_str(
                "目前背景 broker 尚不支援真實活動 hooks；這次未啟動 Agent，既有工作不受影響。新 Agent 可選擇本次不啟用活動回報後繼續啟動；歷史接續請保留原 identity。既有工作與全域 hooks 設定不變，不會自動重試。",
            ),
        }
    }
}
