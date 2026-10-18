// OpenCode >=1.19.2,<2. Passive, launch-local plugin; no prompts or model calls.
// Official outward v1 plugin events use {type, properties}, even when the
// provider's internal event bus uses v2. Never inspect message/tool contents.
import childProcess from 'node:child_process'
import path from 'node:path'

const REGISTRY = Symbol.for('sessionbay.opencode.state.v1')
const INTERVAL_MS = 5000
const TIMEOUT_MS = 1000
const MAX_QUEUE_AGE_MS = 5000
const MAX_QUEUE = 128
const MAX_PENDING = 128
const MAX_ROOTS = 128

function identifier(value) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}
function safePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}
function stopTimer(state) {
  if (state.timer !== null) clearInterval(state.timer)
  state.timer = null
}
function disable(state) {
  state.disabled = true
  state.snapshot = null
  stopTimer(state)
}

function deliver(helper, report) {
  return new Promise((resolve, reject) => {
    let child
    let timer
    let ended = false
    const done = (error) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (error) {
        try { child?.kill('SIGKILL') } catch { /* Best-effort child cleanup. */ }
        reject(error)
      } else resolve()
    }
    try {
      child = childProcess.spawn(helper, ['--sessionbay-provider-state'], {
        shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      })
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        done(new Error('State reporter timeout'))
      }, TIMEOUT_MS)
      child.once('error', () => done(new Error('State reporter unavailable')))
      child.once('exit', (code) => done(code === 0 ? null : new Error('State reporter failed')))
      child.stdin.once('error', () => done(new Error('State reporter pipe unavailable')))
      child.stdin.end(JSON.stringify(report))
    } catch {
      if (child) child.kill('SIGKILL')
      done(new Error('State reporter unavailable'))
    }
  })
}

async function emit(state, observation) {
  if (state.disabled || !state.root) return
  if (performance.now() - state.workAt > MAX_QUEUE_AGE_MS) throw new Error('Stale source event')
  if (state.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('State sequence exhausted')
  state.sequence += 1
  // One queue and sequence per launch, shared by all plugin initializations.
  // Routing credentials stay inherited in memory; staging files contain none.
  await deliver(state.helper, {
    session: state.root, turn: null, observation, sequence: state.sequence,
  })
}

function current(state) {
  if (state.uncertain) return 'unknown'
  if (state.permissions.size) return 'awaitingPermission'
  if (state.questions.size) return 'awaitingInput'
  return state.status
}
async function publish(state) {
  const observation = current(state)
  state.snapshot = observation === 'unknown' ? null : observation
  await emit(state, observation)
  if (state.snapshot && state.timer === null && !state.disabled) {
    state.timer = setInterval(() => enqueue(state, async () => {
      // Refresh only the continuously observed provider state, never liveness.
      if (state.snapshot !== null) await emit(state, state.snapshot)
    }), INTERVAL_MS)
    state.timer.unref?.()
  } else if (state.snapshot === null) stopTimer(state)
}

function enqueue(state, work) {
  if (state.disabled) return
  if (state.pending >= MAX_QUEUE) {
    // Dropping any transition loses continuity. Already queued work checks this
    // flag before sending, and no heartbeat can prolong the stale broker lease.
    disable(state)
    return
  }
  const receivedAt = performance.now()
  state.pending += 1
  state.queue = state.queue.then(async () => {
    if (state.disabled) return
    // Queue length alone does not bound freshness: slow successful deliveries
    // must not replay old Busy/wait as a newly leased broker snapshot.
    if (performance.now() - receivedAt > MAX_QUEUE_AGE_MS) throw new Error('Source queue lag')
    state.workAt = receivedAt
    await work()
  }).catch(() => disable(state)).finally(() => { state.pending -= 1 })
}

async function rootInfo(state, session) {
  const controller = new AbortController()
  let timer
  try {
    // Both a deadline and AbortSignal are needed: an SDK/custom fetch which
    // ignores cancellation still must not hold the ordered source forever.
    const result = await Promise.race([
      state.client.session.get({ path: { id: session }, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Session metadata timeout')) }, TIMEOUT_MS)
      }),
    ])
    const info = result?.data
    if (result?.error || !info || info.id !== session ||
        typeof info.directory !== 'string' || path.resolve(info.directory) !== state.directory) {
      throw new Error('Session ancestry unavailable')
    }
    // Absence is the documented root shape. Null/invalid ancestry is ambiguous.
    return info.parentID === undefined
  } finally {
    clearTimeout(timer)
  }
}

async function bind(state, session) {
  if (!identifier(session)) throw new Error('Invalid session identity')
  if (!await rootInfo(state, session)) return false
  if (state.root !== session) {
    if (state.roots.size >= MAX_ROOTS && !state.roots.has(session)) throw new Error('Root limit')
    state.roots.add(session)
    state.root = session
    state.status = 'unknown'
    state.uncertain = false
    state.permissions.clear()
    state.questions.clear()
    await publish(state)
  }
  return true
}

function metadata(event) {
  const type = event?.type
  if (!['session.status', 'session.error', 'session.deleted', 'permission.asked',
    'permission.replied', 'question.asked', 'question.replied', 'question.rejected'].includes(type)) return null
  const p = event.properties
  // Copy only allowlisted scalar metadata synchronously. Never retain an event,
  // question text, tool inputs, error message, transcript, title, or path.
  return {
    type,
    validEnvelope: p !== null && typeof p === 'object',
    session: type === 'session.deleted' ? p?.info?.id : p?.sessionID,
    status: type === 'session.status' ? p?.status?.type : undefined,
    request: type.endsWith('.asked') ? p?.id : p?.requestID,
  }
}

async function reduce(state, event) {
  if (event.session !== state.root) return
  if (event.type === 'session.deleted') {
    state.uncertain = true
    await publish(state)
    state.root = null
    return
  }
  if (event.type === 'session.error') {
    // This event also covers recoverable preparation errors; it is not a
    // terminal failure contract. Do not turn a subsequent idle into success.
    state.uncertain = true
  } else if (event.type === 'session.status') {
    if (!['busy', 'retry', 'idle'].includes(event.status)) throw new Error('Unknown native status')
    state.status = event.status
    if (event.status !== 'idle') state.uncertain = false
    else {
      state.permissions.clear()
      state.questions.clear()
    }
  } else {
    if (!identifier(event.request)) throw new Error('Invalid pending request identity')
    const pending = event.type.startsWith('permission.') ? state.permissions : state.questions
    if (event.type.endsWith('.asked')) {
      if (pending.size >= MAX_PENDING && !pending.has(event.request)) throw new Error('Pending request limit')
      pending.add(event.request)
    } else {
      pending.delete(event.request)
    }
  }
  await publish(state)
}

export default async function SessionBayState(input) {
  const env = process.env
  const launch = env.SESSIONBAY_HOOK_LAUNCH
  const helper = env.SESSIONBAY_OPENCODE_STATE_HELPER
  const directory = env.SESSIONBAY_OPENCODE_STATE_DIRECTORY
  const expected = env.SESSIONBAY_OPENCODE_STATE_SESSION || undefined
  if (!identifier(launch) || !safePath(helper) || !safePath(directory) ||
      !safePath(input?.directory) || path.resolve(input.directory) !== path.resolve(directory) ||
      typeof input?.client?.session?.get !== 'function' ||
      (expected !== undefined && !identifier(expected))) return {}
  const registry = globalThis[REGISTRY] ??= new Map()
  // A second InstanceContext/reload cannot restart sequence 1 or install a
  // second timer. Disposed sources are tombstoned until the process exits.
  if (registry.has(launch)) return {}
  const state = {
    helper, directory: path.resolve(directory), client: input.client,
    queue: Promise.resolve(), pending: 0, sequence: 0, disabled: false, workAt: 0,
    root: null, roots: new Set(), status: 'unknown', uncertain: false,
    permissions: new Set(), questions: new Set(), snapshot: null, timer: null,
  }
  registry.set(launch, state)
  if (expected !== undefined) enqueue(state, async () => {
    if (!await bind(state, expected)) throw new Error('Resume session is not a root')
  })
  return {
    // These callbacks never await subprocesses or mutate the provider's hook
    // output. Order is captured synchronously before returning to OpenCode.
    'chat.message': async (input) => {
      const session = input?.sessionID
      if (!identifier(session)) {
        disable(state)
        return
      }
      enqueue(state, () => bind(state, session))
    },
    event: async ({ event } = {}) => {
      const record = metadata(event)
      if (!record) return
      if (!record.validEnvelope || !identifier(record.session)) {
        // Only the documented unscoped error is harmless. A changed envelope
        // or malformed lifecycle identity loses continuity and must expire.
        if (record.validEnvelope && record.type === 'session.error' && record.session === undefined) return
        enqueue(state, async () => { throw new Error('Unknown native event schema') })
        return
      }
      enqueue(state, () => reduce(state, record))
    },
    dispose: async () => {
      // Dispose runs on instance shutdown/reload, including while work is in
      // flight. Stop refreshes immediately; the broker TTL is the final fence.
      disable(state)
    },
  }
}
