//! Synthetic temporary terminals. Never starts a vendor CLI or reads agent history.
mod common;
use sessionbay_lib::{
    config::ShellProfile,
    service::{LaunchRequest, Service},
};
use std::{collections::HashMap, path::PathBuf};

fn reported_child_cwd(output: &str) -> std::io::Result<PathBuf> {
    let (_, value) = output.split_once("actual-cwd:").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "missing child cwd marker")
    })?;
    let value = value.lines().next().unwrap_or_default();
    // Windows PowerShell can qualify a verbatim path with its FileSystem provider.
    // Remove only that exact provider name; filesystem canonicalization must still
    // resolve the entire reported path, so a different cwd cannot pass by substring.
    let value = value
        .strip_prefix(r"Microsoft.PowerShell.Core\FileSystem::")
        .unwrap_or(value);
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "child cwd is not an absolute filesystem path",
        ));
    }
    path.canonicalize()
}

#[test]
fn child_cwd_report_resolves_native_and_exact_powershell_filesystem_paths() {
    let temp = tempfile::tempdir().unwrap();
    let expected = temp.path().canonicalize().unwrap();
    for path in [temp.path(), expected.as_path()] {
        for provider in ["", r"Microsoft.PowerShell.Core\FileSystem::"] {
            let output = format!(
                "\u{1b}[mactual-cwd:{provider}{}\r\nprofile-home:untrusted\r\n",
                path.display()
            );
            assert_eq!(reported_child_cwd(&output).unwrap(), expected);
        }
    }
}

#[test]
fn child_cwd_report_does_not_accept_a_different_or_malformed_directory() {
    let temp = tempfile::tempdir().unwrap();
    let trusted = temp.path().join("home");
    let other = temp.path().join("home-profile-override");
    std::fs::create_dir(&trusted).unwrap();
    std::fs::create_dir(&other).unwrap();
    // The old contains assertion could accept a different directory sharing the prefix.
    let output = format!("actual-cwd:{}\r\n", other.display());
    assert_ne!(
        reported_child_cwd(&output).unwrap(),
        trusted.canonicalize().unwrap()
    );
    for output in [
        "profile-home:untrusted".into(),
        "actual-cwd:relative".into(),
        format!(
            "actual-cwd:Microsoft.PowerShell.Core\\Registry::{}",
            trusted.display()
        ),
        format!("actual-cwd:{}-missing", trusted.display()),
    ] {
        assert!(reported_child_cwd(&output).is_err(), "{output:?}");
    }
}

fn request(pane: &str) -> LaunchRequest {
    LaunchRequest {
        pane_id: pane.into(),
        kind: "shell".into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: None,
        profile_id: None,
        cols: 80,
        rows: 24,
    }
}
fn configured_service(directory: &std::path::Path) -> std::sync::Arc<Service> {
    let service = Service::open(directory.join("app")).unwrap();
    let mut settings = service.settings().unwrap();
    settings.sources.clear();
    settings.default_profile_id = "synthetic-home-shell".into();
    settings.profiles = vec![ShellProfile {
        id: "synthetic-home-shell".into(),
        name: "Synthetic home shell".into(),
        executable: common::noop_executable(directory),
        args: vec!["literal ; argument".into()],
        env: HashMap::from([
            (
                "HOME".into(),
                directory
                    .join("profile-home-must-not-select-cwd")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "USERPROFILE".into(),
                directory
                    .join("profile-userprofile-must-not-select-cwd")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]),
    }];
    service.save_settings(settings).unwrap();
    service
}
#[test]
fn global_shell_resolves_home_in_rust_and_does_not_create_a_catalog_project() {
    let temp = tempfile::tempdir().unwrap();
    let service = configured_service(temp.path());
    let request = request("global-home");
    let plan = service.plan_launch(&request).unwrap();
    assert_eq!(plan.cwd, dirs::home_dir().unwrap());
    assert!(plan.cwd.is_absolute() && plan.cwd.is_dir());
    assert_ne!(plan.cwd, PathBuf::from(&plan.env["HOME"]));
    assert_ne!(plan.cwd, PathBuf::from(&plan.env["USERPROFILE"]));
    assert_eq!(plan.args, ["literal ; argument"]);
    assert!(plan.session_id.is_none() && plan.resume_key.is_none());
    assert_eq!(
        service.preview_launch(&request).unwrap().cwd,
        plan.cwd.to_string_lossy()
    );
    assert!(service.catalog.projects().unwrap().is_empty());
    let mut explicit = request.clone();
    explicit.cwd = Some(temp.path().to_string_lossy().into_owned());
    assert_eq!(service.plan_launch(&explicit).unwrap().cwd, temp.path());
    explicit.cwd = Some("relative".into());
    assert!(service.plan_launch(&explicit).is_err());
    let mut agent = request.clone();
    agent.kind = "codex".into();
    assert!(service.plan_launch(&agent).is_err());
    let mut forged = serde_json::to_value(&request).unwrap();
    forged["env"] = serde_json::json!({"HOME":"/untrusted-web-client"});
    assert!(serde_json::from_value::<LaunchRequest>(forged).is_err());
}

#[cfg(any(unix, windows))]
#[test]
fn global_terminals_reopen_same_broker_ids_and_explicit_close_keeps_the_other_runtime() {
    use sessionbay_lib::broker::{BrokerClient, UiEvent};
    use std::{
        path::Path,
        sync::{mpsc, Arc},
        time::{Duration, Instant},
    };
    fn connect(path: &Path) -> BrokerClient {
        BrokerClient::connect(path, Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))).unwrap()
    }
    fn until_text(
        client: &BrokerClient,
        lease: &str,
        events: &mpsc::Receiver<UiEvent>,
        needle: &str,
    ) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut bytes = vec![];
        loop {
            match events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap()
            {
                UiEvent::Output {
                    runtime_id,
                    sequence,
                    data,
                }
                | UiEvent::Snapshot {
                    runtime_id,
                    sequence,
                    data,
                    ..
                } => {
                    bytes.extend(data);
                    client.ack(&runtime_id, sequence, lease).unwrap();
                    let text = String::from_utf8_lossy(&bytes);
                    if text.contains(needle) {
                        return text.into_owned();
                    }
                }
                UiEvent::Error { message, .. } | UiEvent::Disconnected { message, .. } => {
                    panic!("{message}")
                }
                UiEvent::Exit { .. } => panic!("terminal exited before marker"),
            }
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let service = configured_service(temp.path());
    let mut settings = service.settings().unwrap();
    #[cfg(unix)]
    {
        settings.profiles[0].executable = "/bin/sh".into();
        settings.profiles[0].args = vec!["-c".into(), "printf 'temporary-start:%s\\n' $$; read line; printf 'temporary-reply:%s\\n' \"$line\"; sleep 30".into()];
    }
    #[cfg(windows)]
    {
        settings.profiles[0].executable = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
            .to_string_lossy()
            .into_owned();
        settings.profiles[0].args = vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(),
            "Write-Output \"temporary-start:$PID\"; $line=Read-Host; Write-Output \"temporary-reply:$line\"; Start-Sleep -Seconds 30".into()];
    }
    settings.profiles[0].env.clear();
    service.save_settings(settings).unwrap();
    let broker_dir = temp.path().join("runtime");
    std::fs::create_dir(&broker_dir).unwrap();
    struct Cleanup(BrokerClient);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.shutdown_broker();
        }
    }
    let client = connect(&broker_dir);
    let _cleanup = Cleanup(client.clone());
    let mut ids = vec![];
    for pane in ["temporary-one", "temporary-two"] {
        let request = request(pane);
        let spec = service.plan_launch(&request).unwrap();
        assert_eq!(spec.cwd, dirs::home_dir().unwrap());
        let lease = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let info = client
            .launch(
                spec,
                &request,
                lease.clone(),
                Arc::new(move |event| tx.send(event).map_err(|error| error.to_string())),
            )
            .unwrap();
        until_text(&client, &lease, &rx, "temporary-start:");
        ids.push(info.id);
    }
    client.detach_all();
    drop(client);
    let reopened = connect(&broker_dir);
    let records = reopened.list().unwrap();
    assert_eq!(records.len(), 2);
    for record in &records {
        assert!(record.project_id.is_none());
        assert_eq!(record.home_directory, Some(true));
        assert!(ids.contains(&record.info.id));
        assert_eq!(record.info.state, "running");
        // Runtime launch resolves filesystem aliases, including Windows' verbatim prefix.
        assert_eq!(
            PathBuf::from(&record.info.cwd),
            dirs::home_dir().unwrap().canonicalize().unwrap()
        );
    }
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    let attached = reopened
        .attach(
            &ids[0],
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|error| error.to_string())),
        )
        .unwrap();
    assert_eq!(attached.id, ids[0]);
    until_text(&reopened, &lease, &rx, "temporary-start:");
    reopened.write(&ids[0], "after-reopen\r").unwrap();
    until_text(&reopened, &lease, &rx, "temporary-reply:after-reopen");
    reopened.stop(&ids[0]).unwrap();
    reopened.forget(&ids[0]).unwrap();
    let remaining = reopened.list().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].info.id, ids[1]);
    assert_eq!(remaining[0].info.state, "running");
    assert!(remaining[0].project_id.is_none());
    assert_eq!(remaining[0].home_directory, Some(true));
    assert!(service.catalog.projects().unwrap().is_empty());
    reopened.shutdown_broker().unwrap();
}

#[cfg(any(unix, windows))]
#[test]
fn temporary_child_starts_in_trusted_home_despite_profile_home_overrides() {
    use sessionbay_lib::runtime::{RuntimeManager, TerminalEvent};
    use std::{
        sync::{mpsc, Arc},
        time::{Duration, Instant},
    };
    let temp = tempfile::tempdir().unwrap();
    let service = configured_service(temp.path());
    let mut settings = service.settings().unwrap();
    #[cfg(unix)]
    {
        settings.profiles[0].executable = "/bin/sh".into();
        settings.profiles[0].args = vec![
            "-c".into(),
            "printf 'actual-cwd:%s\\nprofile-home:%s\\n' \"$PWD\" \"$HOME\"".into(),
        ];
    }
    #[cfg(windows)]
    {
        settings.profiles[0].executable = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
            .to_string_lossy()
            .into_owned();
        settings.profiles[0].args = vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(),
            "Write-Output \"actual-cwd:$((Get-Location).Path)\"; Write-Output \"profile-home:$env:HOME\"".into()];
    }
    let override_home = settings.profiles[0].env["HOME"].clone();
    service.save_settings(settings).unwrap();
    let spec = service.plan_launch(&request("actual-home")).unwrap();
    let home = spec.cwd.canonicalize().unwrap();
    let manager = RuntimeManager::new();
    let (tx, rx) = mpsc::channel();
    manager
        .launch(
            spec,
            160,
            24,
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut output = vec![];
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            TerminalEvent::Output {
                runtime_id,
                sequence,
                data,
            } => {
                output.extend(data);
                manager.ack(&runtime_id, sequence).unwrap();
            }
            TerminalEvent::Exit { exit_code, .. } => {
                assert_eq!(exit_code, Some(0));
                break;
            }
            TerminalEvent::Error { message, .. } => panic!("{message}"),
        }
    }
    let output = String::from_utf8(output).unwrap();
    assert_eq!(reported_child_cwd(&output).unwrap(), home, "{output:?}");
    assert!(
        output.contains(&format!("profile-home:{override_home}")),
        "{output:?}"
    );
    assert!(service.catalog.projects().unwrap().is_empty());
}
