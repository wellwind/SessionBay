//! Opt-in ordered publishers over the existing owner-authenticated broker IPC.
//! No CLI hook installation and no causality inferred from callback arrival order.
use super::{lock, transport, Host, Request, Response, UiEvent};
use crate::{
    agent_activity::{self, ActivityTracker, Binding, Envelope, Observation, MAX_PAYLOAD_BYTES},
    models::AgentKind,
};
use interprocess::local_socket::tokio::Stream;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

pub(super) const MAX_ACTIVITY_FRAME: usize = MAX_PAYLOAD_BYTES * 4 + 4096;
const MAX_EVENTS_PER_SECOND: usize = 120;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Capability(String);
impl Capability {
    fn new() -> Self {
        Self(format!(
            "{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        ))
    }
    fn matches(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self
                .0
                .bytes()
                .zip(other.0.bytes())
                .fold(0, |diff, (a, b)| diff | (a ^ b))
                == 0
    }
}
impl fmt::Debug for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted activity capability]")
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cursor {
    pub generation: String,
    pub revision: u64,
}

pub(super) struct State {
    binding: Binding,
    capability: Option<Capability>,
    tracker: ActivityTracker,
    sequence: u64,
    revision: u64,
    visible: Option<Observation>,
    source_snapshot: Option<(Observation, Instant)>,
    recent: VecDeque<Instant>,
    terminal_mode: bool,
    terminal_status: Option<crate::terminal_status::Status>,
}
impl State {
    pub(super) fn new(
        runtime_id: &str,
        provider: AgentKind,
        session_id: &str,
    ) -> Result<Self, String> {
        let binding = Binding {
            runtime_id: runtime_id.into(),
            generation: Uuid::new_v4().to_string(),
            kind: provider,
            session_id: session_id.into(),
        };
        Ok(Self {
            tracker: ActivityTracker::new(binding.clone())?,
            binding,
            capability: Some(Capability::new()),
            sequence: 0,
            revision: 1,
            visible: None,
            source_snapshot: None,
            recent: VecDeque::new(),
            terminal_mode: false,
            terminal_status: None,
        })
    }
    pub(super) fn hook_generation(&self) -> &str {
        &self.binding.generation
    }
    pub(super) fn invalidate_hook_observation(&mut self) {
        self.tracker.invalidate();
        self.visible = None;
        self.advance();
    }
    pub(super) fn publish_hook(
        &mut self,
        event: &str,
        payload: &[u8],
        now: Instant,
    ) -> Result<(), String> {
        let capability = self
            .capability
            .as_ref()
            .ok_or("Hook generation retired")?
            .clone();
        self.publish(&capability, self.sequence + 1, event, payload, now)
    }
    pub(super) fn publish_terminal(&mut self, status: Option<crate::terminal_status::Status>) {
        self.tracker.invalidate();
        self.source_snapshot = None;
        self.visible = None;
        if !self.terminal_mode || self.terminal_status != status {
            self.terminal_mode = true;
            self.terminal_status = status;
            self.advance();
        }
    }
    pub(super) fn publish_source(&mut self, observation: Observation, now: Instant) {
        self.tracker.invalidate();
        self.source_snapshot = (observation != Observation::Unknown).then_some((observation, now));
        self.visible = self.source_snapshot.map(|(value, _)| value);
        self.advance();
    }
    fn snapshot(&self, now: Instant) -> Option<(Observation, Duration)> {
        if let Some((value, at)) = self.source_snapshot {
            let age = now.saturating_duration_since(at);
            return (age < agent_activity::OBSERVATION_TTL)
                .then(|| (value, agent_activity::OBSERVATION_TTL - age));
        }
        self.tracker.snapshot(now)
    }
    fn advance(&mut self) {
        // The final safe integer is reserved for a closed, unknown observation.
        if self.revision < MAX_SAFE_REVISION - 1 {
            self.revision += 1;
        } else {
            self.revision = MAX_SAFE_REVISION;
            self.capability = None;
            self.terminal_status = None;
            self.tracker.close();
            self.source_snapshot = None;
            self.visible = None;
        }
    }
    pub(super) fn process_exit(&mut self) {
        if self.terminal_mode
            && matches!(
                self.terminal_status,
                Some(crate::terminal_status::Status::Done | crate::terminal_status::Status::Error)
            )
        {
            if self.capability.take().is_some() {
                self.tracker.close();
                self.advance();
            }
        } else {
            self.close();
        }
    }
    fn close(&mut self) {
        if self.capability.take().is_some()
            || self.visible.is_some()
            || self.terminal_status.is_some()
        {
            self.terminal_status = None;
            self.tracker.close();
            self.source_snapshot = None;
            self.visible = None;
            self.advance();
        }
    }
    fn refresh(&mut self, now: Instant) {
        if self.visible.is_some() && self.snapshot(now).is_none() {
            self.visible = None;
            self.tracker.invalidate();
            self.advance();
        }
    }
    fn poll(&mut self, after: Option<&Cursor>, now: Instant) -> Option<UiEvent> {
        self.refresh(now);
        if after.is_some_and(|after| {
            after.generation == self.binding.generation && after.revision == self.revision
        }) {
            return None;
        }
        if self.terminal_mode {
            return Some(UiEvent::TerminalStatus {
                runtime_id: self.binding.runtime_id.clone(),
                generation: self.binding.generation.clone(),
                revision: self.revision,
                status: self.terminal_status,
            });
        }
        let snapshot = self.snapshot(now);
        Some(UiEvent::AgentActivity {
            runtime_id: self.binding.runtime_id.clone(),
            generation: self.binding.generation.clone(),
            revision: self.revision,
            observation: snapshot.map(|(observation, _)| observation),
            valid_for_ms: snapshot.map_or(0, |(_, remaining)| remaining.as_millis().max(1) as u64),
        })
    }
    fn publish(
        &mut self,
        capability: &Capability,
        sequence: u64,
        event: &str,
        payload: &[u8],
        now: Instant,
    ) -> Result<(), String> {
        if !self
            .capability
            .as_ref()
            .is_some_and(|expected| expected.matches(capability))
        {
            return Err("Invalid or retired activity capability".into());
        }
        let result = self.apply(sequence, event, payload, now);
        if result.is_err() {
            self.close();
        }
        result
    }
    fn apply(
        &mut self,
        sequence: u64,
        event: &str,
        payload: &[u8],
        now: Instant,
    ) -> Result<(), String> {
        if self.sequence.checked_add(1) != Some(sequence) {
            return Err("Activity sequence replay or gap; reopen the ordered bridge".into());
        }
        if event.is_empty()
            || event.len() > 512
            || event.chars().any(char::is_control)
            || payload.len() > MAX_PAYLOAD_BYTES
        {
            return Err("Invalid activity event or payload size".into());
        }
        while self
            .recent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Duration::from_secs(1))
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_EVENTS_PER_SECOND {
            return Err("Activity publisher rate limit exceeded".into());
        }
        self.recent.push_back(now);
        self.sequence = sequence;
        self.refresh(now);
        let normalized = agent_activity::normalize(self.binding.kind, event, payload)?;
        let changed = if let Some(event) = normalized {
            if event.session_id != self.binding.session_id {
                return Err("Activity provider session does not match its binding".into());
            }
            self.tracker.apply(
                Envelope {
                    binding: self.binding.clone(),
                    sequence,
                    event,
                },
                now,
            )
        } else {
            // Ignored children consume source sequence without changing parent freshness.
            self.tracker.skip(sequence);
            false
        };
        if changed {
            self.visible = self.tracker.observation(now);
            self.advance();
        } else if self.tracker.is_closed() {
            return Err("Activity generation closed; reopen the ordered bridge".into());
        } else if self.visible != self.tracker.observation(now) {
            self.visible = self.tracker.observation(now);
            self.advance();
        }
        Ok(())
    }
}
impl Host {
    fn activity_runtime_live(&self, runtime_id: &str) -> bool {
        self.runtime
            .list()
            .iter()
            .any(|info| info.id == runtime_id && info.state == "running")
    }
    fn open_activity_publisher(
        &self,
        broker_generation: &str,
        runtime_id: &str,
        provider: AgentKind,
        session_id: &str,
    ) -> Result<(Response, tokio::sync::OwnedSemaphorePermit), String> {
        if broker_generation != self.generation
            || self.shutdown.load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Activity broker generation is no longer live".into());
        }
        // Reject saturation before rotating an existing publisher's generation.
        let permit = Arc::clone(&self.activity_permits)
            .try_acquire_owned()
            .map_err(|_| "Too many ordered activity publishers")?;
        Ok((
            self.open_activity(runtime_id, provider, session_id)?,
            permit,
        ))
    }
    fn open_activity(
        &self,
        runtime_id: &str,
        provider: AgentKind,
        session_id: &str,
    ) -> Result<Response, String> {
        {
            let entries = lock(&self.entries);
            let entry = entries
                .get(runtime_id)
                .ok_or("Activity runtime not found")?;
            if entry.record.kind != provider.as_str() {
                return Err("Activity provider does not match the runtime kind".into());
            }
            // Manual resume IDs are provider IDs; catalog session IDs are not.
            if entry
                .record
                .resume_id
                .as_deref()
                .is_some_and(|known| known != session_id)
            {
                return Err("Activity provider session does not match the resumed runtime".into());
            }
        }
        let mut activity = lock(&self.activity);
        // Exit sets runtime state before the callback; this lock covers insertion.
        if !self.activity_runtime_live(runtime_id) {
            return Err("Activity requires a live running runtime".into());
        }
        let state = State::new(runtime_id, provider, session_id)?;
        let response = Response::ActivityOpened {
            activity_generation: state.binding.generation.clone(),
            capability: state.capability.as_ref().unwrap().clone(),
        };
        activity.insert(runtime_id.into(), state);
        Ok(response)
    }
    pub(super) fn revoke_provider_activity(&self, provider: AgentKind) {
        for state in lock(&self.activity)
            .values_mut()
            .filter(|state| state.binding.kind == provider)
        {
            state.close();
        }
    }
    pub(super) fn close_runtime_activity(&self, runtime_id: &str) {
        if let Some(state) = lock(&self.activity).get_mut(runtime_id) {
            state.close();
        }
    }
    fn close_activity(&self, runtime_id: &str, generation: &str) {
        if let Some(state) = lock(&self.activity)
            .get_mut(runtime_id)
            .filter(|state| state.binding.generation == generation)
        {
            state.close();
        }
    }
    pub(super) fn poll_activity(
        &self,
        runtime_id: &str,
        after: Option<&Cursor>,
        now: Instant,
    ) -> Option<UiEvent> {
        let mut activity = lock(&self.activity);
        let state = activity.get_mut(runtime_id)?;
        if !self.activity_runtime_live(runtime_id) {
            state.process_exit();
        }
        state.poll(after, now)
    }
    fn handle_activity(
        &self,
        request: Request,
        runtime_id: &str,
        generation: &str,
    ) -> Result<(Response, bool), String> {
        if self.shutdown.load(std::sync::atomic::Ordering::Acquire)
            || request.generation() != Some(self.generation.as_str())
        {
            return Err("Activity broker generation is no longer live".into());
        }
        let (request_runtime, request_generation, capability) = match &request {
            Request::PublishActivity {
                runtime_id,
                activity_generation,
                capability,
                ..
            }
            | Request::CloseActivity {
                runtime_id,
                activity_generation,
                capability,
                ..
            } => (runtime_id, activity_generation, capability),
            _ => {
                return Err(
                    "Only ordered activity messages are allowed on a publisher stream".into(),
                )
            }
        };
        if request_runtime != runtime_id || request_generation != generation {
            return Err("Activity stream binding mismatch".into());
        }
        let mut activity = lock(&self.activity);
        let state = activity
            .get_mut(runtime_id)
            .filter(|state| state.binding.generation == generation)
            .ok_or("Activity generation retired")?;
        if !self.activity_runtime_live(runtime_id) {
            state.close();
            return Err("Activity runtime has exited or is no longer running".into());
        }
        if !state
            .capability
            .as_ref()
            .is_some_and(|expected| expected.matches(capability))
        {
            return Err("Invalid or retired activity capability".into());
        }
        match request {
            Request::PublishActivity {
                capability,
                sequence,
                registered_event,
                payload,
                ..
            } => {
                state.publish(
                    &capability,
                    sequence,
                    &registered_event,
                    &payload,
                    Instant::now(),
                )?;
                Ok((Response::Ok, false))
            }
            Request::CloseActivity { .. } => {
                state.close();
                Ok((Response::Ok, true))
            }
            _ => unreachable!(),
        }
    }
}
struct PublisherLease {
    host: Arc<Host>,
    runtime_id: String,
    generation: String,
}
impl Drop for PublisherLease {
    fn drop(&mut self) {
        self.host.close_activity(&self.runtime_id, &self.generation);
    }
}
async fn reply(stream: &mut Stream, response: &Response) -> Result<(), String> {
    let bytes = serde_json::to_vec(response).map_err(|_| "Cannot encode activity response")?;
    tokio::time::timeout(
        transport::REQUEST_TIMEOUT,
        transport::write_frame(stream, &bytes),
    )
    .await
    .map_err(|_| "Activity response timed out")?
    .map_err(|error| error.to_string())
}
// Do not send Windows terminal replies to the process-global linger pool.
// The client closes after consuming its final ACK. An unreading or protocol-
// violating peer gets only a bounded drain before uncertain bytes are discarded.
async fn final_reply(stream: &mut Stream, response: &Response) -> Result<(), String> {
    reply(stream, response).await?;
    let _ = tokio::time::timeout(transport::REQUEST_TIMEOUT, stream.read_u8()).await;
    Ok(())
}
pub(super) async fn serve_publisher(
    stream: Stream,
    host: Arc<Host>,
    request: Request,
) -> Result<(), String> {
    let mut stream = transport::ActivityStream::new(stream);
    let Request::OpenOrderedActivity {
        generation,
        runtime_id,
        provider,
        session_id,
    } = request
    else {
        unreachable!()
    };
    // At most half the shared connection budget can become long-lived publishers.
    let (response, _permit) =
        match host.open_activity_publisher(&generation, &runtime_id, provider, &session_id) {
            Ok(opened) => opened,
            Err(message) => return final_reply(&mut stream, &Response::Error { message }).await,
        };
    let Response::ActivityOpened {
        activity_generation,
        ..
    } = &response
    else {
        unreachable!()
    };
    // Construct before write so response loss also revokes the lease.
    let lease = PublisherLease {
        host,
        runtime_id,
        generation: activity_generation.clone(),
    };
    reply(&mut stream, &response).await?;
    loop {
        let bytes = transport::read_activity_frame(&mut stream, MAX_ACTIVITY_FRAME)
            .await
            .map_err(|error| error.to_string())?;
        let live = lock(&lease.host.activity)
            .get(&lease.runtime_id)
            .is_some_and(|state| {
                state.binding.generation == lease.generation && state.capability.is_some()
            });
        if !live || !lease.host.activity_runtime_live(&lease.runtime_id) {
            return Err("Activity publisher generation is no longer live".into());
        }
        let Some(bytes) = bytes else { continue };
        let handled = serde_json::from_slice::<Request>(&bytes)
            .map_err(|_| "Invalid activity request".to_owned())
            .and_then(|request| {
                lease
                    .host
                    .handle_activity(request, &lease.runtime_id, &lease.generation)
            });
        let (response, done) = match handled {
            Ok(result) => result,
            Err(message) => {
                lease
                    .host
                    .close_activity(&lease.runtime_id, &lease.generation);
                (Response::Error { message }, true)
            }
        };
        if done {
            return final_reply(&mut stream, &response).await;
        }
        reply(&mut stream, &response).await?;
    }
}
#[cfg(test)]
mod tests;
