import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from './claude_state_mod.js'

function harness(options = {}) {
  const hooks = new Map()
  const reports = []
  const timers = []
  const env = options.env ?? new Map([
    ['SESSIONBAY_CLAUDE_STATE_HELPER', '/synthetic helper/sessionbay'],
    ['SESSIONBAY_CLAUDE_STATE_SEQUENCE', '0'],
  ])
  let session = 'main-session'
  const $ = {
    env: { get: async key => env.get(key), set: async (key, value) => { env.set(key, value) } },
    session: { id: async () => session },
    clock: { every: (ms, fn) => {
      assert.equal(ms, 5000)
      const timer = { fn, cancelled: false, cancel() { this.cancelled = true } }
      timers.push(timer)
      return timer
    } },
    process: { run: async (argv, init) => {
      assert.deepEqual(argv, ['/synthetic helper/sessionbay', '--sessionbay-provider-state'])
      assert.equal(init.timeoutMs, 1000)
      const report = JSON.parse(init.stdin)
      assert.deepEqual(Object.keys(report).sort(), ['observation', 'sequence', 'session', 'turn'])
      reports.push(report)
      if (options.run) await options.run(report)
      return { exitCode: 0, stdout: '{}', stderr: '' }
    } },
  }
  register((event, handler) => {
    assert(!hooks.has(event))
    hooks.set(event, handler)
  })
  return {
    $, env, reports, timers,
    setSession(value) { session = value },
    async fire(event, payload = {}) {
      const answer = { original: event }
      let calls = 0
      const actual = await hooks.get(event)($, payload, received => {
        assert.strictEqual(received, payload)
        calls += 1
        return answer
      })
      assert.equal(calls, 1, `${event} must call next exactly once`)
      assert.strictEqual(actual, answer)
    },
    async tick() {
      const active = timers.filter(timer => !timer.cancelled)
      for (const timer of active) await timer.fn()
    },
  }
}

const start = (h, turnId) => h.fire('turn.start', { turnId, text: 'PRIVATE PROMPT' })
const complete = (h, turnId, reason = 'answer', extra = {}) => h.fire('turn.complete', {
  turnId, reason, isAborted: reason === 'aborted', answer: 'PRIVATE ANSWER', ...extra,
})

test('startup stays unknown; snapshots follow authoritative turn state only', async () => {
  const h = harness()
  await h.fire('session.start')
  assert.deepEqual(h.reports.map(r => r.observation), ['unknown'])
  await h.tick()
  assert.equal(h.reports.length, 1)
  await start(h, 'turn-a')
  await h.tick()
  await complete(h, 'turn-a')
  await h.tick()
  assert.deepEqual(h.reports.map(r => r.observation), ['unknown', 'busy', 'busy', 'idle', 'idle'])
  assert.deepEqual(h.reports.map(r => r.sequence), [1, 2, 3, 4, 5])
  assert(!JSON.stringify(h.reports).includes('PRIVATE'))
})

test('old and child completions cannot clear a newer main turn', async () => {
  const h = harness()
  await start(h, 'turn-a')
  await start(h, 'turn-b')
  await complete(h, 'turn-a')
  await complete(h, 'turn-b', 'answer', { agentId: 'child' })
  await h.tick()
  assert.equal(h.reports.at(-1).turn, 'turn-b')
  assert.equal(h.reports.at(-1).observation, 'busy')
  await complete(h, 'turn-b')
  await start(h, 'turn-a')
  await start(h, 'turn-b')
  await h.tick()
  assert.equal(h.reports.at(-1).observation, 'idle')
})

test('aborts, refusals, failures and unknown reasons retain distinct truthful outcomes', async () => {
  const h = harness()
  for (const [reason, expected] of [['aborted', 'interrupted'], ['refusal', 'failed'], ['error', 'failed'], ['futureReason', 'unknown']]) {
    await start(h, reason)
    await complete(h, reason, reason)
    assert.equal(h.reports.at(-1).observation, expected)
  }
  await start(h, 'inconsistent')
  await complete(h, 'inconsistent', 'answer', { isAborted: true })
  assert.equal(h.reports.at(-1).observation, 'unknown')
})

test('session end stops refresh; clear continues only under a fresh session identity', async () => {
  const h = harness()
  await start(h, 'turn-a')
  await h.fire('session.end', { sessionId: 'main-session', reason: 'clear' })
  const endedCount = h.reports.length
  await h.tick()
  await complete(h, 'turn-a')
  await start(h, 'late-old-turn')
  assert.equal(h.reports.length, endedCount)
  h.setSession('new-session')
  await start(h, 'turn-b')
  await h.fire('session.end', { sessionId: 'main-session', reason: 'clear' })
  await h.tick()
  assert.deepEqual(h.reports.at(-1), { session: 'new-session', turn: 'turn-b', observation: 'busy', sequence: 4 })
})

test('a missed session boundary invalidates the old snapshot instead of renewing it', async () => {
  const h = harness()
  await start(h, 'turn-a')
  h.setSession('unexpected-session')
  await h.tick()
  assert.equal(h.reports.at(-1).observation, 'unknown')
  assert.equal(h.reports.at(-1).session, 'main-session')
  const count = h.reports.length
  await h.tick()
  assert.equal(h.reports.length, count)
})

test('source transitions are ordered even when helper delivery is delayed', async () => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const h = harness({ run: report => report.sequence === 1 ? barrier : Promise.resolve() })
  const first = start(h, 'turn-a')
  const done = complete(h, 'turn-a')
  const second = start(h, 'turn-b')
  await Promise.resolve()
  release()
  await Promise.all([first, done, second])
  assert.deepEqual(h.reports.map(r => [r.turn, r.observation, r.sequence]), [
    ['turn-a', 'busy', 1], ['turn-a', 'idle', 2], ['turn-b', 'busy', 3],
  ])
})

test('reporting failures preserve next and stop refreshes after lost continuity', async () => {
  const h = harness({ run: async () => { throw new Error('synthetic IPC unavailable') } })
  await h.fire('session.start')
  await start(h, 'turn-a')
  await complete(h, 'turn-a')
  await h.tick()
  assert.deepEqual(h.reports.map(r => r.observation), ['unknown'])
  assert.equal(h.timers.length, 0)
})

test('reload preserves source sequence and does not resurrect an unobserved turn', async () => {
  const first = harness()
  await start(first, 'turn-a')
  await first.tick()
  const reloaded = harness({ env: first.env })
  await reloaded.fire('session.start')
  await complete(reloaded, 'turn-a')
  await reloaded.tick()
  assert.deepEqual(reloaded.reports, [{ session: 'main-session', turn: null, observation: 'unknown', sequence: 3 }])
  await start(reloaded, 'turn-b')
  assert.equal(reloaded.reports.at(-1).sequence, 4)
})

test('invalid identifiers, child starts and unsafe helper paths are ignored', async () => {
  const h = harness()
  await start(h, '')
  await start(h, 'bad\nidentifier')
  await h.fire('turn.start', { turnId: 'child-turn', agentId: 'child' })
  assert.equal(h.reports.length, 0)
  const invalid = harness({ env: new Map([['SESSIONBAY_CLAUDE_STATE_HELPER', 'relative/helper']]) })
  await start(invalid, 'turn-a')
  assert.equal(invalid.reports.length, 0)
})

test('same module session.start is idempotent and does not reset working', async () => {
  const h = harness()
  await start(h, 'turn-a')
  await h.fire('session.start')
  await h.tick()
  assert.deepEqual(h.reports.map(r => r.observation), ['busy', 'busy'])
  assert.equal(h.timers.length, 1)
})

test('a sequence write failure on completion cannot keep renewing busy', async () => {
  const h = harness()
  await start(h, 'turn-a')
  h.$.env.set = async () => { throw new Error('synthetic env setter denied') }
  await complete(h, 'turn-a')
  await h.tick()
  await start(h, 'turn-b')
  assert.deepEqual(h.reports.map(r => r.observation), ['busy'])
  assert(h.timers.every(timer => timer.cancelled))
})

test('turn fence storage is bounded and exhaustion fails closed', async () => {
  const h = harness()
  for (let i = 0; i <= 4096; i += 1) await start(h, 'turn-' + i)
  assert.equal(h.reports.at(-1).observation, 'unknown')
  const count = h.reports.length
  await h.tick()
  await start(h, 'another-turn')
  assert.equal(h.reports.length, count)
})
