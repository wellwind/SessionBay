//! Stable, camelCase data shared by the catalog and desktop IPC.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Codex,
    Claude,
    Grok,
    Antigravity,
    OpenCode,
}

impl AgentKind {
    pub const ALL: [Self; 5] = [
        Self::Codex,
        Self::Claude,
        Self::Grok,
        Self::Antigravity,
        Self::OpenCode,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Grok => "grok",
            Self::Antigravity => "antigravity",
            Self::OpenCode => "opencode",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        crate::providers::lookup(value)
            .map(|provider| provider.id)
            .ok_or_else(|| format!("Unsupported agent kind: {value}"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySource {
    pub id: String,
    pub kind: AgentKind,
    pub root: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub kind: AgentKind,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub available: bool,
    pub error: Option<String>,
    pub status: InstallationStatus,
    pub login_status: LoginStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallationStatus {
    Missing,
    Available,
    VersionCheckFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoginStatus {
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHealth {
    pub source_id: String,
    pub status: String,
    pub message: Option<String>,
    pub files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub launch_path: Option<String>,
    pub exists: bool,
    pub pinned: bool,
    pub curated: bool,
    pub session_count: u64,
    pub updated_at: Option<String>,
    pub agents: Vec<AgentKind>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    Directory,
    File,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: WorkspaceEntryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFilePage {
    pub entries: Vec<WorkspaceEntry>,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFilePreview {
    pub path: String,
    pub text: String,
    pub size_bytes: usize,
}

/// A bounded sample classifies content; callers must still validate text while streaming.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceFileKind {
    Text,
    Binary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileInfo {
    pub path: String,
    pub size_bytes: u64,
    /// Opaque identity and revision. A changed file requires a new inspection.
    pub version: String,
    pub kind: WorkspaceFileKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileChunk {
    /// Raw bytes preserve multibyte characters across arbitrary chunk boundaries.
    pub bytes: Vec<u8>,
    pub eof: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(default)]
    pub trash_identity: Option<String>,
    pub source_id: String,
    pub kind: AgentKind,
    pub external_id: String,
    pub project_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub updated_at: String,
    pub time_source: String,
    pub archived: bool,
    pub parent_id: Option<String>,
    pub partial: bool,
    pub snippet: Option<String>,
    #[serde(default)]
    pub resume_disabled_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuery {
    pub oldest_first: Option<bool>,
    pub project_id: Option<String>,
    pub kind: Option<AgentKind>,
    pub query: Option<String>,
    pub archived: Option<bool>,
    pub include_children: Option<bool>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub catalog_revision: String,
    pub items: Vec<Session>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedSession {
    pub id: String,
    pub session: Session,
    pub source_root: String,
    pub deleted_at: String,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPage {
    pub catalog_revision: String,
    pub items: Vec<TrashedSession>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
    pub line: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub messages: Vec<TranscriptMessage>,
    pub has_more: bool,
    pub before_line: Option<u64>,
    pub stale: bool,
    pub warning: Option<String>,
    #[serde(default)]
    pub snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    #[serde(default)]
    pub revision: u64,
    pub running: bool,
    pub processed: usize,
    pub total: usize,
    pub cancelled: bool,
    pub errors: Vec<String>,
    pub sources: Vec<SourceHealth>,
}
