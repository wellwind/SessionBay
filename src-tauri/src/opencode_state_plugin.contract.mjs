import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import SessionBayState from './opencode_state_plugin.mjs'

const REGISTRY = Symbol.for('sessionbay.opencode.state.v1')
async function harness(t, options = {}) {
  const env = { ...process.env }
  const launch = randomUUID()
  const reports = []
  const timers = new Set()
  const reads = []
  let kills = 0
  const originalPerformance = globalThis.performance
  if (options.now) globalThis.performance = { now: options.now }
  const originalSpawn = childProcess.spawn
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const sessions = new Map([
    ['ses_root', { id: 'ses_root', directory: '/synthetic project' }],
    ['ses_other', { id: 'ses_other', directory: '/synthetic project' }],
    ['ses_child', { id: 'ses_child', parentID: 'ses_root', directory: '/synthetic project' }],
  ])
  process.env.SESSIONBAY_HOOK_LAUNCH = launch
  process.env.SESSIONBAY_OPENCODE_STATE_HELPER = options.helper ?? '/synthetic helper/sessionbay'
  process.env.SESSIONBAY_OPENCODE_STATE_DIRECTORY = '/synthetic project'
  delete process.env.SESSIONBAY_OPENCODE_STATE_SESSION
  if (options.resume !== undefined) process.env.SESSIONBAY_OPENCODE_STATE_SESSION = options.resume
  globalThis.setInterval = (fn, delay) => {
    assert.equal(delay, 5000)
    const timer = { fn, unref() {} }
    timers.add(timer)
    return timer
  }
  globalThis.clearInterval = timer => timers.delete(timer)
  if (!options.realHelper) childProcess.spawn = (helper, args, init) => {
    assert.equal(helper, '/synthetic helper/sessionbay')
    assert.deepEqual(args, ['--sessionbay-provider-state'])
    assert.deepEqual(init, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    const child = new EventEmitter()
    child.kill = () => { kills += 1; return true }
    child.stdin = new EventEmitter()
    child.stdin.end = payload => {
      const report = JSON.parse(payload)
      assert.deepEqual(Object.keys(report).sort(), ['observation', 'sequence', 'session', 'turn'])
      reports.push(report)
      if (options.pipeError) queueMicrotask(() => child.stdin.emit('error', new Error('EPIPE')))
      else if (!options.hang) Promise.resolve(options.deliver?.(report)).then(
        () => child.emit('exit', options.exitCode ?? 0),
        () => child.emit('error', new Error('synthetic unavailable')),
      )
    }
    return child
  }
  const input = { directory: '/synthetic project', client: { session: { get: async args => {
    assert.equal(args.path && Object.keys(args.path).length, 1)
    assert(args.signal instanceof AbortSignal)
    reads.push(args.path.id)
    if (options.lookup) return options.lookup(args, sessions)
    return { data: sessions.get(args.path.id) }
  } } } }
  const hooks = await SessionBayState(input)
  const state = globalThis[REGISTRY].get(launch)
  t.after(async () => {
    await hooks.dispose?.()
    globalThis.performance = originalPerformance
    childProcess.spawn = originalSpawn
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
    globalThis[REGISTRY].delete(launch)
  })
  return {
    hooks, state, reports, reads, sessions, timers, input, launch,
    kills: () => kills,
    flush: () => state.queue,
    async chat(session = 'ses_root') {
      const output = { message: { text: 'PRIVATE PROMPT' }, parts: [{ text: 'PRIVATE PART' }] }
      await hooks['chat.message']({ sessionID: session }, output)
      assert.equal(output.message.text, 'PRIVATE PROMPT')
    },
    async event(type, properties) {
      await hooks.event({ event: { type, properties } })
    },
    async status(status, session = 'ses_root') {
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: session, status: { type: status } } } })
    },
    async tick() { await state.queue; for (const timer of [...timers]) timer.fn(); await state.queue },
  }
}
const observations = h => h.reports.map(r => r.observation)

test('new launch binds only an ancestry-verified chat root, never first event or history', async t => {
  const h = await harness(t)
  await h.status('busy', 'ses_other')
  await h.event('session.created', { info: { id: 'ses_other' } })
  await h.chat('ses_child')
  await h.status('busy', 'ses_child')
  await h.flush()
  assert.equal(h.reports.length, 0)
  assert.deepEqual(h.reads, ['ses_child'])
  await h.chat()
  await h.status('busy')
  await h.tick()
  await h.status('idle')
  await h.flush()
  assert.deepEqual(observations(h), ['unknown', 'busy', 'busy', 'idle'])
  assert(h.reports.every(r => r.session === 'ses_root' && r.turn === null))
  assert(!JSON.stringify(h.reports).includes('PRIVATE'))
})

test('exact resume verifies native root metadata and starts unknown', async t => {
  const h = await harness(t, { resume: 'ses_root' })
  await h.flush()
  assert.deepEqual(h.reads, ['ses_root'])
  assert.deepEqual(observations(h), ['unknown'])
  await h.tick()
  assert.equal(h.reports.length, 1)
  await h.status('retry')
  await h.tick()
  assert.deepEqual(observations(h), ['unknown', 'retry', 'retry'])
})

for (const [name, lookup] of [
  ['missing ancestry', () => ({ data: undefined })],
  ['wrong returned session', () => ({ data: { id: 'ses_other', directory: '/synthetic project' } })],
  ['different directory', () => ({ data: { id: 'ses_root', directory: '/other' } })],
  ['ambiguous parent', () => ({ data: { id: 'ses_root', directory: '/synthetic project', parentID: null } })],
  ['child resume', () => ({ data: { id: 'ses_root', directory: '/synthetic project', parentID: 'ses_parent' } })],
]) test(`resume fails closed for ${name}`, async t => {
  const h = await harness(t, { resume: 'ses_root', lookup })
  await h.flush()
  await h.status('busy')
  await h.tick()
  assert.equal(h.reports.length, 0)
  assert(h.state.disabled)
})

test('multiple pending permission/question IDs survive unrelated and partial replies', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  for (const id of ['per_a', 'per_b']) await h.event('permission.asked', { sessionID: 'ses_root', id, patterns: ['PRIVATE PATH'] })
  await h.event('question.asked', { sessionID: 'ses_root', id: 'que_a', questions: ['PRIVATE QUESTION'] })
  await h.event('permission.replied', { sessionID: 'ses_child', requestID: 'per_a' })
  await h.event('permission.replied', { sessionID: 'ses_root', requestID: 'per_a' })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'awaitingPermission')
  await h.event('permission.replied', { sessionID: 'ses_root', requestID: 'per_b' })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'awaitingInput')
  await h.event('question.rejected', { sessionID: 'ses_root', requestID: 'que_a', answers: ['PRIVATE ANSWER'] })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'busy')
  assert(!JSON.stringify(h.reports).includes('PRIVATE'))
})

test('root rotation requires a new causal chat; old and child statuses cannot overwrite it', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.status('idle', 'ses_other')
  await h.chat('ses_other')
  await h.status('busy', 'ses_other')
  await h.status('idle')
  await h.status('idle', 'ses_child')
  await h.flush()
  assert.deepEqual(h.reports.map(r => [r.session, r.observation]), [
    ['ses_root', 'unknown'], ['ses_root', 'busy'], ['ses_other', 'unknown'], ['ses_other', 'busy'],
  ])
  await h.chat('ses_root')
  await h.status('busy')
  await h.flush()
  assert.equal(h.reports.at(-1).session, 'ses_root', 'explicit chat may activate a previous root')
})

test('root error is uncertain, idle cannot claim success, fresh native work restores state', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.event('session.error', { error: { message: 'unscoped PRIVATE ERROR' } })
  await h.event('session.error', { sessionID: 'ses_child', error: { message: 'child PRIVATE ERROR' } })
  await h.event('session.error', { sessionID: 'ses_root', error: { message: 'PRIVATE ERROR' } })
  await h.status('idle')
  await h.flush()
  assert.deepEqual(observations(h), ['unknown', 'busy', 'unknown', 'unknown'])
  assert.equal(h.timers.size, 0)
  await h.status('busy')
  await h.status('idle')
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'idle')
})

test('session deletion invalidates and stale statuses cannot rebind', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.event('session.deleted', { info: { id: 'ses_root' } })
  await h.status('busy')
  await h.tick()
  assert.deepEqual(observations(h), ['unknown', 'busy', 'unknown'])
  assert.equal(h.timers.size, 0)
})

test('same-launch initialization cannot create another source, timer or sequence', async t => {
  const h = await harness(t)
  assert.deepEqual(await SessionBayState(h.input), {})
  assert.deepEqual(await SessionBayState({ ...h.input, directory: '/other' }), {})
  await h.chat()
  await h.status('busy')
  await h.tick()
  assert.equal(h.timers.size, 1)
  assert.deepEqual(h.reports.map(r => r.sequence), [1, 2, 3])
  await h.hooks.dispose()
  assert.deepEqual(await SessionBayState(h.input), {}, 'reload cannot revive a lost continuity epoch')
  await h.tick()
  assert.equal(h.timers.size, 0)
})

test('callback order survives delayed delivery; observation never stalls the provider hook', async t => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const h = await harness(t, { deliver: report => report.sequence === 1 ? barrier : undefined })
  await h.chat()
  await h.status('busy')
  await h.status('idle')
  // The three hooks returned before their first reporter subprocess completed.
  release()
  await h.flush()
  assert.deepEqual(observations(h), ['unknown', 'busy', 'idle'])
  assert.deepEqual(h.reports.map(r => r.sequence), [1, 2, 3])
})

for (const [label, options] of [['failed IPC', { exitCode: 1 }], ['closed stdin', { pipeError: true }]]) {
  test(`${label} stops all queued transitions and heartbeat refreshes`, async t => {
    const h = await harness(t, options)
    await h.chat()
    await h.status('busy')
    await h.status('idle')
    await h.flush()
    await h.tick()
    assert.deepEqual(observations(h), ['unknown'])
    assert(h.state.disabled)
    assert.equal(h.timers.size, 0)
    assert(h.kills() >= 1)
  })
}

test('hung helper is killed within the bounded deadline', async t => {
  const h = await harness(t, { hang: true })
  await h.chat()
  await h.flush()
  assert(h.state.disabled)
  assert(h.kills() >= 1)
})

test('metadata lookup deadline stops continuity even when custom SDK ignores AbortSignal', async t => {
  const h = await harness(t, { lookup: () => new Promise(() => {}) })
  await h.chat()
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.reports.length, 0)
})

test('malformed native status, request identity and queue overflow fail closed', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.flush()
  await h.status('future-status')
  await h.flush()
  await h.tick()
  assert(h.state.disabled)
  assert.equal(h.reports.at(-1).observation, 'busy')
  assert.equal(h.timers.size, 0, 'broker lease expires instead of renewing malformed evidence')
})

test('bounded queue stops an overloaded observer instead of dropping transitions silently', async t => {
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const h = await harness(t, { lookup: async (_, sessions) => { await barrier; return { data: sessions.get('ses_root') } } })
  await h.chat()
  for (let i = 0; i < 200; i += 1) await h.status('busy')
  release()
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
})

test('pending request bounds stop refresh without retaining arbitrary payload', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.flush()
  for (let i = 0; i <= 128; i += 1) {
    await h.event('question.asked', { sessionID: 'ses_root', id: `que_${i}`, questions: ['PRIVATE'] })
    await h.flush()
  }
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
  assert(!JSON.stringify([...h.state.questions]).includes('PRIVATE'))
})

test('actual direct-argv helper path handles spaces and apostrophes without shell interpretation', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "sessionbay plugin ' contract-"))
  const helper = path.join(dir, 'state helper')
  const output = path.join(dir, 'reports.jsonl')
  writeFileSync(helper, `#!${process.execPath}\nimport fs from 'node:fs';let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{if(process.argv[2]!=='--sessionbay-provider-state')process.exit(9);fs.appendFileSync(${JSON.stringify(output)},s+'\\n');});\n`)
  chmodSync(helper, 0o700)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = await harness(t, { realHelper: true, helper })
  await h.chat()
  await h.status('busy')
  await h.flush()
  const reports = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(reports.map(r => r.observation), ['unknown', 'busy'])
  assert.deepEqual(reports.map(r => r.sequence), [1, 2])
})

test('changed v2 envelope and malformed request cannot renew prior state', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.flush()
  await h.hooks.event({ event: { type: 'session.status', data: { sessionID: 'ses_root', status: { type: 'idle' } } } })
  await h.flush()
  await h.tick()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
  assert.equal(h.reports.at(-1).observation, 'busy')
})

test('invalid pending request identity closes the observer', async t => {
  const h = await harness(t, { resume: '' })
  await h.chat()
  await h.status('busy')
  await h.event('permission.asked', { sessionID: 'ses_root', id: 'bad\nidentity' })
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
})


test('slow successful delivery cannot replay stale work or heartbeat as fresh evidence', async t => {
  let now = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let started
  const delivering = new Promise(resolve => { started = resolve })
  const h = await harness(t, {
    now: () => now,
    deliver: report => {
      if (report.sequence !== 3) return
      started()
      return barrier
    },
  })
  await h.chat()
  await h.status('busy')
  await h.flush()
  const timer = [...h.timers][0]
  timer.fn()
  await delivering
  await h.status('busy')
  await h.status('idle')
  timer.fn()
  // Delivery succeeds, but every queued transition/refresh is now too old.
  now = 5001
  release()
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
  assert.equal(h.reports.length, 3)
  const count = h.reports.length
  await h.tick()
  assert.equal(h.reports.length, count)
})

test('metadata completion rechecks the source-event age before the first report', async t => {
  let now = 0
  const h = await harness(t, { now: () => now, lookup: (_, sessions) => {
    now = 5001
    return { data: sessions.get('ses_root') }
  } })
  await h.chat()
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.reports.length, 0)
})


test('malformed causal chat identity invalidates an already busy root immediately', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.flush()
  assert.equal(h.timers.size, 1)
  await h.hooks['chat.message']({})
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
  await h.tick()
  assert.deepEqual(observations(h), ['unknown', 'busy'])
})
