// Claude Code >= 2.1.287. This module observes the existing interactive turn;
// it never submits prompts, calls models, or changes a hook's result.
// Contract: https://code.claude.com/docs/en/plugins/mods/events#follow-a-turn
const INTERVAL_MS = 5000
const MAX_TURNS = 4096

function identifier(value) {
  return typeof value === 'string' && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

// Helpers receiving the engine handle must be declared at module scope so
// Claude can statically trace every API call. Never store $ in mutable state.
// Enqueue before the first await: source callback order, not subprocess exit
// order, determines state transitions. A failed reporter never blocks Claude.
function ordered(state, work) {
  const result = state.queue.then(work)
  state.queue = result.catch(() => {
    // A lost source transition breaks continuity. Stop all refreshes so the
    // broker lease expires, rather than continuing to assert stale activity.
    state.disabled = true
    state.snapshot = null
    cancelTimer(state)
  })
  return state.queue
}

async function initialize($, state) {
  if (state.initialized) return
  state.helper = await $.env.get('SESSIONBAY_CLAUDE_STATE_HELPER')
  const previous = await $.env.get('SESSIONBAY_CLAUDE_STATE_SEQUENCE')
  state.sequence = previous === undefined ? 0 : Number(previous)
  if (typeof state.helper !== 'string' || !state.helper.startsWith('/') ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(state.helper) ||
      !Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    state.disabled = true
  }
  state.initialized = true
}

async function emit($, state, value) {
  if (state.disabled || !value || state.sequence >= Number.MAX_SAFE_INTEGER) return
  state.sequence += 1
  // Environment is process-local, survives a module reload, and is inherited
  // by the helper. No token or state is written into the plugin files.
  await $.env.set('SESSIONBAY_CLAUDE_STATE_SEQUENCE', String(state.sequence))
  const result = await $.process.run([state.helper, '--sessionbay-provider-state'], {
    stdin: JSON.stringify({ ...value, sequence: state.sequence }),
    timeoutMs: 1000,
  })
  if (result.exitCode !== 0) throw new Error('State reporter unavailable')
}

function cancelTimer(state) {
  if (state.timer) {
    try { state.timer.cancel() } catch { /* Reporting must never change next(e). */ }
  }
  state.timer = null
}

function startTimer($, state) {
  if (state.timer || state.disabled) return
  state.timer = $.clock.every(INTERVAL_MS, () => ordered(state, async () => {
    if (!state.snapshot || state.disabled) return
    const currentSession = await $.session.id()
    if (currentSession !== state.snapshot.session) {
      // A missed session boundary cannot carry working into another session.
      const old = state.snapshot
      state.snapshot = null
      cancelTimer(state)
      await emit($, state, { session: old.session, turn: old.turn, observation: 'unknown' })
      return
    }
    // This repeats event-maintained provider state, not process liveness.
    await emit($, state, state.snapshot)
  }))
}

export function register(on) {
  const state = {
    helper: undefined,
    initialized: false,
    sequence: 0,
    snapshot: null,
    timer: null,
    disabled: false,
    queue: Promise.resolve(),
    seen: new Set(),
    ended: new Set(),
  }

  on('session.start', async ($, e, next) => {
    await ordered(state, async () => {
      await initialize($, state)
      // Initial load/reload never asserts idle or restores a previous turn.
      if (!state.snapshot) {
        const session = await $.session.id()
        if (identifier(session)) await emit($, state, { session, turn: null, observation: 'unknown' })
      }
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await ordered(state, async () => {
      await initialize($, state)
      if (state.disabled || e.agentId !== undefined || !identifier(e.turnId)) return
      const session = await $.session.id()
      if (!identifier(session) || state.ended.has(session)) return
      const identity = session + '\u0000' + e.turnId
      if (state.seen.has(identity)) return
      if (state.seen.size >= MAX_TURNS) {
        state.snapshot = null
        cancelTimer(state)
        await emit($, state, { session, turn: e.turnId, observation: 'unknown' })
        state.disabled = true
        return
      }
      state.seen.add(identity)
      state.snapshot = { session, turn: e.turnId, observation: 'busy' }
      startTimer($, state)
      await emit($, state, state.snapshot)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await ordered(state, async () => {
      if (state.disabled || e.agentId !== undefined || !state.snapshot ||
          state.snapshot.observation !== 'busy' || state.snapshot.turn !== e.turnId) return
      // Keep the session captured at turn.start; a late completion must not be
      // associated with whichever session happens to be visible at delivery.
      const observation = e.reason === 'answer' && e.isAborted === false ? 'idle'
        : e.reason === 'aborted' && e.isAborted === true ? 'interrupted'
        : (e.reason === 'error' || e.reason === 'refusal') && e.isAborted === false ? 'failed'
        : 'unknown'
      state.snapshot = { ...state.snapshot, observation }
      await emit($, state, state.snapshot)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await ordered(state, async () => {
      await initialize($, state)
      if (!identifier(e.sessionId)) return
      if (state.ended.size >= MAX_TURNS && !state.ended.has(e.sessionId)) {
        state.snapshot = null
        cancelTimer(state)
        await emit($, state, { session: e.sessionId, turn: null, observation: 'unknown' })
        state.disabled = true
        return
      }
      state.ended.add(e.sessionId)
      if (state.snapshot && state.snapshot.session !== e.sessionId) return
      const turn = state.snapshot ? state.snapshot.turn : null
      state.snapshot = null
      cancelTimer(state)
      await emit($, state, { session: e.sessionId, turn, observation: 'unknown' })
    })
    return next(e)
  })
}
