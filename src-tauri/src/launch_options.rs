//! Validated argv for interactive agents. These are arguments, never shell code.
//! Unknown flags are rejected until their arity and identity effects are reviewed.
use crate::{config::AgentLaunchOptions, models::AgentKind};

#[derive(Clone, Copy)]
enum Arity {
    Flag,
    Value,
}

fn specification(kind: AgentKind, flag: &str) -> Option<Arity> {
    use Arity::{Flag, Value};
    match (kind, flag) {
        (_, "--model")
        | (AgentKind::Codex | AgentKind::Claude | AgentKind::Grok | AgentKind::OpenCode, "-m") => {
            Some(Value)
        }
        (
            AgentKind::Codex,
            "--sandbox" | "-s" | "--ask-for-approval" | "-a" | "--local-provider" | "--image"
            | "-i" | "--add-dir",
        ) => Some(Value),
        (
            AgentKind::Codex,
            "--no-alt-screen"
            | "--no-daemon"
            | "--oss"
            | "--search"
            | "--strict-config"
            | "--dangerously-bypass-approvals-and-sandbox"
            | "--yolo"
            | "--dangerously-bypass-hook-trust"
            | "--approve-for-me"
            | "--not-so-yolo",
        ) => Some(Flag),
        (
            AgentKind::Claude,
            "--effort"
            | "--agent"
            | "--advisor"
            | "--append-system-prompt"
            | "--append-system-prompt-file"
            | "--system-prompt"
            | "--system-prompt-file"
            | "--permission-mode"
            | "--allowedTools"
            | "--allowed-tools"
            | "--disallowedTools"
            | "--disallowed-tools"
            | "--tools"
            | "--add-dir",
        ) => Some(Value),
        (
            AgentKind::Claude,
            "--verbose"
            | "--bare"
            | "--ax-screen-reader"
            | "--dangerously-skip-permissions"
            | "--allow-dangerously-skip-permissions",
        ) => Some(Flag),
        (
            AgentKind::Grok,
            "--effort"
            | "--rules"
            | "--append-system-prompt"
            | "--system-prompt-override"
            | "--system-prompt"
            | "--tools"
            | "--disallowed-tools"
            | "--disallowedTools"
            | "--max-turns"
            | "--allow"
            | "--allowedTools"
            | "--deny"
            | "--sandbox",
        ) => Some(Value),
        (
            AgentKind::Grok,
            "--no-plan"
            | "--no-subagents"
            | "--no-memory"
            | "--disable-web-search"
            | "--experimental-memory"
            | "--always-approve"
            | "--yolo"
            | "--dangerously-skip-permissions",
        ) => Some(Flag),
        (AgentKind::Antigravity, "--effort" | "--agent") => Some(Value),
        (AgentKind::Antigravity, "--sandbox" | "--dangerously-skip-permissions") => Some(Flag),
        (AgentKind::OpenCode, "--agent") => Some(Value),
        (AgentKind::OpenCode, "--pure" | "--auto") => Some(Flag),
        _ => None,
    }
}

pub fn supported_options(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Codex => "--model/-m, --sandbox/-s, --ask-for-approval/-a, --local-provider, --image/-i, --add-dir, --no-alt-screen, --no-daemon, --oss, --search, --strict-config, --dangerously-bypass-approvals-and-sandbox/--yolo, --dangerously-bypass-hook-trust, --approve-for-me/--not-so-yolo",
        AgentKind::Claude => "--model/-m, --effort, --agent, --advisor, --append-system-prompt, --append-system-prompt-file, --system-prompt, --system-prompt-file, --permission-mode, --allowedTools/--allowed-tools, --disallowedTools/--disallowed-tools, --tools, --add-dir, --verbose, --bare, --ax-screen-reader, --dangerously-skip-permissions, --allow-dangerously-skip-permissions",
        AgentKind::Grok => "--model/-m, --effort, --rules/--append-system-prompt, --system-prompt-override/--system-prompt, --tools, --disallowed-tools/--disallowedTools, --max-turns, --allow/--allowedTools, --deny, --sandbox, --no-plan, --no-subagents, --no-memory, --disable-web-search, --experimental-memory, --always-approve/--yolo/--dangerously-skip-permissions",
        AgentKind::Antigravity => "--model, --effort, --agent, --sandbox, --dangerously-skip-permissions",
        AgentKind::OpenCode => "--model/-m, --agent, --pure, --auto (explicit dangerous-options opt-in)",
    }
}

fn risky(kind: AgentKind, flag: &str, value: Option<&str>) -> bool {
    if flag.starts_with("--dangerously-")
        || matches!(
            flag,
            "--auto"
                | "--yolo"
                | "--always-approve"
                | "--allow-dangerously-skip-permissions"
                | "--allowedTools"
                | "--allowed-tools"
                | "--allow"
                | "--add-dir"
                | "--approve-for-me"
                | "--not-so-yolo"
        )
    {
        return true;
    }
    match (kind, flag) {
        (AgentKind::Codex, "--sandbox" | "-s") => value == Some("danger-full-access"),
        (AgentKind::Codex, "--ask-for-approval" | "-a") => value == Some("never"),
        (AgentKind::Claude, "--permission-mode") => {
            !matches!(value, Some("default" | "manual" | "plan"))
        }
        (AgentKind::Grok, "--sandbox") => matches!(value, Some("off" | "devbox")),
        _ => false,
    }
}

fn permission_mode(kind: AgentKind, flag: &str) -> bool {
    match kind {
        AgentKind::Codex => matches!(
            flag,
            "--dangerously-bypass-approvals-and-sandbox"
                | "--yolo"
                | "--sandbox"
                | "-s"
                | "--ask-for-approval"
                | "-a"
                | "--approve-for-me"
                | "--not-so-yolo"
                | "--add-dir"
                | "--dangerously-bypass-hook-trust"
        ),
        AgentKind::Claude => matches!(
            flag,
            "--dangerously-skip-permissions"
                | "--allow-dangerously-skip-permissions"
                | "--permission-mode"
                | "--allowedTools"
                | "--allowed-tools"
                | "--disallowedTools"
                | "--disallowed-tools"
                | "--add-dir"
        ),
        AgentKind::Grok => matches!(
            flag,
            "--always-approve"
                | "--yolo"
                | "--dangerously-skip-permissions"
                | "--allow"
                | "--allowedTools"
                | "--deny"
                | "--disallowed-tools"
                | "--disallowedTools"
        ),
        AgentKind::Antigravity => flag == "--dangerously-skip-permissions",
        AgentKind::OpenCode => flag == "--auto",
    }
}

fn check_value(kind: AgentKind, flag: &str, value: &str) -> Result<(), String> {
    let allowed = match (kind, flag) {
        (AgentKind::Codex, "--sandbox" | "-s") => {
            Some(&["read-only", "workspace-write", "danger-full-access"][..])
        }
        (AgentKind::Codex, "--ask-for-approval" | "-a") => Some(&["on-request", "never"][..]),
        (AgentKind::Claude, "--permission-mode") => Some(
            &[
                "default",
                "manual",
                "plan",
                "acceptEdits",
                "auto",
                "dontAsk",
                "bypassPermissions",
            ][..],
        ),
        (AgentKind::Grok, "--sandbox") => {
            Some(&["off", "workspace", "devbox", "read-only", "strict"][..])
        }
        _ => None,
    };
    if allowed.is_some_and(|choices| !choices.contains(&value)) {
        return Err(format!(
            "Unsupported value for {flag}. Supported values: {}.",
            allowed.unwrap().join(", ")
        ));
    }
    Ok(())
}

fn inspect(kind: AgentKind, options: &AgentLaunchOptions) -> Result<bool, String> {
    if options.extra_args.len() > 64
        || options
            .extra_args
            .iter()
            .any(|arg| arg.len() > 8192 || arg.contains('\0') || arg.is_empty())
    {
        return Err("Agent arguments must contain at most 64 nonempty entries of at most 8 KiB, without NUL characters.".into());
    }
    let mut index = 0;
    let mut explicit_permission = false;
    while index < options.extra_args.len() {
        let argument = &options.extra_args[index];
        let (flag, inline_value) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(flag, value)| {
                (flag, Some(value))
            });
        let arity = specification(kind, flag).ok_or_else(|| format!("Unsupported or managed {} argument: {flag}. Working directory, history source, session ID, subcommands and config overrides are managed by Session Bay. Supported options: {}.", kind.as_str(), supported_options(kind)))?;
        let value = match arity {
            Arity::Flag if inline_value.is_some() => {
                return Err(format!("{flag} is a switch and does not accept a value."))
            }
            Arity::Flag => None,
            Arity::Value => {
                let value = if let Some(value) = inline_value {
                    value
                } else {
                    index += 1;
                    options
                        .extra_args
                        .get(index)
                        .map(String::as_str)
                        .ok_or_else(|| format!("{flag} requires a separate argument value."))?
                };
                if value.is_empty() || (inline_value.is_none() && value.starts_with('-')) {
                    return Err(format!("{flag} requires a nonempty value; use {flag}=VALUE for a literal value beginning with '-'."));
                }
                check_value(kind, flag, value)?;
                Some(value)
            }
        };
        if risky(kind, flag, value) && !options.bypass_permissions {
            return Err(format!(
                "{flag} requires the explicit dangerous-options opt-in for {}.",
                kind.as_str()
            ));
        }
        explicit_permission |= permission_mode(kind, flag);
        index += 1;
    }
    Ok(explicit_permission)
}

pub fn validate(kind: AgentKind, options: &AgentLaunchOptions) -> Result<(), String> {
    inspect(kind, options).map(|_| ())
}

// An explicit scoped grant/deny or bypass-enablement flag is also a policy choice:
// opting in to that flag must not silently widen it to blanket approval.
pub fn arguments(kind: AgentKind, options: &AgentLaunchOptions) -> Result<Vec<String>, String> {
    let explicit_permission = inspect(kind, options)?;
    let mut args = options.extra_args.clone();
    if options.bypass_permissions && !explicit_permission {
        args.push(crate::providers::definition(kind).bypass_flag.clone());
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(args: &[&str], bypass: bool) -> AgentLaunchOptions {
        AgentLaunchOptions {
            extra_args: args.iter().map(|s| (*s).into()).collect(),
            bypass_permissions: bypass,
        }
    }
    #[test]
    fn defaults_never_bypass_and_enabled_presets_are_agent_specific() {
        for (kind, flag) in [
            (
                AgentKind::Codex,
                "--dangerously-bypass-approvals-and-sandbox",
            ),
            (AgentKind::Claude, "--dangerously-skip-permissions"),
            (AgentKind::Grok, "--always-approve"),
            (AgentKind::Antigravity, "--dangerously-skip-permissions"),
            (AgentKind::OpenCode, "--auto"),
        ] {
            assert!(arguments(kind, &options(&[], false)).unwrap().is_empty());
            assert_eq!(arguments(kind, &options(&[], true)).unwrap(), vec![flag]);
            assert!(validate(kind, &options(&[flag], false)).is_err());
            assert_eq!(
                arguments(kind, &options(&[flag], true)).unwrap(),
                vec![flag]
            );
        }
    }
    #[test]
    fn risky_aliases_values_and_equal_forms_require_opt_in() {
        for (kind, args) in [
            (AgentKind::Codex, vec!["--yolo"]),
            (AgentKind::Codex, vec!["-a", "never"]),
            (AgentKind::Codex, vec!["--sandbox=danger-full-access"]),
            (
                AgentKind::Claude,
                vec!["--permission-mode=bypassPermissions"],
            ),
            (AgentKind::Claude, vec!["--allowedTools", "Bash(*)"]),
            (
                AgentKind::Claude,
                vec!["--allow-dangerously-skip-permissions"],
            ),
            (AgentKind::Grok, vec!["--yolo"]),
            (AgentKind::Grok, vec!["--dangerously-skip-permissions"]),
            (AgentKind::Grok, vec!["--sandbox=off"]),
            (AgentKind::Grok, vec!["--allow", "*"]),
            (
                AgentKind::Antigravity,
                vec!["--dangerously-skip-permissions"],
            ),
        ] {
            assert!(
                validate(kind, &options(&args, false))
                    .unwrap_err()
                    .contains("opt-in"),
                "{kind:?}: {args:?}"
            );
            validate(kind, &options(&args, true)).unwrap();
        }
    }
    #[test]
    fn explicit_permission_modes_win_and_grok_sandbox_remains_independent() {
        assert_eq!(
            arguments(
                AgentKind::Codex,
                &options(&["--ask-for-approval", "never"], true)
            )
            .unwrap(),
            vec!["--ask-for-approval", "never"]
        );
        assert_eq!(
            arguments(
                AgentKind::Claude,
                &options(&["--permission-mode=plan"], true)
            )
            .unwrap(),
            vec!["--permission-mode=plan"]
        );
        assert_eq!(
            arguments(AgentKind::Grok, &options(&["--sandbox", "off"], true)).unwrap(),
            vec!["--sandbox", "off", "--always-approve"]
        );
        assert_eq!(
            arguments(AgentKind::Antigravity, &options(&["--sandbox"], true)).unwrap(),
            vec!["--sandbox", "--dangerously-skip-permissions"]
        );
    }
    #[test]
    fn scoped_permission_rules_never_expand_into_blanket_bypass() {
        for (kind, args) in [
            (AgentKind::Codex, vec!["--add-dir", "/synthetic/additional"]),
            (AgentKind::Codex, vec!["--dangerously-bypass-hook-trust"]),
            (
                AgentKind::Claude,
                vec!["--allow-dangerously-skip-permissions"],
            ),
            (AgentKind::Claude, vec!["--allowedTools", "Bash(git log *)"]),
            (AgentKind::Claude, vec!["--disallowed-tools", "Bash"]),
            (
                AgentKind::Claude,
                vec!["--add-dir", "/synthetic/additional"],
            ),
            (AgentKind::Grok, vec!["--allow", "read_file"]),
            (AgentKind::Grok, vec!["--deny", "shell"]),
        ] {
            assert_eq!(arguments(kind, &options(&args, true)).unwrap(), args);
        }
    }
    #[test]
    fn managed_identity_dispatch_and_unreviewed_flags_are_always_blocked() {
        for kind in [
            AgentKind::Codex,
            AgentKind::Claude,
            AgentKind::Grok,
            AgentKind::Antigravity,
        ] {
            for args in [
                vec!["--cwd", "/wrong"],
                vec!["--cwd=/wrong"],
                vec!["--cd=/wrong"],
                vec!["-C/wrong"],
                vec!["--resume", "wrong"],
                vec!["-rwrong"],
                vec!["--session-id=wrong"],
                vec!["--conversation=wrong"],
                vec!["--continue"],
                vec!["--fork-session"],
                vec!["--worktree"],
                vec!["--config", "cwd='/wrong'"],
                vec!["--settings", "{}"],
                vec!["--profile", "other"],
                vec!["--remote", "ws://remote"],
                vec!["--", "exec", "sh"],
                vec!["exec", "sh"],
                vec!["wrap", "sh", "-c", "touch /tmp/never"],
                vec!["--model", "safe", "&&", "rm"],
                vec!["--model", "--cwd=/wrong"],
                vec!["--model"],
                vec!["--model="],
                vec!["--model", "a\0b"],
            ] {
                assert!(
                    validate(kind, &options(&args, true)).is_err(),
                    "{kind:?}: {args:?}"
                );
            }
        }
        assert!(validate(AgentKind::Antigravity, &options(&["--yolo"], true)).is_err());
    }
    #[test]
    fn values_are_not_shell_tokenized_or_quote_stripped() {
        let values = [
            "--append-system-prompt",
            "path with 'quotes'; $(touch never) && second command",
            "--model=--literal",
        ];
        assert_eq!(
            arguments(AgentKind::Claude, &options(&values, false)).unwrap(),
            values
        );
        assert!(validate(AgentKind::Grok, &options(&["--yolo=true"], true)).is_err());
        assert!(validate(AgentKind::Grok, &options(&["--sandbox", "surprise"], true)).is_err());
    }
}
