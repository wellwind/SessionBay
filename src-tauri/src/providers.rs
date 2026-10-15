//! Built-in provider metadata shared with the frontend; not a runtime plugin loader.
//! Parser implementations and reviewed custom-argument policies remain explicit Rust code.
use crate::models::AgentKind;
use serde::Deserialize;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

const MANIFEST: &str = include_str!("../../src/agent-manifest.json");

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ParserId {
    Codex,
    Claude,
    Grok,
    Antigravity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCapability {
    pub supported: bool,
    pub parser_id: Option<ParserId>,
    pub source_env: Option<String>,
    pub default_directory: String,
    pub probe_directory: Option<String>,
    pub root_placeholder: Option<String>,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeCapability {
    pub manual_id: bool,
    pub argument: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchCapability {
    pub version_args: Vec<String>,
    pub new_args: Vec<String>,
    pub resume_args: Vec<String>,
    pub cwd_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderDefinition {
    pub id: AgentKind,
    pub name: String,
    pub executable: String,
    pub logo: String,
    pub bypass_flag: String,
    pub history: HistoryCapability,
    pub resume: ResumeCapability,
    pub launch: LaunchCapability,
}

impl ProviderDefinition {
    pub fn state_root(&self, home: &Path) -> PathBuf {
        self.history
            .source_env
            .as_ref()
            .and_then(|key| std::env::var(key).ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(&self.history.default_directory))
    }

    pub fn resume_arguments(&self, id: &str) -> Vec<String> {
        expand(&self.launch.resume_args, "{resumeId}", id)
    }

    pub fn cwd_arguments(&self, cwd: &Path) -> Vec<String> {
        expand(&self.launch.cwd_args, "{cwd}", &cwd.to_string_lossy())
    }
}

fn expand(template: &[String], placeholder: &str, value: &str) -> Vec<String> {
    template
        .iter()
        .map(|arg| {
            if arg == placeholder {
                value.to_owned()
            } else {
                arg.clone()
            }
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    providers: Vec<ProviderDefinition>,
}

impl Manifest {
    fn parse(json: &str) -> Result<Self, String> {
        let manifest: Self = serde_json::from_str(json).map_err(|error| error.to_string())?;
        if manifest.version != 1 {
            return Err("Unsupported built-in provider manifest version".into());
        }
        let mut ids = HashSet::new();
        for provider in &manifest.providers {
            if !ids.insert(provider.id) {
                return Err("Duplicate built-in provider ID".into());
            }
            let history = &provider.history;
            if history.supported != history.parser_id.is_some()
                || (!history.supported && history.source_env.is_some())
                || history.supported != history.root_placeholder.is_some()
                || history.default_directory.is_empty()
                || !Path::new(&history.default_directory)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err("Inconsistent provider history capability".into());
            }
            let expected_parser = match provider.id {
                AgentKind::Codex => ParserId::Codex,
                AgentKind::Claude => ParserId::Claude,
                AgentKind::Grok => ParserId::Grok,
                AgentKind::Antigravity => ParserId::Antigravity,
            };
            if history
                .parser_id
                .is_some_and(|parser| parser != expected_parser)
                || (history.supported
                    && history.source_env.is_none()
                    && provider.id != AgentKind::Antigravity)
                || (provider.id == AgentKind::Antigravity && history.source_env.is_some())
            {
                return Err(
                    "Provider parser or source environment does not match its reviewed integration"
                        .into(),
                );
            }
            if history.source_env.as_ref().is_some_and(|key| {
                key.is_empty()
                    || !key
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            }) {
                return Err("Invalid provider source environment key".into());
            }
            if history.probe_directory.as_ref().is_some_and(|directory| {
                !history.supported
                    || directory.is_empty()
                    || !Path::new(directory)
                        .components()
                        .all(|part| matches!(part, Component::Normal(_)))
            }) {
                return Err("Invalid provider history probe directory".into());
            }
            if provider.name.is_empty()
                || provider.logo.is_empty()
                || provider.executable.is_empty()
                || provider.executable.contains(['/', '\\', '\0'])
                || !provider.bypass_flag.starts_with("--")
                || provider.bypass_flag.contains([' ', '\0'])
            {
                return Err("Invalid built-in provider metadata".into());
            }
            // Probes must never inherit launch permissions or execute a subcommand chain.
            if !matches!(provider.launch.version_args.as_slice(), [arg] if arg == "--version" || arg == "version")
            {
                return Err("Provider version probe must use a single version argument".into());
            }
            validate_template(&provider.launch.new_args, None)?;
            validate_template(&provider.launch.resume_args, Some("{resumeId}"))?;
            validate_template(
                &provider.launch.cwd_args,
                if provider.launch.cwd_args.is_empty() {
                    None
                } else {
                    Some("{cwd}")
                },
            )?;
            if provider.launch.resume_args.first() != Some(&provider.resume.argument) {
                return Err("Resume label and managed argument template disagree".into());
            }
        }
        if ids != AgentKind::ALL.into_iter().collect() {
            return Err(
                "Every compiled agent kind must have exactly one provider definition".into(),
            );
        }
        Ok(manifest)
    }
}

fn validate_template(args: &[String], placeholder: Option<&str>) -> Result<(), String> {
    let mut placeholders = 0;
    for arg in args {
        if Some(arg.as_str()) == placeholder {
            placeholders += 1;
        } else if arg.is_empty() || arg.contains(['\0', '{', '}']) {
            return Err("Invalid managed argument template".into());
        }
    }
    if placeholders != usize::from(placeholder.is_some()) {
        return Err("Managed argument template must use its placeholder exactly once".into());
    }
    Ok(())
}

pub fn definitions() -> &'static [ProviderDefinition] {
    static REGISTRY: OnceLock<Manifest> = OnceLock::new();
    &REGISTRY
        .get_or_init(|| {
            Manifest::parse(MANIFEST)
                .expect("The compiled provider manifest must pass its contract tests")
        })
        .providers
}

pub fn definition(kind: AgentKind) -> &'static ProviderDefinition {
    definitions()
        .iter()
        .find(|provider| provider.id == kind)
        .expect("Every compiled AgentKind has a validated provider definition")
}

pub fn lookup(id: &str) -> Option<&'static ProviderDefinition> {
    definitions()
        .iter()
        .find(|provider| provider.id.as_str() == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_manifest_covers_compiled_providers_and_reviewed_policies() {
        assert_eq!(definitions().len(), AgentKind::ALL.len());
        for provider in definitions() {
            assert_eq!(lookup(provider.id.as_str()).unwrap().id, provider.id);
            assert_eq!(
                serde_json::to_value(provider.id).unwrap(),
                provider.id.as_str()
            );
            assert_eq!(
                provider.history.parser_id.is_some(),
                provider.history.supported
            );
            crate::launch_options::validate(
                provider.id,
                &crate::config::AgentLaunchOptions {
                    extra_args: vec![provider.bypass_flag.clone()],
                    bypass_permissions: true,
                },
            )
            .unwrap();
        }
        assert!(lookup("opencode").is_none());
        assert_eq!(definition(AgentKind::Grok).launch.version_args, ["version"]);
        assert_eq!(
            definition(AgentKind::Grok)
                .history
                .probe_directory
                .as_deref(),
            Some("sessions")
        );
        assert!(definition(AgentKind::Antigravity).history.supported);
        assert!(definition(AgentKind::Antigravity)
            .history
            .source_env
            .is_none());
    }

    #[test]
    fn registry_rejects_missing_duplicate_and_inconsistent_capabilities() {
        let original: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        let mut value = original.clone();
        value["providers"].as_array_mut().unwrap().pop();
        assert!(Manifest::parse(&value.to_string()).is_err());
        let mut value = original.clone();
        value["providers"][1] = value["providers"][0].clone();
        assert!(Manifest::parse(&value.to_string()).is_err());
        for (field, invalid) in [
            (
                "history",
                serde_json::json!({"supported":true,"parserId":null,"sourceEnv":null,"defaultDirectory":"../escape","rootPlaceholder":null,"description":"test"}),
            ),
            (
                "launch",
                serde_json::json!({"versionArgs":["--yolo"],"newArgs":[],"resumeArgs":["resume","{resumeId}"],"cwdArgs":[]}),
            ),
            (
                "launch",
                serde_json::json!({"versionArgs":["--version"],"newArgs":[],"resumeArgs":["resume","{unknown}"],"cwdArgs":[]}),
            ),
        ] {
            let mut value = original.clone();
            value["providers"][0][field] = invalid;
            assert!(Manifest::parse(&value.to_string()).is_err());
        }
        for invalid in ["", "../outside", "/absolute"] {
            let mut value = original.clone();
            value["providers"][2]["history"]["probeDirectory"] = serde_json::json!(invalid);
            assert!(Manifest::parse(&value.to_string()).is_err());
        }
        for invalid in [serde_json::json!("AGY_HOME"), serde_json::json!("HOME")] {
            let mut value = original.clone();
            value["providers"][3]["history"]["sourceEnv"] = invalid;
            assert!(Manifest::parse(&value.to_string()).is_err());
        }
        let mut value = original.clone();
        value["providers"][3]["history"]["parserId"] = serde_json::json!("grok");
        assert!(Manifest::parse(&value.to_string()).is_err());
        let mut value = original;
        value["providers"][3]["history"]["supported"] = serde_json::json!(false);
        assert!(Manifest::parse(&value.to_string()).is_err());
    }

    #[test]
    fn managed_templates_keep_values_in_single_arguments() {
        let cwd = Path::new("/synthetic/with spaces;$(literal)");
        assert_eq!(
            definition(AgentKind::Codex).cwd_arguments(cwd),
            ["--cd", cwd.to_str().unwrap()]
        );
        for provider in definitions() {
            assert_eq!(provider.resume_arguments("synthetic-id")[1], "synthetic-id");
        }
    }
}
