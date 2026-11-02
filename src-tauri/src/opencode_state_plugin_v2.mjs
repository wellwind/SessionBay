// OpenCode 2.2.0–2.2.5. Reviewed against the official 2.2.3 Promise API.
// Passive launch-local observer. Never inspect prompt, message or tool contents.
import childProcess from 'node:child_process'
import path from 'node:path'

const REGISTRY = Symbol.for('sessionbay.opencode.state.v2')
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
  state.controller?.abort()
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
  if (state.terminal) return state.terminal
  if (state.uncertain) return 'unknown'
  if (state.permissions.size) return 'awaitingPermission'
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
      state.client.session.get({ sessionID: session }, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Session metadata timeout')) }, TIMEOUT_MS)
      }),
    ])
    const info = result
    if (!info || info.id !== session ||
        !safePath(info.location?.directory) || path.resolve(info.location.directory) !== state.directory) {
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
    state.terminal = null
    state.uncertain = false
    state.permissions.clear()
    await publish(state)
  }
  return true
}

const TYPES = ['session.status', 'session.deleted', 'permission.asked', 'permission.replied',
  'session.execution.started', 'session.execution.succeeded',
  'session.execution.failed', 'session.execution.interrupted', 'session.retry.scheduled',
  'session.step.started', 'session.step.streamed']

function metadata(event) {
  const type = event?.type
  if (!TYPES.includes(type)) return null
  const p = event.data
  // The v2 native envelope is { type, data }. Retain scalar metadata only.
  return {
    type, validEnvelope: p !== null && typeof p === 'object',
    session: p?.sessionID,
    status: type === 'session.status' ? p?.status?.type : undefined,
    request: type.endsWith('.asked') ? p?.id : p?.requestID,
  }
}

async function reduce(state, event) {
  if (event.session !== state.root) return
  if (event.type === 'session.deleted') {
    state.terminal = null
    state.uncertain = true
    await publish(state)
    state.root = null
    return
  }
  if (['session.retry.scheduled', 'session.step.started', 'session.step.streamed'].includes(event.type)) {
    state.status = event.type === 'session.retry.scheduled' ? 'retry' : 'busy'
    state.terminal = null
    state.uncertain = false
  } else if (event.type.startsWith('session.execution.')) {
    const outcome = event.type.slice('session.execution.'.length)
    state.permissions.clear()
    state.terminal = ['failed', 'interrupted'].includes(outcome) ? outcome : null
    state.status = outcome === 'started' ? 'busy' : 'idle'
    state.uncertain = false
  } else if (event.type === 'session.status') {
    if (!['busy', 'retry', 'idle'].includes(event.status)) throw new Error('Unknown native status')
    state.status = event.status
    // A generic idle following a failed/interrupted execution keeps its outcome.
    if (event.status !== 'idle') state.terminal = null
    if (event.status !== 'idle') state.uncertain = false
    else {
      state.permissions.clear()
    }
  } else {
    if (!identifier(event.request)) throw new Error('Invalid pending request identity')
    const pending = state.permissions
    if (event.type.endsWith('.asked')) {
      if (pending.size >= MAX_PENDING && !pending.has(event.request)) throw new Error('Pending request limit')
      pending.add(event.request)
    } else {
      pending.delete(event.request)
    }
  }
  await publish(state)
}

export default {
  id: 'sessionbay.launch-state.v2',
  async setup(input) {
    const env = process.env
    const launch = env.SESSIONBAY_HOOK_LAUNCH
    const helper = env.SESSIONBAY_OPENCODE_STATE_HELPER
    const directory = env.SESSIONBAY_OPENCODE_STATE_DIRECTORY
    const expected = env.SESSIONBAY_OPENCODE_STATE_SESSION || undefined
    if (!identifier(launch) || !safePath(helper) || !safePath(directory) ||
        !safePath(input?.location?.directory) || path.resolve(input.location.directory) !== path.resolve(directory) ||
        typeof input?.session?.get !== 'function' || typeof input?.session?.hook !== 'function' ||
        typeof input?.event?.subscribe !== 'function' ||
        (expected !== undefined && !identifier(expected))) return
    const registry = globalThis[REGISTRY] ??= new Map()
    if (registry.has(launch)) return
    const state = {
      helper, directory: path.resolve(directory), client: input,
      queue: Promise.resolve(), pending: 0, sequence: 0, disabled: false, workAt: 0,
      root: null, roots: new Set(), status: 'unknown', terminal: null, uncertain: false,
      permissions: new Set(), snapshot: null, timer: null,
      controller: new AbortController(),
    }
    registry.set(launch, state)
    let hook
    try {
      // Register the stream before lookup/hook work, so native transitions queue
      // behind root verification. Only a causal prompt hook may bind a new root.
      const stream = input.event.subscribe({ types: TYPES, signal: state.controller.signal })
      const consume = async () => {
        try {
          for await (const event of stream) {
            if (state.disabled) break
            const record = metadata(event)
            if (!record) continue
            if (!record.validEnvelope || !identifier(record.session)) {
              disable(state)
              break
            }
            enqueue(state, () => reduce(state, record))
          }
        } catch { /* A lost subscription expires continuity. */ }
        disable(state)
      }
      void consume()
      if (expected !== undefined) enqueue(state, async () => {
        if (!await bind(state, expected)) throw new Error('Resume session is not a root')
      })
      hook = await input.session.hook('prompt', event => {
        const session = event?.sessionID
        if (!identifier(session)) { disable(state); return }
        enqueue(state, () => bind(state, session))
      })
    } catch {
      disable(state)
    }
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      disable(state)
      await hook?.dispose()
    }
  },
}
