//! Pull requests (GitHub) and merge requests (GitLab) behind one model.
//!
//! Reviews, approvals and merges are bound to the head SHA the user saw:
//! the current head is re-read first, and the SHA is also sent to the API
//! where the platform supports it, so newer remote content is never
//! approved or merged unseen.
use super::{
    auth,
    http::{Client, HostError, HostErrorKind},
    Connection, Provider,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub number: u64,
    pub title: String,
    pub state: PullState,
    pub draft: bool,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub head_sha: String,
    pub updated_at: String,
    pub web_url: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CiState {
    Pending,
    Running,
    Success,
    Failure,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    pub state: CiState,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    pub state: CiState,
    pub checks: Vec<CiCheck>,
    /// Unix seconds when Session Bay read this; it is not live.
    pub fetched_at: i64,
    pub web_url: Option<String>,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub can_comment: bool,
    pub can_approve: bool,
    pub can_request_changes: bool,
    pub can_merge: bool,
    pub merge_methods: Vec<String>,
    /// Why an action is unavailable, as far as Session Bay can tell.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullDetail {
    pub summary: PullSummary,
    pub body: String,
    pub base_sha: String,
    /// GitLab's diff version start SHA; equals base on GitHub.
    pub start_sha: String,
    pub mergeable: Option<bool>,
    pub merge_status: String,
    pub approved_by: Vec<String>,
    pub viewer_approved: bool,
    pub capabilities: Capabilities,
    pub ci: CiStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    /// Unified hunks; absent for binary or too-large files.
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PullComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub side: Option<String>,
    pub outdated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinePosition {
    pub path: String,
    pub old_path: Option<String>,
    /// `new` for added/context lines, `old` for deleted lines.
    pub side: String,
    pub line: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
    Unapprove,
}

pub struct Api<'a> {
    pub client: &'a Client,
    pub connection: &'a Connection,
    pub token: &'a str,
    pub project: &'a str,
}

const GH: &[(&str, &str)] = &[
    ("X-GitHub-Api-Version", "2022-11-28"),
    ("Accept", "application/vnd.github+json"),
];

fn s(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn encode(component: &str) -> String {
    component
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn gitlab_ci(status: &str) -> CiState {
    match status {
        "success" => CiState::Success,
        "failed" => CiState::Failure,
        "canceled" | "canceling" => CiState::Cancelled,
        "running" => CiState::Running,
        "created" | "pending" | "waiting_for_resource" | "preparing" | "scheduled" | "manual" => {
            CiState::Pending
        }
        _ => CiState::Unknown,
    }
}

pub fn github_check(status: &str, conclusion: Option<&str>) -> CiState {
    match (status, conclusion) {
        ("completed", Some("success" | "neutral" | "skipped")) => CiState::Success,
        ("completed", Some("failure" | "timed_out" | "action_required" | "startup_failure")) => {
            CiState::Failure
        }
        ("completed", Some("cancelled" | "stale")) => CiState::Cancelled,
        ("in_progress", _) => CiState::Running,
        ("queued" | "waiting" | "requested" | "pending", _) => CiState::Pending,
        _ => CiState::Unknown,
    }
}

/// Failure wins, then running/pending; success only if every check passed.
/// No checks at all is unknown, never success.
pub fn overall(checks: &[CiCheck]) -> CiState {
    if checks.is_empty() {
        return CiState::Unknown;
    }
    for state in [
        CiState::Failure,
        CiState::Cancelled,
        CiState::Running,
        CiState::Pending,
        CiState::Unknown,
    ] {
        if checks.iter().any(|c| c.state == state) {
            return state;
        }
    }
    CiState::Success
}

impl Api<'_> {
    fn base(&self) -> String {
        match self.connection.provider {
            Provider::Github => format!("{}/repos/{}", self.connection.api_url, self.project),
            Provider::Gitlab => format!(
                "{}/projects/{}",
                self.connection.api_url,
                encode(self.project)
            ),
        }
    }
    fn extra(&self) -> &'static [(&'static str, &'static str)] {
        match self.connection.provider {
            Provider::Github => GH,
            Provider::Gitlab => &[],
        }
    }
    fn get(&self, url: &str) -> Result<Value, HostError> {
        Ok(self
            .client
            .get::<Value>(url, auth(self.connection.scheme, self.token), self.extra())?
            .body)
    }
    fn send(&self, method: &str, url: &str, body: Value) -> Result<Value, HostError> {
        Ok(self
            .client
            .send::<Value>(
                method,
                url,
                auth(self.connection.scheme, self.token),
                &body,
                self.extra(),
            )?
            .body)
    }

    fn github_summary(value: &Value) -> PullSummary {
        let merged = !value["merged_at"].is_null();
        PullSummary {
            number: value["number"].as_u64().unwrap_or(0),
            title: s(value, "title"),
            state: if merged {
                PullState::Merged
            } else if s(value, "state") == "open" {
                PullState::Open
            } else {
                PullState::Closed
            },
            draft: value["draft"].as_bool().unwrap_or(false),
            author: value["user"]["login"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            source_branch: value["head"]["ref"].as_str().unwrap_or_default().to_owned(),
            target_branch: value["base"]["ref"].as_str().unwrap_or_default().to_owned(),
            head_sha: value["head"]["sha"].as_str().unwrap_or_default().to_owned(),
            updated_at: s(value, "updated_at"),
            web_url: s(value, "html_url"),
        }
    }

    fn gitlab_summary(value: &Value) -> PullSummary {
        let state = match value["state"].as_str() {
            Some("merged") => PullState::Merged,
            Some("opened") => PullState::Open,
            _ => PullState::Closed,
        };
        PullSummary {
            number: value["iid"].as_u64().unwrap_or(0),
            title: s(value, "title"),
            state,
            draft: value["draft"]
                .as_bool()
                .or_else(|| value["work_in_progress"].as_bool())
                .unwrap_or(false),
            author: value["author"]["username"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            source_branch: s(value, "source_branch"),
            target_branch: s(value, "target_branch"),
            head_sha: s(value, "sha"),
            updated_at: s(value, "updated_at"),
            web_url: s(value, "web_url"),
        }
    }

    pub fn list(&self, state: &str) -> Result<Vec<PullSummary>, HostError> {
        match self.connection.provider {
            Provider::Github => {
                let state = match state {
                    "closed" => "closed",
                    "all" => "all",
                    _ => "open",
                };
                let value = self.get(&format!(
                    "{}/pulls?state={state}&per_page=50&sort=updated&direction=desc",
                    self.base()
                ))?;
                Ok(value
                    .as_array()
                    .map(|a| a.iter().map(Self::github_summary).collect())
                    .unwrap_or_default())
            }
            Provider::Gitlab => {
                let state = match state {
                    "closed" => "closed",
                    "merged" => "merged",
                    "all" => "all",
                    _ => "opened",
                };
                let value = self.get(&format!(
                    "{}/merge_requests?state={state}&per_page=50&order_by=updated_at",
                    self.base()
                ))?;
                Ok(value
                    .as_array()
                    .map(|a| a.iter().map(Self::gitlab_summary).collect())
                    .unwrap_or_default())
            }
        }
    }

    fn ci(&self, sha: &str, gitlab_pipeline: Option<&Value>) -> CiStatus {
        let fetched_at = super::now();
        let (checks, web_url) = match self.connection.provider {
            Provider::Github => {
                let mut checks = Vec::new();
                if let Ok(runs) = self.get(&format!(
                    "{}/commits/{sha}/check-runs?per_page=100",
                    self.base()
                )) {
                    for run in runs["check_runs"].as_array().into_iter().flatten() {
                        checks.push(CiCheck {
                            name: s(run, "name"),
                            state: github_check(
                                run["status"].as_str().unwrap_or_default(),
                                run["conclusion"].as_str(),
                            ),
                            url: run["html_url"].as_str().map(str::to_owned),
                        });
                    }
                }
                if let Ok(status) = self.get(&format!("{}/commits/{sha}/status", self.base())) {
                    for item in status["statuses"].as_array().into_iter().flatten() {
                        let state = match item["state"].as_str() {
                            Some("success") => CiState::Success,
                            Some("failure" | "error") => CiState::Failure,
                            Some("pending") => CiState::Pending,
                            _ => CiState::Unknown,
                        };
                        checks.push(CiCheck {
                            name: s(item, "context"),
                            state,
                            url: item["target_url"].as_str().map(str::to_owned),
                        });
                    }
                }
                (checks, None)
            }
            Provider::Gitlab => match gitlab_pipeline.filter(|p| !p.is_null()) {
                Some(pipeline) => (
                    vec![CiCheck {
                        name: format!("pipeline #{}", pipeline["id"].as_u64().unwrap_or(0)),
                        state: gitlab_ci(pipeline["status"].as_str().unwrap_or_default()),
                        url: pipeline["web_url"].as_str().map(str::to_owned),
                    }],
                    pipeline["web_url"].as_str().map(str::to_owned),
                ),
                None => (Vec::new(), None),
            },
        };
        CiStatus {
            state: overall(&checks),
            checks,
            fetched_at,
            web_url,
            sha: sha.to_owned(),
        }
    }

    pub fn detail(&self, number: u64, viewer: &str) -> Result<PullDetail, HostError> {
        match self.connection.provider {
            Provider::Github => {
                let pull = self.get(&format!("{}/pulls/{number}", self.base()))?;
                let repo = self.get(&self.base()).unwrap_or(Value::Null);
                let reviews = self
                    .get(&format!(
                        "{}/pulls/{number}/reviews?per_page=100",
                        self.base()
                    ))
                    .unwrap_or(Value::Null);
                let summary = Self::github_summary(&pull);
                let mut latest: Vec<(String, String)> = Vec::new();
                for review in reviews.as_array().into_iter().flatten() {
                    let user = review["user"]["login"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned();
                    let state = s(review, "state");
                    if state == "COMMENTED" {
                        continue;
                    }
                    latest.retain(|(u, _)| u != &user);
                    latest.push((user, state));
                }
                let approved_by: Vec<String> = latest
                    .iter()
                    .filter(|(_, s)| s == "APPROVED")
                    .map(|(u, _)| u.clone())
                    .collect();
                let push = repo["permissions"]["push"].as_bool();
                let mut methods = Vec::new();
                for (key, name) in [
                    ("allow_merge_commit", "merge"),
                    ("allow_squash_merge", "squash"),
                    ("allow_rebase_merge", "rebase"),
                ] {
                    if repo[key].as_bool().unwrap_or(true) {
                        methods.push(name.to_owned());
                    }
                }
                let own = summary.author.eq_ignore_ascii_case(viewer);
                let mut notes = Vec::new();
                if own {
                    notes.push("GitHub 不允許核准或要求變更自己的 PR".into());
                }
                if push == Some(false) {
                    notes.push("此帳號沒有 push 權限，無法合併".into());
                }
                let open = summary.state == PullState::Open;
                let ci = self.ci(&summary.head_sha, None);
                Ok(PullDetail {
                    body: s(&pull, "body"),
                    base_sha: pull["base"]["sha"].as_str().unwrap_or_default().to_owned(),
                    start_sha: pull["base"]["sha"].as_str().unwrap_or_default().to_owned(),
                    mergeable: pull["mergeable"].as_bool(),
                    merge_status: s(&pull, "mergeable_state"),
                    viewer_approved: approved_by.iter().any(|u| u.eq_ignore_ascii_case(viewer)),
                    approved_by,
                    capabilities: Capabilities {
                        can_comment: true,
                        can_approve: open && !own,
                        can_request_changes: open && !own,
                        can_merge: open && push != Some(false) && !summary.draft,
                        merge_methods: methods,
                        notes,
                    },
                    ci,
                    summary,
                })
            }
            Provider::Gitlab => {
                let mr = self.get(&format!("{}/merge_requests/{number}", self.base()))?;
                let approvals = self
                    .get(&format!(
                        "{}/merge_requests/{number}/approvals",
                        self.base()
                    ))
                    .ok();
                let project = self.get(&self.base()).unwrap_or(Value::Null);
                let summary = Self::gitlab_summary(&mr);
                let approved_by: Vec<String> = approvals
                    .as_ref()
                    .and_then(|a| a["approved_by"].as_array())
                    .map(|list| {
                        list.iter()
                            .filter_map(|e| e["user"]["username"].as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let access = project["permissions"]["project_access"]["access_level"]
                    .as_u64()
                    .max(project["permissions"]["group_access"]["access_level"].as_u64())
                    .unwrap_or(0);
                let user_can_merge = mr["user"]["can_merge"].as_bool();
                let merge_method = project["merge_method"].as_str().unwrap_or("merge");
                let mut methods = vec![match merge_method {
                    "ff" => "fastForward",
                    "rebase_merge" => "rebaseMerge",
                    _ => "merge",
                }
                .to_owned()];
                if project["squash_option"].as_str() != Some("never") {
                    methods.push("squash".into());
                }
                let open = summary.state == PullState::Open;
                let mut notes =
                    vec!["GitLab 的「要求變更」依版本與方案而定，此處以留言代替".to_owned()];
                if approvals.is_none() {
                    notes.push("無法讀取核准狀態（可能是版本或權限限制）".into());
                }
                if user_can_merge == Some(false) || (user_can_merge.is_none() && access < 30) {
                    notes.push("此帳號在目前設定下不能合併".into());
                }
                let ci = self.ci(&summary.head_sha, Some(&mr["head_pipeline"]));
                Ok(PullDetail {
                    body: s(&mr, "description"),
                    base_sha: mr["diff_refs"]["base_sha"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    start_sha: mr["diff_refs"]["start_sha"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    mergeable: match mr["detailed_merge_status"]
                        .as_str()
                        .or_else(|| mr["merge_status"].as_str())
                    {
                        Some("mergeable" | "can_be_merged") => Some(true),
                        Some("checking" | "unchecked" | "preparing") | None => None,
                        _ => Some(false),
                    },
                    merge_status: mr["detailed_merge_status"]
                        .as_str()
                        .or_else(|| mr["merge_status"].as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    viewer_approved: approved_by.iter().any(|u| u.eq_ignore_ascii_case(viewer)),
                    approved_by,
                    capabilities: Capabilities {
                        can_comment: true,
                        can_approve: open && approvals.is_some(),
                        can_request_changes: false,
                        can_merge: open && user_can_merge.unwrap_or(access >= 30),
                        merge_methods: methods,
                        notes,
                    },
                    ci,
                    summary,
                })
            }
        }
    }

    pub fn files(&self, number: u64) -> Result<(Vec<PullFile>, bool), HostError> {
        match self.connection.provider {
            Provider::Github => {
                let mut files = Vec::new();
                let mut truncated = false;
                for page in 1..=3 {
                    let value = self.get(&format!(
                        "{}/pulls/{number}/files?per_page=100&page={page}",
                        self.base()
                    ))?;
                    let batch = value.as_array().cloned().unwrap_or_default();
                    let count = batch.len();
                    for file in batch {
                        files.push(PullFile {
                            path: s(&file, "filename"),
                            old_path: file["previous_filename"].as_str().map(str::to_owned),
                            status: s(&file, "status"),
                            additions: file["additions"].as_u64().unwrap_or(0),
                            deletions: file["deletions"].as_u64().unwrap_or(0),
                            patch: file["patch"].as_str().map(str::to_owned),
                        });
                    }
                    if count < 100 {
                        break;
                    }
                    truncated = page == 3;
                }
                Ok((files, truncated))
            }
            Provider::Gitlab => {
                let value = self.get(&format!(
                    "{}/merge_requests/{number}/diffs?per_page=100",
                    self.base()
                ))?;
                let files = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|file| {
                        let diff = s(file, "diff");
                        PullFile {
                            path: s(file, "new_path"),
                            old_path: (s(file, "old_path") != s(file, "new_path"))
                                .then(|| s(file, "old_path")),
                            status: if file["new_file"].as_bool() == Some(true) {
                                "added"
                            } else if file["deleted_file"].as_bool() == Some(true) {
                                "removed"
                            } else if file["renamed_file"].as_bool() == Some(true) {
                                "renamed"
                            } else {
                                "modified"
                            }
                            .to_owned(),
                            additions: diff.lines().filter(|l| l.starts_with('+')).count() as u64,
                            deletions: diff.lines().filter(|l| l.starts_with('-')).count() as u64,
                            patch: (!diff.is_empty()).then_some(diff),
                        }
                    })
                    .collect::<Vec<_>>();
                let truncated = files.len() >= 100;
                Ok((files, truncated))
            }
        }
    }

    pub fn comments(&self, number: u64) -> Result<Vec<PullComment>, HostError> {
        let mut list = Vec::new();
        match self.connection.provider {
            Provider::Github => {
                for comment in self
                    .get(&format!(
                        "{}/issues/{number}/comments?per_page=100",
                        self.base()
                    ))?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    list.push(PullComment {
                        id: comment["id"].to_string(),
                        author: comment["user"]["login"].as_str().unwrap_or_default().into(),
                        body: s(comment, "body"),
                        created_at: s(comment, "created_at"),
                        path: None,
                        line: None,
                        side: None,
                        outdated: false,
                    });
                }
                for comment in self
                    .get(&format!(
                        "{}/pulls/{number}/comments?per_page=100",
                        self.base()
                    ))?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    list.push(PullComment {
                        id: comment["id"].to_string(),
                        author: comment["user"]["login"].as_str().unwrap_or_default().into(),
                        body: s(comment, "body"),
                        created_at: s(comment, "created_at"),
                        path: comment["path"].as_str().map(str::to_owned),
                        line: comment["line"]
                            .as_u64()
                            .or_else(|| comment["original_line"].as_u64()),
                        side: comment["side"]
                            .as_str()
                            .map(|s| if s == "LEFT" { "old" } else { "new" }.to_owned()),
                        outdated: comment["line"].is_null(),
                    });
                }
            }
            Provider::Gitlab => {
                for discussion in self
                    .get(&format!(
                        "{}/merge_requests/{number}/discussions?per_page=100",
                        self.base()
                    ))?
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    for note in discussion["notes"].as_array().into_iter().flatten() {
                        if note["system"].as_bool() == Some(true) {
                            continue;
                        }
                        let position = &note["position"];
                        let new_line = position["new_line"].as_u64();
                        list.push(PullComment {
                            id: note["id"].to_string(),
                            author: note["author"]["username"]
                                .as_str()
                                .unwrap_or_default()
                                .into(),
                            body: s(note, "body"),
                            created_at: s(note, "created_at"),
                            path: position["new_path"].as_str().map(str::to_owned),
                            line: new_line.or_else(|| position["old_line"].as_u64()),
                            side: (!position.is_null())
                                .then(|| if new_line.is_some() { "new" } else { "old" }.to_owned()),
                            outdated: false,
                        });
                    }
                }
            }
        }
        list.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(list)
    }

    /// Fails unless the remote head is still the one the user reviewed.
    pub fn expect_head(
        &self,
        number: u64,
        expected: &str,
        viewer: &str,
    ) -> Result<PullDetail, HostError> {
        let detail = self.detail(number, viewer)?;
        if detail.summary.head_sha != expected {
            return Err(HostError::new(
                HostErrorKind::Conflict,
                None,
                format!(
                    "遠端已有新的 commit（{} → {}）；先前的檢視已失效，請重新檢視後再操作",
                    &expected[..expected.len().min(7)],
                    &detail.summary.head_sha[..detail.summary.head_sha.len().min(7)]
                ),
            ));
        }
        Ok(detail)
    }

    pub fn comment(
        &self,
        number: u64,
        body: &str,
        position: Option<&LinePosition>,
        expected_head: &str,
        viewer: &str,
    ) -> Result<(), HostError> {
        if body.trim().is_empty() {
            return Err(HostError::new(HostErrorKind::Invalid, None, "留言不可空白"));
        }
        let Some(position) = position else {
            let url = match self.connection.provider {
                Provider::Github => format!("{}/issues/{number}/comments", self.base()),
                Provider::Gitlab => format!("{}/merge_requests/{number}/notes", self.base()),
            };
            self.send("POST", &url, json!({ "body": body }))?;
            return Ok(());
        };
        // Line comments anchor to the reviewed diff version.
        let detail = self.expect_head(number, expected_head, viewer)?;
        match self.connection.provider {
            Provider::Github => {
                self.send("POST", &format!("{}/pulls/{number}/comments", self.base()), json!({
                    "body": body, "commit_id": detail.summary.head_sha, "path": position.path, "line": position.line,
                    "side": if position.side == "old" { "LEFT" } else { "RIGHT" },
                }))?;
            }
            Provider::Gitlab => {
                let mut anchor = json!({
                    "position_type": "text", "base_sha": detail.base_sha, "start_sha": detail.start_sha, "head_sha": detail.summary.head_sha,
                    "new_path": position.path, "old_path": position.old_path.clone().unwrap_or_else(|| position.path.clone()),
                });
                anchor[if position.side == "old" {
                    "old_line"
                } else {
                    "new_line"
                }] = json!(position.line);
                self.send(
                    "POST",
                    &format!("{}/merge_requests/{number}/discussions", self.base()),
                    json!({ "body": body, "position": anchor }),
                )?;
            }
        }
        Ok(())
    }

    pub fn review(
        &self,
        number: u64,
        event: ReviewEvent,
        body: &str,
        expected_head: &str,
        viewer: &str,
    ) -> Result<(), HostError> {
        self.expect_head(number, expected_head, viewer)?;
        match (self.connection.provider, event) {
            (Provider::Github, ReviewEvent::Unapprove) => Err(HostError::new(
                HostErrorKind::Unsupported,
                None,
                "GitHub 不支援撤回核准；請改為要求變更或留言",
            )),
            (Provider::Github, event) => {
                let kind = match event {
                    ReviewEvent::Approve => "APPROVE",
                    ReviewEvent::RequestChanges => "REQUEST_CHANGES",
                    _ => "COMMENT",
                };
                if event != ReviewEvent::Approve && body.trim().is_empty() {
                    return Err(HostError::new(
                        HostErrorKind::Invalid,
                        None,
                        "此 review 需要說明",
                    ));
                }
                self.send(
                    "POST",
                    &format!("{}/pulls/{number}/reviews", self.base()),
                    json!({ "commit_id": expected_head, "event": kind, "body": body }),
                )?;
                Ok(())
            }
            (Provider::Gitlab, ReviewEvent::Approve) => {
                // `sha` makes GitLab refuse when the MR head moved.
                self.send(
                    "POST",
                    &format!("{}/merge_requests/{number}/approve", self.base()),
                    json!({ "sha": expected_head }),
                )?;
                if !body.trim().is_empty() {
                    self.comment(number, body, None, expected_head, viewer)?;
                }
                Ok(())
            }
            (Provider::Gitlab, ReviewEvent::Unapprove) => {
                self.send(
                    "POST",
                    &format!("{}/merge_requests/{number}/unapprove", self.base()),
                    json!({}),
                )?;
                Ok(())
            }
            (Provider::Gitlab, ReviewEvent::RequestChanges) => Err(HostError::new(
                HostErrorKind::Unsupported,
                None,
                "此 GitLab 整合不支援「要求變更」；請改用留言",
            )),
            (Provider::Gitlab, ReviewEvent::Comment) => {
                self.comment(number, body, None, expected_head, viewer)
            }
        }
    }

    pub fn merge(
        &self,
        number: u64,
        method: &str,
        expected_head: &str,
        viewer: &str,
    ) -> Result<(), HostError> {
        let detail = self.expect_head(number, expected_head, viewer)?;
        if !detail
            .capabilities
            .merge_methods
            .iter()
            .any(|m| m == method)
        {
            return Err(HostError::new(
                HostErrorKind::Unsupported,
                None,
                format!("此 repository 不允許 {method} 合併方式"),
            ));
        }
        match self.connection.provider {
            Provider::Github => {
                self.send(
                    "PUT",
                    &format!("{}/pulls/{number}/merge", self.base()),
                    json!({ "sha": expected_head, "merge_method": method }),
                )?;
            }
            Provider::Gitlab => {
                // GitLab answers 401 here for "cannot accept this MR", which
                // is a permission problem, not an expired login.
                self.send(
                    "PUT",
                    &format!("{}/merge_requests/{number}/merge", self.base()),
                    json!({ "sha": expected_head, "squash": method == "squash" }),
                )
                .map_err(|error| {
                    if error.status == Some(401) {
                        HostError::new(
                            HostErrorKind::Forbidden,
                            Some(401),
                            "此帳號不能接受此 MR（權限或分支保護設定）（HTTP 401）",
                        )
                    } else {
                        error
                    }
                })?;
            }
        }
        Ok(())
    }

    pub fn create(
        &self,
        title: &str,
        body: &str,
        source: &str,
        target: &str,
        draft: bool,
    ) -> Result<PullSummary, HostError> {
        if title.trim().is_empty() {
            return Err(HostError::new(HostErrorKind::Invalid, None, "標題不可空白"));
        }
        match self.connection.provider {
            Provider::Github => {
                let value = self.send("POST", &format!("{}/pulls", self.base()), json!({ "title": title, "body": body, "head": source, "base": target, "draft": draft }))?;
                Ok(Self::github_summary(&value))
            }
            Provider::Gitlab => {
                let title = if draft && !title.starts_with("Draft:") {
                    format!("Draft: {title}")
                } else {
                    title.to_owned()
                };
                let value = self.send("POST", &format!("{}/merge_requests", self.base()), json!({ "title": title, "description": body, "source_branch": source, "target_branch": target }))?;
                Ok(Self::gitlab_summary(&value))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_states_never_claim_success_without_evidence() {
        assert_eq!(overall(&[]), CiState::Unknown);
        let check = |state| CiCheck {
            name: "x".into(),
            state,
            url: None,
        };
        assert_eq!(
            overall(&[check(CiState::Success), check(CiState::Running)]),
            CiState::Running
        );
        assert_eq!(
            overall(&[check(CiState::Success), check(CiState::Failure)]),
            CiState::Failure
        );
        assert_eq!(
            overall(&[check(CiState::Success), check(CiState::Unknown)]),
            CiState::Unknown
        );
        assert_eq!(overall(&[check(CiState::Success)]), CiState::Success);
        assert_eq!(gitlab_ci("manual"), CiState::Pending);
        assert_eq!(
            github_check("completed", Some("timed_out")),
            CiState::Failure
        );
        assert_eq!(encode("group/sub project"), "group%2Fsub%20project");
    }
}
