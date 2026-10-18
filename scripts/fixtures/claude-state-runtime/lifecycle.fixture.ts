import { expect, mock, test } from 'claude-code/testing'

// The official binary loads the production module. All engine responses and
// external process calls are synthetic; no session, model or broker is started.
function setup(on) {
  const clock = mock.clock(on)
  const state = {
    session: 'synthetic-main',
    env: new Map([
      ['SESSIONBAY_CLAUDE_STATE_HELPER', '/synthetic/sessionbay'],
      ['SESSIONBAY_CLAUDE_STATE_SEQUENCE', '0'],
    ]),
    reports: [],
    forwarded: [],
    failProcess: false,
    failSequence: false,
  }
  on('session.id', () => ({ value: state.session }))
  on('env.get', ($, e) => ({ value: state.env.get(e.name) }))
  on('env.set', ($, e) => {
    if (state.failSequence) return { deny: 'synthetic environment failure' }
    state.env.set(e.name, e.value)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    expect(e.argv).toEqual(['/synthetic/sessionbay', '--sessionbay-provider-state'])
    expect(e.init.timeoutMs).toBe(1000)
    const report = JSON.parse(e.init.stdin)
    expect(Object.keys(report).sort()).toEqual(['observation', 'sequence', 'session', 'turn'])
    expect(e.init.stdin.includes('PRIVATE')).toBe(false)
    state.reports.push(report)
    return { value: { exitCode: state.failProcess ? 1 : 0, stdout: '{}', stderr: '' } }
  })
  on('session.start', ($, e) => {
    state.forwarded.push(['session.start', e])
    return { cwd: e.cwd }
  })
  on('turn.start', ($, e) => {
    state.forwarded.push(['turn.start', e])
    return { turnId: e.turnId }
  })
  on('turn.complete', ($, e) => {
    state.forwarded.push(['turn.complete', e])
    return { text: 'synthetic-next-result' }
  })
  on('session.end', ($, e) => {
    state.forwarded.push(['session.end', e])
    return { sessionId: e.sessionId }
  })
  return { state, clock }
}

function completion(turnId, reason = 'answer', extra = {}) {
  return { turnId, reason, isAborted: reason === 'aborted', answer: 'PRIVATE ANSWER',
    durationMs: 1, usage: null, ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}), ...extra }
}

function ending(sessionId) {
  return { sessionId, reason: 'clear', resume: { sessionId } }
}

test('native module startup, ordered busy, periodic snapshots and idle; next results survive', async ($, on) => {
  const { state, clock } = setup(on)
  expect(await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/synthetic' })).toEqual({ cwd: '/synthetic' })
  await clock.advance(5000)
  expect(state.reports.map(r => r.observation)).toEqual(['unknown'])
  expect(await $.turn.start({ turnId: 'a', text: 'PRIVATE PROMPT' })).toEqual({ turnId: 'a' })
  await clock.advance(5000)
  expect(await $.turn.complete(completion('a'))).toEqual({ text: 'synthetic-next-result' })
  await clock.advance(5000)
  expect(state.reports.map(r => r.observation)).toEqual(['unknown', 'busy', 'busy', 'idle', 'idle'])
  expect(state.reports.map(r => r.sequence)).toEqual([1, 2, 3, 4, 5])
  expect(state.forwarded.map(x => x[0])).toEqual(['session.start', 'turn.start', 'turn.complete'])
  expect(state.forwarded[1][1].text).toBe('PRIVATE PROMPT')
  expect(state.forwarded[2][1].answer).toBe('PRIVATE ANSWER')
})

test('late and child completions cannot replace the current main turn', async ($, on) => {
  const { state, clock } = setup(on)
  await $.turn.start({ turnId: 'old', text: '' })
  await $.turn.start({ turnId: 'new', text: '' })
  await $.turn.complete(completion('old'))
  await $.turn.complete(completion('new', 'answer', { agentId: 'synthetic-child' }))
  await clock.advance(5000)
  expect(state.reports.map(r => r.observation)).toEqual(['busy', 'busy', 'busy'])
  expect(state.reports.at(-1).turn).toBe('new')
  await $.turn.complete(completion('new'))
  await $.turn.start({ turnId: 'old', text: '' })
  expect(state.reports.at(-1).observation).toBe('idle')
  expect(state.forwarded.length).toBe(6)
})

test('native runtime distinguishes abort, refusal and API failure', async ($, on) => {
  const { state } = setup(on)
  for (const [reason, observation] of [['aborted', 'interrupted'], ['refusal', 'failed'], ['error', 'failed']]) {
    await $.turn.start({ turnId: reason, text: '' })
    await $.turn.complete(completion(reason, reason))
    expect(state.reports.at(-1).observation).toBe(observation)
  }
})

test('session end cancels stale refreshes and only a fresh root can restart', async ($, on) => {
  const { state, clock } = setup(on)
  await $.turn.start({ turnId: 'a', text: '' })
  expect(await $.session.end(ending(state.session))).toEqual({ sessionId: state.session })
  await clock.advance(10000)
  await $.turn.complete(completion('a'))
  await $.turn.start({ turnId: 'late', text: '' })
  expect(state.reports.map(r => r.observation)).toEqual(['busy', 'unknown'])
  state.session = 'synthetic-new'
  await $.turn.start({ turnId: 'b', text: '' })
  await $.session.end(ending('synthetic-main'))
  await clock.advance(5000)
  expect(state.reports.at(-1)).toEqual({ session: 'synthetic-new', turn: 'b', observation: 'busy', sequence: 4 })
})

test('unreported session change invalidates instead of refreshing stale busy', async ($, on) => {
  const { state, clock } = setup(on)
  await $.turn.start({ turnId: 'a', text: '' })
  state.session = 'synthetic-other'
  await clock.advance(5000)
  await clock.advance(10000)
  expect(state.reports.map(r => r.observation)).toEqual(['busy', 'unknown'])
})

test('helper failure does not change next and prevents renewed evidence', async ($, on) => {
  const { state, clock } = setup(on)
  await $.turn.start({ turnId: 'a', text: '' })
  state.failProcess = true
  expect(await $.turn.complete(completion('a'))).toEqual({ text: 'synthetic-next-result' })
  state.failProcess = false
  await clock.advance(10000)
  await $.turn.start({ turnId: 'b', text: '' })
  expect(state.reports.map(r => r.observation)).toEqual(['busy', 'idle'])
  expect(state.forwarded.length).toBe(3)
})

test('environment failure at completion stops busy snapshots', async ($, on) => {
  const { state, clock } = setup(on)
  await $.turn.start({ turnId: 'a', text: '' })
  state.failSequence = true
  await $.turn.complete(completion('a'))
  await clock.advance(10000)
  expect(state.reports.map(r => r.observation)).toEqual(['busy'])
  expect(state.forwarded.length).toBe(2)
})

test('initial source sequence is continued while startup stays unknown', async ($, on) => {
  const { state, clock } = setup(on)
  state.env.set('SESSIONBAY_CLAUDE_STATE_SEQUENCE', '17')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/synthetic' })
  await clock.advance(10000)
  expect(state.reports).toEqual([{ session: 'synthetic-main', turn: null, observation: 'unknown', sequence: 18 }])
})
