#![cfg(any(target_os = "linux", target_os = "macos"))]
//! Production binary callback → owner-authenticated IPC → broker → subscriber.
//! The provider driver is synthetic; real CLI acceptance is a separate native check.
use sessionbay_lib::{
    agent_activity::Observation,
    broker::{BrokerClient, UiEvent},
    models::AgentKind,
    provider_hooks::OPT_IN,
    runtime::LaunchSpec,
    service::LaunchRequest,
};
use std::{
    collections::HashMap,
    path::Path,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
struct Running {
    client: BrokerClient,
    id: String,
    lease: String,
    rx: mpsc::Receiver<UiEvent>,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.client.shutdown_broker();
    }
}
impl Running {
    fn observation(&self, expected: Option<Observation>) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("hook event deadline")
            {
                UiEvent::AgentActivity { observation, .. } if observation == expected => return,
                UiEvent::Output {
                    runtime_id,
                    sequence,
                    ..
                }
                | UiEvent::Snapshot {
                    runtime_id,
                    sequence,
                    ..
                } => self.client.ack(&runtime_id, sequence, &self.lease).unwrap(),
                UiEvent::Error { message, .. } | UiEvent::Disconnected { message, .. } => {
                    panic!("{message}")
                }
                _ => (),
            }
        }
    }
    fn unchanged_until_barrier(&self) {
        self.send("barrier");
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut output = String::new();
        loop {
            match self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap()
            {
                UiEvent::AgentActivity { observation, .. } => {
                    panic!("Unexpected stale callback observation: {observation:?}")
                }
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
                    self.client.ack(&runtime_id, sequence, &self.lease).unwrap();
                    output.push_str(&String::from_utf8_lossy(&data));
                    if output.contains("CALLBACKS_DRAINED") {
                        break;
                    }
                }
                _ => (),
            }
        }
    }
    fn send(&self, command: &str) {
        self.client
            .write(&self.id, &format!("{command}\n"))
            .unwrap();
    }
}
fn start(root: &Path) -> Running {
    start_mode(root, false)
}
fn start_mode(root: &Path, live: bool) -> Running {
    let script = root.join("synthetic_provider.py");
    std::fs::write(&script,r#"
import sys,json,subprocess,shlex,os
hooks=json.loads(sys.argv[sys.argv.index('--settings')+1])['hooks']
live='--plugin-dir' in sys.argv
if live:
    assert set(hooks)=={'Notification','PermissionRequest'}
    plugin=sys.argv[sys.argv.index('--plugin-dir')+1]
    assert os.path.isfile(os.path.join(plugin,'hooks','register.js'))
else:
    assert set(hooks)=={'SessionStart','UserPromptSubmit','PermissionRequest','Stop','SessionEnd','StopFailure','Notification'}
assert hooks['Notification'][0]['matcher']=='^(idle_prompt|permission_prompt|elicitation_dialog|elicitation_url_dialog)$'
helper=shlex.split(hooks['PermissionRequest'][0]['hooks'][0]['command'])[0]
def emit(event,turn=None,notification=None,session='synthetic-session',child=False):
    payload={'hook_event_name':event,'session_id':session,'prompt_id':turn,'notification_type':notification,'prompt':'SYNTHETIC_PRIVATE_PROMPT','transcript_path':'/never/read/this','source':'startup'}
    if child: payload['agent_id']='synthetic-child'
    # Unregistered events exercise the broker's live-mode allowlist.
    command=hooks[event][0]['hooks'][0]['command'] if event in hooks else shlex.join([helper,'--sessionbay-provider-hook',event])
    result=subprocess.run(command,shell=True,input=json.dumps(payload),text=True,capture_output=True,timeout=4)
    assert result.returncode==0 and result.stdout.strip()=='{}'
state_sequence=0
def state(observation,session='synthetic-session'):
    global state_sequence
    state_sequence+=1
    payload={'session':session,'turn':'live-turn','sequence':state_sequence,'observation':observation}
    result=subprocess.run([helper,'--sessionbay-provider-state'],input=json.dumps(payload),text=True,capture_output=True,timeout=4)
    assert result.returncode in (0,1) and result.stdout.strip()=='{}'
emit('SessionStart')
for line in sys.stdin:
    cmd=line.strip()
    if cmd=='busy': state('busy')
    elif cmd=='approval': state('awaitingPermission')
    elif cmd=='input': state('awaitingInput')
    elif cmd=='idle': state('idle')
    elif cmd=='unknown': state('unknown')
    elif cmd=='newroot': state('busy','new-root')
    elif cmd=='prompt': emit('UserPromptSubmit','turn-one')
    elif cmd=='permission': emit('PermissionRequest',None if live else 'turn-one')
    elif cmd=='stop': emit('Stop','turn-one')
    elif cmd=='wait': emit('Notification',None if live else 'turn-one','idle_prompt')
    elif cmd=='second': emit('UserPromptSubmit','turn-two')
    elif cmd=='stale': emit('Notification','turn-one','idle_prompt')
    elif cmd=='child': emit('Stop','turn-two',child=True)
    elif cmd=='wrong': emit('SessionEnd',session='wrong-session')
    elif cmd=='end': emit('SessionEnd')
    elif cmd=='clear':
        emit('SessionEnd')
        emit('SessionStart',session='second-session')
        emit('UserPromptSubmit','turn-new',session='second-session')
    elif cmd=='barrier': print('CALLBACKS_DRAINED',flush=True)
    elif cmd=='exit': break
"#).unwrap();
    let client =
        BrokerClient::connect(root, Path::new(env!("CARGO_BIN_EXE_sessionbay-broker"))).unwrap();
    let request = LaunchRequest {
        kanban_card_id: None,
        pane_id: "synthetic-pane".into(),
        kind: "claude".into(),
        project_id: None,
        session_id: None,
        resume_id: None,
        cwd: Some(root.to_string_lossy().into_owned()),
        profile_id: None,
        cols: 80,
        rows: 24,
    };
    let executable = root.join("synthetic-claude");
    std::fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.302 (Claude Code)'; exit; fi\nexec /usr/bin/python3 '{}' \"$@\"\n", script.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let spec = LaunchSpec {
        executable: executable.to_string_lossy().into_owned(),
        args: vec![],
        cwd: root.into(),
        env: HashMap::from([(OPT_IN.into(), if live { "live" } else { "1" }.into())]),
        session_id: None,
        resume_key: None,
        pane_id: request.pane_id.clone(),
    };
    let lease = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    let info = client
        .launch(
            spec,
            &request,
            lease.clone(),
            Arc::new(move |event| tx.send(event).map_err(|e| e.to_string())),
        )
        .unwrap();
    Running {
        client,
        id: info.id,
        lease,
        rx,
    }
}
#[test]
fn actual_callback_binary_reaches_subscriber_and_revocation_leaves_agent_alive() {
    let root = tempfile::tempdir().unwrap();
    let run = start(root.path());
    run.send("prompt");
    run.observation(Some(Observation::PromptSubmitted));
    run.send("permission");
    run.observation(Some(Observation::PermissionRequested));
    run.send("stop");
    run.observation(Some(Observation::TurnStopRequested));
    run.send("wait");
    run.observation(Some(Observation::WaitingInput));
    run.send("second");
    run.observation(Some(Observation::PromptSubmitted));
    run.send("stale");
    run.send("child");
    run.send("wrong");
    run.unchanged_until_barrier();
    run.client.revoke_provider_hooks(AgentKind::Claude).unwrap();
    run.observation(None);
    run.send("prompt");
    assert_eq!(run.client.list().unwrap()[0].info.state, "running");
    // No callback payload or launch capability is persisted in session metadata.
    let metadata =
        std::fs::read_to_string(root.path().join("runtime-broker-v1/sessions.json")).unwrap();
    assert!(
        !metadata.contains("SYNTHETIC_PRIVATE_PROMPT") && !metadata.contains("SESSIONBAY_HOOK")
    );
}
#[test]
fn session_end_is_observed_and_replayed_callbacks_cannot_reopen_it() {
    let root = tempfile::tempdir().unwrap();
    let run = start(root.path());
    run.send("prompt");
    run.observation(Some(Observation::PromptSubmitted));
    run.send("end");
    run.observation(Some(Observation::SessionEnded));
    run.send("second");
    run.client.stop(&run.id).unwrap();
    run.observation(None);
}

#[test]
fn clear_can_bind_a_new_session_without_restarting_the_process() {
    let root = tempfile::tempdir().unwrap();
    let run = start(root.path());
    run.send("prompt");
    run.observation(Some(Observation::PromptSubmitted));
    run.send("clear");
    run.observation(Some(Observation::PromptSubmitted));
    assert_eq!(run.client.list().unwrap()[0].info.state, "running");
}

#[test]
fn live_waiting_callbacks_and_state_reports_reach_subscriber_and_revoke_together() {
    let root = tempfile::tempdir().unwrap();
    let run = start_mode(root.path(), true);
    run.send("wait");
    run.observation(Some(Observation::WaitingInput));
    run.send("busy");
    run.observation(Some(Observation::Busy));
    run.send("permission");
    run.observation(Some(Observation::PermissionRequested));
    run.send("idle");
    run.observation(Some(Observation::Idle));
    run.send("busy");
    run.observation(Some(Observation::Busy));
    run.send("stop");
    run.send("wrong");
    run.unchanged_until_barrier();
    run.send("approval");
    run.observation(Some(Observation::AwaitingPermission));
    run.send("input");
    run.observation(Some(Observation::AwaitingInput));
    run.send("idle");
    run.observation(Some(Observation::Idle));
    run.send("unknown");
    run.observation(None);
    run.send("newroot");
    run.observation(Some(Observation::Busy));
    run.client.revoke_provider_hooks(AgentKind::Claude).unwrap();
    run.observation(None);
    run.send("busy");
    run.unchanged_until_barrier();
    assert_eq!(run.client.list().unwrap()[0].info.state, "running");
}
