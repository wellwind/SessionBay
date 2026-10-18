//! Current-backend fresh launch evidence for older compatible PTY brokers.
//! A caller intent key is never a runtime/pane identity or attachment capability.
use crate::{
    broker::{BrokerClient, LaunchPreflightError, RuntimeRecord},
    runtime::{LaunchSpec, RuntimeInfo},
    service::LaunchRequest,
};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) const NOT_STARTED: &str = "[SESSIONBAY_LAUNCH_NOT_STARTED] ";

pub(crate) trait FreshBroker {
    fn preflight(&self, spec: &LaunchSpec) -> Result<(), LaunchPreflightError>;
    fn generation(&self) -> String;
    fn list(&self) -> Result<Vec<RuntimeRecord>, String>;
    fn launch(&self, spec: LaunchSpec, request: &LaunchRequest) -> Result<RuntimeInfo, String>;
}
impl FreshBroker for BrokerClient {
    fn preflight(&self, spec: &LaunchSpec) -> Result<(), LaunchPreflightError> {
        self.check_provider_hooks(spec)
    }
    fn generation(&self) -> String {
        self.generation()
    }
    fn list(&self) -> Result<Vec<RuntimeRecord>, String> {
        self.list()
    }
    fn launch(&self, spec: LaunchSpec, request: &LaunchRequest) -> Result<RuntimeInfo, String> {
        self.launch_unattached(spec, request)
    }
}
struct Attempt {
    intent: Vec<u8>,
    request: LaunchRequest,
    spec: LaunchSpec,
    prior_ids: HashSet<String>,
    eligible: bool,
    returned: Option<RuntimeInfo>,
    expires_at: u64,
    capability_error: Option<String>,
}
#[derive(Default)]
pub struct FreshLaunches {
    attempts: HashMap<(String, String), Attempt>,
    observed_now: u64,
}
impl FreshLaunches {
    pub(crate) fn capability_error(&self, generation: &str, runtime_id: &str) -> Option<String> {
        self.attempts
            .iter()
            .find(|((g, _), attempt)| {
                g == generation
                    && attempt
                        .returned
                        .as_ref()
                        .is_some_and(|info| info.id == runtime_id)
            })
            .and_then(|(_, attempt)| attempt.capability_error.clone())
    }
    pub(crate) fn launch<B: FreshBroker>(
        &mut self,
        intent: &LaunchRequest,
        broker: &B,
        plan: impl FnOnce(&LaunchRequest) -> Result<LaunchSpec, String>,
        record_provenance: impl FnMut(&str, &RuntimeRecord) -> Result<(), String>,
    ) -> Result<RuntimeInfo, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is before UNIX epoch")?
            .as_millis() as u64;
        self.launch_at(intent, broker, plan, record_provenance, now)
    }
    fn launch_at<B: FreshBroker>(
        &mut self,
        intent: &LaunchRequest,
        broker: &B,
        plan: impl FnOnce(&LaunchRequest) -> Result<LaunchSpec, String>,
        mut record_provenance: impl FnMut(&str, &RuntimeRecord) -> Result<(), String>,
        now: u64,
    ) -> Result<RuntimeInfo, String> {
        self.observed_now = self.observed_now.max(now);
        let now = self.observed_now;
        // Expired intent tokens are rejected before eviction; clock rollback cannot resurrect them.
        let (issued, nonce) = intent
            .pane_id
            .split_once(':')
            .ok_or("Invalid fresh launch intent")?;
        let issued: u64 = issued
            .parse()
            .map_err(|_| "Invalid fresh launch intent time")?;
        let nonce = Uuid::parse_str(nonce).map_err(|_| "Invalid fresh launch intent nonce")?;
        let expires_at = issued
            .checked_add(10 * 60 * 1000)
            .ok_or("Invalid fresh launch intent time")?;
        if nonce.is_nil() || issued > now.saturating_add(30_000) || now >= expires_at {
            return Err("啟動請求已過期或時間不符；請重新開啟啟動器。原請求不會重送。".into());
        }
        self.attempts.retain(|_, attempt| attempt.expires_at > now);
        if intent.kind == "shell" || intent.session_id.is_some() || intent.resume_id.is_some() {
            return Err("Fresh launch only accepts a new Agent without resume identity".into());
        }
        crate::models::AgentKind::parse(&intent.kind)?;
        if intent.pane_id.is_empty()
            || intent.pane_id.len() > 128
            || intent.pane_id.chars().any(char::is_control)
        {
            return Err("Invalid fresh launch intent".into());
        }
        let generation = broker.generation();
        Uuid::parse_str(&generation).map_err(|_| "Invalid broker generation")?;
        if self.attempts.keys().any(|(old_generation, old_intent)| {
            old_intent == &intent.pane_id && old_generation != &generation
        }) {
            return Err("Fresh launch intent belongs to a different broker generation; launch was not retried".into());
        }
        let key = (generation.clone(), intent.pane_id.clone());
        let serialized = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
        let first = !self.attempts.contains_key(&key);
        if first {
            if self.attempts.len() >= 128 {
                return Err(
                    "目前十分鐘內的啟動請求已達上限，請稍後再試；既有 Agent 繼續運作。".into(),
                );
            }
            let mut request = intent.clone();
            request.pane_id = Uuid::new_v4().to_string();
            let mut spec = plan(&request)?;
            if spec.pane_id != request.pane_id
                || spec.session_id.is_some()
                || spec.resume_key.is_some()
            {
                return Err(
                    "Fresh launch plan contains an unexpected resume or pane identity".into(),
                );
            }
            spec.cwd = spec.cwd.canonicalize().map_err(|e| e.to_string())?;
            // This local capability check cannot send Launch or spawn an Agent.
            // Reject before caching an uncertain attempt; do not fall back or retry.
            broker
                .preflight(&spec)
                .map_err(|error| format!("{NOT_STARTED}{error}"))?;
            let prior = broker.list()?;
            if prior.iter().any(|r| r.info.pane_id == request.pane_id) {
                return Err("Fresh pane identity collision".into());
            }
            let eligible = crate::image_input::supports_launch(&request.kind, &spec);
            self.attempts.insert(
                key.clone(),
                Attempt {
                    intent: serialized.clone(),
                    request,
                    spec,
                    prior_ids: prior.into_iter().map(|r| r.info.id).collect(),
                    eligible,
                    returned: None,
                    expires_at,
                    capability_error: None,
                },
            );
        }
        let attempt = self
            .attempts
            .get_mut(&key)
            .ok_or("Fresh launch intent unavailable")?;
        if attempt.intent != serialized {
            return Err("Fresh launch intent was reused with different parameters".into());
        }
        // Send once only. A lost response may be recovered by authoritative List, never a second launch.
        let launch_error = if first {
            match broker.launch(attempt.spec.clone(), &attempt.request) {
                Ok(info) => {
                    attempt.returned = Some(info);
                    None
                }
                Err(error) => Some(error),
            }
        } else {
            None
        };
        let records = broker.list()?;
        if broker.generation() != generation {
            return Err("Broker generation changed during fresh launch".into());
        }
        let matching: Vec<_> = records
            .iter()
            .filter(|r| r.info.pane_id == attempt.spec.pane_id)
            .collect();
        if matching.len() != 1 {
            return Err(format!(
                "啟動結果尚未確認，未授予檔案能力；請重新整理工作階段，不會重試或停止 Agent。 {}",
                launch_error.unwrap_or_default()
            ));
        }
        let record = matching[0];
        if attempt.prior_ids.contains(&record.info.id)
            || record.info.session_id.is_some()
            || record.resume_id.is_some()
            || record.kind != attempt.request.kind
            || record.project_id != attempt.request.project_id
            || record.profile_id != attempt.request.profile_id
            || record.info.cwd != attempt.spec.cwd.to_string_lossy()
            || Uuid::parse_str(&record.info.id).is_err()
            || attempt.returned.as_ref().is_some_and(|info| {
                info.id != record.info.id
                    || info.pane_id != record.info.pane_id
                    || info.session_id != record.info.session_id
                    || info.cwd != record.info.cwd
            })
        {
            return Err("Fresh launch returned a reused or mismatched runtime; file capability was not granted".into());
        }
        if attempt.eligible
            && record.file_input.is_none()
            && !record.image_input
            && record.info.state == "running"
            && record.info.exit_code.is_none()
        {
            // Capability failure must not hide a confirmed runtime or its startup diagnostics.
            // Each attachment action independently requires the successfully persisted proof.
            attempt.capability_error = record_provenance(&generation, record).err();
        }
        attempt.returned = Some(record.info.clone());
        Ok(record.info.clone())
    }
}

/// Positive legacy evidence is a fallback only; authoritative denials always win.
pub(crate) fn check_file_capability(
    record: &RuntimeRecord,
    evidence: impl FnOnce() -> Result<bool, String>,
) -> Result<(), String> {
    let original = crate::file_input::check_runtime(record);
    if original.is_ok()
        || record.file_input.is_some()
        || record.image_input
        || record.info.state != "running"
        || record.info.exit_code.is_some()
        || !matches!(
            record.kind.as_str(),
            "codex" | "claude" | "grok" | "opencode"
        )
    {
        return original;
    }
    if evidence()? {
        Ok(())
    } else {
        original
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    struct Fake {
        generation: RefCell<String>,
        records: RefCell<Vec<RuntimeRecord>>,
        launches: Cell<usize>,
        lose_reply: bool,
        suppress: bool,
        deny: bool,
        change_generation: bool,
        reuse_prior: bool,
        preflight_denied: Cell<bool>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                generation: RefCell::new(Uuid::new_v4().to_string()),
                records: RefCell::new(vec![]),
                launches: Cell::new(0),
                lose_reply: false,
                suppress: false,
                deny: false,
                change_generation: false,
                reuse_prior: false,
                preflight_denied: Cell::new(false),
            }
        }
    }
    impl FreshBroker for Fake {
        fn preflight(&self, _: &LaunchSpec) -> Result<(), LaunchPreflightError> {
            if self.preflight_denied.get() {
                Err(LaunchPreflightError::MissingProviderHooks)
            } else {
                Ok(())
            }
        }
        fn generation(&self) -> String {
            self.generation.borrow().clone()
        }
        fn list(&self) -> Result<Vec<RuntimeRecord>, String> {
            Ok(self.records.borrow().clone())
        }
        fn launch(&self, spec: LaunchSpec, request: &LaunchRequest) -> Result<RuntimeInfo, String> {
            self.launches.set(self.launches.get() + 1);
            let info = RuntimeInfo {
                id: if self.reuse_prior {
                    self.records.borrow()[0].info.id.clone()
                } else {
                    Uuid::new_v4().to_string()
                },
                pane_id: spec.pane_id,
                session_id: None,
                state: "running".into(),
                cwd: spec.cwd.to_string_lossy().into(),
                exit_code: None,
            };
            if !self.suppress {
                self.records.borrow_mut().push(RuntimeRecord {
                    info: info.clone(),
                    kind: request.kind.clone(),
                    project_id: request.project_id.clone(),
                    profile_id: request.profile_id.clone(),
                    resume_id: None,
                    home_directory: None,
                    image_input: false,
                    file_input: if self.deny { Some(false) } else { None },
                });
            }
            if self.change_generation {
                *self.generation.borrow_mut() = Uuid::new_v4().to_string();
            }
            if self.lose_reply {
                Err("lost response".into())
            } else {
                Ok(info)
            }
        }
    }
    fn request(kind: &str) -> LaunchRequest {
        LaunchRequest {
            pane_id: format!(
                "{}:{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
                Uuid::new_v4()
            ),
            kind: kind.into(),
            project_id: None,
            session_id: None,
            resume_id: None,
            cwd: None,
            profile_id: None,
            cols: 80,
            rows: 24,
        }
    }
    fn plan(r: &LaunchRequest) -> Result<LaunchSpec, String> {
        Ok(LaunchSpec {
            executable: r.kind.clone(),
            args: vec![],
            cwd: std::env::temp_dir(),
            env: HashMap::new(),
            session_id: None,
            resume_key: None,
            pane_id: r.pane_id.clone(),
        })
    }
    #[test]
    fn preflight_rejection_is_known_not_started_and_does_not_cache_an_attempt() {
        let broker = Fake::new();
        broker.preflight_denied.set(true);
        let mut cache = FreshLaunches::default();
        let r = request("codex");
        let error = cache
            .launch(&r, &broker, plan, |_, _| {
                panic!("no provenance before launch")
            })
            .unwrap_err();
        assert_eq!(
            error,
            format!(
                "{NOT_STARTED}{}",
                LaunchPreflightError::MissingProviderHooks
            )
        );
        assert!(!error.contains("尚未確認"));
        assert_eq!(broker.launches.get(), 0);
        assert!(cache.attempts.is_empty());
        // Only an explicit later caller action with a now-compatible plan may launch.
        broker.preflight_denied.set(false);
        cache.launch(&r, &broker, plan, |_, _| Ok(())).unwrap();
        assert_eq!(broker.launches.get(), 1);
    }
    #[test]
    fn old_broker_new_codex_and_claude_get_verified_evidence() {
        for kind in ["codex", "claude"] {
            let broker = Fake::new();
            let mut cache = FreshLaunches::default();
            let mut grants = 0;
            let info = cache
                .launch(&request(kind), &broker, plan, |_, _| {
                    grants += 1;
                    Ok(())
                })
                .unwrap();
            assert_ne!(info.pane_id, "intent");
            assert_eq!(grants, 1);
            assert_eq!(broker.launches.get(), 1);
        }
    }
    #[test]
    fn duplicate_keeps_frozen_plan_and_never_launches_twice() {
        let broker = Fake::new();
        let mut cache = FreshLaunches::default();
        let r = request("codex");
        let first = cache.launch(&r, &broker, plan, |_, _| Ok(())).unwrap();
        let second = cache
            .launch(
                &r,
                &broker,
                |_| panic!("settings mutation must not replan"),
                |_, _| Ok(()),
            )
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(broker.launches.get(), 1);
        let mut changed = r;
        changed.cols = 99;
        assert!(cache
            .launch(&changed, &broker, plan, |_, _| Ok(()))
            .is_err());
    }
    #[test]
    fn lost_response_recovers_only_authoritative_fresh_record() {
        let mut broker = Fake::new();
        broker.lose_reply = true;
        let mut cache = FreshLaunches::default();
        assert!(cache
            .launch(&request("claude"), &broker, plan, |_, _| Ok(()))
            .is_ok());
        assert_eq!(broker.launches.get(), 1);
        let mut missing = Fake::new();
        missing.lose_reply = true;
        missing.suppress = true;
        let mut cache = FreshLaunches::default();
        let intent = request("claude");
        for _ in 0..2 {
            assert!(cache
                .launch(&intent, &missing, plan, |_, _| panic!("no proof"))
                .is_err());
        }
        assert_eq!(missing.launches.get(), 1);
    }
    #[test]
    fn resume_shell_and_unexpected_plan_never_dispatch() {
        let broker = Fake::new();
        let mut cache = FreshLaunches::default();
        for r in [
            request("shell"),
            LaunchRequest {
                resume_id: Some("old".into()),
                ..request("codex")
            },
            LaunchRequest {
                session_id: Some("old".into()),
                ..request("claude")
            },
        ] {
            assert!(cache.launch(&r, &broker, plan, |_, _| Ok(())).is_err());
        }
        assert!(cache
            .launch(
                &request("codex"),
                &broker,
                |r| {
                    let mut s = plan(r)?;
                    s.resume_key = Some("old".into());
                    Ok(s)
                },
                |_, _| Ok(())
            )
            .is_err());
        assert_eq!(broker.launches.get(), 0);
    }
    #[test]
    fn explicit_denial_and_generation_change_never_grant() {
        let mut broker = Fake::new();
        broker.deny = true;
        assert!(FreshLaunches::default()
            .launch(&request("codex"), &broker, plan, |_, _| panic!(
                "explicit denial"
            ))
            .is_ok());
        let mut broker = Fake::new();
        broker.change_generation = true;
        assert!(FreshLaunches::default()
            .launch(&request("codex"), &broker, plan, |_, _| panic!(
                "changed generation"
            ))
            .is_err());
    }
    #[test]
    fn restart_never_replays_an_old_intent() {
        let broker = Fake::new();
        let mut cache = FreshLaunches::default();
        let r = request("codex");
        cache.launch(&r, &broker, plan, |_, _| Ok(())).unwrap();
        *broker.generation.borrow_mut() = Uuid::new_v4().to_string();
        assert!(cache
            .launch(&r, &broker, plan, |_, _| panic!("restart"))
            .is_err());
        assert_eq!(broker.launches.get(), 1);
    }
    #[test]
    fn stopped_or_mutated_record_on_retry_never_grants() {
        for mutation in 1..4 {
            let broker = Fake::new();
            let mut cache = FreshLaunches::default();
            let r = request("codex");
            cache.launch(&r, &broker, plan, |_, _| Ok(())).unwrap();
            {
                let mut records = broker.records.borrow_mut();
                let record = &mut records[0];
                match mutation {
                    0 => record.info.state = "exited".into(),
                    1 => record.kind = "claude".into(),
                    2 => record.resume_id = Some("old".into()),
                    _ => record.info.cwd = "/different".into(),
                }
            }
            assert!(cache
                .launch(&r, &broker, plan, |_, _| panic!("changed record"))
                .is_err());
        }
    }
    #[test]
    fn capability_fallback_never_overrides_denial_or_liveness() {
        let broker = Fake::new();
        FreshLaunches::default()
            .launch(&request("codex"), &broker, plan, |_, _| Ok(()))
            .unwrap();
        let mut record = broker.records.borrow()[0].clone();
        assert!(check_file_capability(&record, || Ok(true)).is_ok());
        assert!(check_file_capability(&record, || Ok(false)).is_err());
        assert!(check_file_capability(&record, || Err("corrupt evidence".into())).is_err());
        record.file_input = Some(false);
        assert!(check_file_capability(&record, || panic!("denial must win")).is_err());
        record.file_input = Some(true);
        assert!(check_file_capability(&record, || panic!("broker positive is enough")).is_ok());
        record.info.state = "exited".into();
        assert!(check_file_capability(&record, || panic!("stopped must fail")).is_err());
        record.info.state = "running".into();
        record.info.exit_code = Some(0);
        assert!(check_file_capability(&record, || panic!("exit code must fail")).is_err());
        record.info.exit_code = None;
        record.file_input = None;
        record.image_input = true;
        assert!(check_file_capability(&record, || panic!("legacy positive is enough")).is_ok());
        record.image_input = false;
        record.kind = "shell".into();
        assert!(check_file_capability(&record, || panic!("unknown kind")).is_err());
    }

    #[test]
    fn unexpected_dedup_and_unverified_wrapper_never_grant() {
        let mut broker = Fake::new();
        let r = request("codex");
        FreshLaunches::default()
            .launch(&r, &broker, plan, |_, _| Ok(()))
            .unwrap();
        broker.reuse_prior = true;
        assert!(FreshLaunches::default()
            .launch(&r, &broker, plan, |_, _| panic!("old runtime reused"))
            .is_err());
        let broker = Fake::new();
        assert!(FreshLaunches::default()
            .launch(
                &r,
                &broker,
                |r| {
                    let mut s = plan(r)?;
                    s.executable = "ssh".into();
                    Ok(s)
                },
                |_, _| panic!("wrapper has no proof")
            )
            .is_ok());
    }
    #[test]
    fn expired_intents_free_capacity_but_cannot_replay_even_after_eviction() {
        let broker = Fake::new();
        let mut cache = FreshLaunches::default();
        for _ in 0..128 {
            let mut r = request("codex");
            r.pane_id = format!("1000:{}", Uuid::new_v4());
            cache
                .launch_at(&r, &broker, plan, |_, _| Ok(()), 1000)
                .unwrap();
        }
        let used_intent = cache.attempts.keys().next().unwrap().1.clone();
        let old = request("codex");
        let mut old = LaunchRequest {
            pane_id: format!("1000:{}", Uuid::new_v4()),
            ..old
        };
        assert!(cache
            .launch_at(&old, &broker, plan, |_, _| Ok(()), 1000)
            .is_err());
        old.pane_id = format!("601001:{}", Uuid::new_v4());
        cache
            .launch_at(&old, &broker, plan, |_, _| Ok(()), 601001)
            .unwrap();
        assert_eq!(cache.attempts.len(), 1);
        old.pane_id = used_intent;
        assert!(cache
            .launch_at(&old, &broker, plan, |_, _| Ok(()), 601001)
            .is_err());
        // Even a rolled-back wall clock cannot revive an evicted intent.
        assert!(cache
            .launch_at(&old, &broker, plan, |_, _| Ok(()), 1000)
            .is_err());
        old.pane_id = format!("9999999:{}", Uuid::new_v4());
        assert!(cache
            .launch_at(&old, &broker, plan, |_, _| Ok(()), 601001)
            .is_err());
        assert_eq!(broker.launches.get(), 129);
    }
    #[test]
    fn proof_failure_or_fast_exit_still_returns_the_confirmed_runtime() {
        let broker = Fake::new();
        let mut cache = FreshLaunches::default();
        let r = request("codex");
        let info = cache
            .launch(&r, &broker, plan, |_, _| Err("store full".into()))
            .unwrap();
        assert_eq!(
            cache
                .capability_error(&broker.generation(), &info.id)
                .as_deref(),
            Some("store full")
        );
        {
            let mut records = broker.records.borrow_mut();
            records[0].info.state = "exited".into();
            records[0].info.exit_code = Some(1);
        }
        let exited = cache
            .launch(&r, &broker, plan, |_, _| panic!("exited grant"))
            .unwrap();
        assert_eq!(info.id, exited.id);
        assert_eq!(exited.state, "exited");
        assert_eq!(broker.launches.get(), 1);
    }
}
