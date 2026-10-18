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

export function register(on) {
  let helper
  let initialized = false
  let sequence = 0
  let snapshot = null
  let timer = null
  let disabled = false
  let queue = Promise.resolve()
  const seen = new Set()
  const ended = new Set()

  // Enqueue before the first await: source callback order, not subprocess exit
  // order, determines state transitions. A failed reporter never blocks Claude.
  function ordered(work) {
    const result = queue.then(work)
    queue = result.catch(() => {
      // A lost source transition breaks continuity. Stop all refreshes so the
      // broker lease expires, rather than continuing to assert stale activity.
      disabled = true
      snapshot = null
      cancelTimer()
    })
    return queue
  }

  async function initialize($) {
    if (initialized) return
    helper = await $.env.get('SESSIONBAY_CLAUDE_STATE_HELPER')
    const previous = await $.env.get('SESSIONBAY_CLAUDE_STATE_SEQUENCE')
    sequence = previous === undefined ? 0 : Number(previous)
    if (typeof helper !== 'string' || !helper.startsWith('/') ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(helper) ||
        !Number.isSafeInteger(sequence) || sequence < 0) {
      disabled = true
    }
    initialized = true
  }

  async function emit($, value) {
    if (disabled || !value || sequence >= Number.MAX_SAFE_INTEGER) return
    sequence += 1
    // Environment is process-local, survives a module reload, and is inherited
    // by the helper. No token or state is written into the plugin files.
    await $.env.set('SESSIONBAY_CLAUDE_STATE_SEQUENCE', String(sequence))
    const result = await $.process.run([helper, '--sessionbay-provider-state'], {
      stdin: JSON.stringify({ ...value, sequence }),
      timeoutMs: 1000,
    })
    if (result.exitCode !== 0) throw new Error('State reporter unavailable')
  }

  function cancelTimer() {
    if (timer) {
      try { timer.cancel() } catch { /* Reporting must never change next(e). */ }
    }
    timer = null
  }

  function startTimer($) {
    if (timer || disabled) return
    timer = $.clock.every(INTERVAL_MS, () => ordered(async () => {
      if (!snapshot || disabled) return
      const currentSession = await $.session.id()
      if (currentSession !== snapshot.session) {
        // A missed session boundary cannot carry working into another session.
        const old = snapshot
        snapshot = null
        cancelTimer()
        await emit($, { session: old.session, turn: old.turn, observation: 'unknown' })
        return
      }
      // This repeats event-maintained provider state, not process liveness.
      await emit($, snapshot)
    }))
  }

  on('session.start', async ($, e, next) => {
    await ordered(async () => {
      await initialize($)
      // Initial load/reload never asserts idle or restores a previous turn.
      if (!snapshot) {
        const session = await $.session.id()
        if (identifier(session)) await emit($, { session, turn: null, observation: 'unknown' })
      }
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await ordered(async () => {
      await initialize($)
      if (disabled || e.agentId !== undefined || !identifier(e.turnId)) return
      const session = await $.session.id()
      if (!identifier(session) || ended.has(session)) return
      const identity = session + '\u0000' + e.turnId
      if (seen.has(identity)) return
      if (seen.size >= MAX_TURNS) {
        snapshot = null
        cancelTimer()
        await emit($, { session, turn: e.turnId, observation: 'unknown' })
        disabled = true
        return
      }
      seen.add(identity)
      snapshot = { session, turn: e.turnId, observation: 'busy' }
      startTimer($)
      await emit($, snapshot)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await ordered(async () => {
      if (disabled || e.agentId !== undefined || !snapshot ||
          snapshot.observation !== 'busy' || snapshot.turn !== e.turnId) return
      // Keep the session captured at turn.start; a late completion must not be
      // associated with whichever session happens to be visible at delivery.
      const observation = e.reason === 'answer' && e.isAborted === false ? 'idle'
        : e.reason === 'aborted' && e.isAborted === true ? 'interrupted'
        : (e.reason === 'error' || e.reason === 'refusal') && e.isAborted === false ? 'failed'
        : 'unknown'
      snapshot = { ...snapshot, observation }
      await emit($, snapshot)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await ordered(async () => {
      await initialize($)
      if (!identifier(e.sessionId)) return
      if (ended.size >= MAX_TURNS && !ended.has(e.sessionId)) {
        snapshot = null
        cancelTimer()
        await emit($, { session: e.sessionId, turn: null, observation: 'unknown' })
        disabled = true
        return
      }
      ended.add(e.sessionId)
      if (snapshot && snapshot.session !== e.sessionId) return
      const turn = snapshot ? snapshot.turn : null
      snapshot = null
      cancelTimer()
      await emit($, { session: e.sessionId, turn, observation: 'unknown' })
    })
    return next(e)
  })
}
