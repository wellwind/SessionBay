import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import SessionBayState from './opencode_state_plugin_v2.mjs'

const REGISTRY = Symbol.for('sessionbay.opencode.state.v2')
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
    ['ses_root', { id: 'ses_root', location: { directory: '/synthetic project' } }],
    ['ses_other', { id: 'ses_other', location: { directory: '/synthetic project' } }],
    ['ses_child', { id: 'ses_child', parentID: 'ses_root', location: { directory: '/synthetic project' } }],
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
  const queued = []
  let wake
  let ended = false
  let streamError
  let prompt
  let subscribed
  let disposed = 0
  const input = {
    location: { directory: '/synthetic project' },
    session: {
      get: async (args, opts) => {
        assert.deepEqual(Object.keys(args), ['sessionID'])
        assert(opts.signal instanceof AbortSignal)
        reads.push(args.sessionID)
        if (options.lookup) return options.lookup(args, sessions)
        return sessions.get(args.sessionID)
      },
      hook: async (name, callback) => {
        assert.equal(name, 'prompt')
        prompt = callback
        return { dispose: async () => { disposed += 1 } }
      },
    },
    event: { subscribe: init => {
      subscribed = init
      init.signal.addEventListener('abort', () => { ended = true; wake?.() })
      return { async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!queued.length) await new Promise(resolve => { wake = resolve })
          if (streamError) throw streamError
          while (queued.length) yield queued.shift()
        }
      } }
    } },
  }
  const cleanup = await SessionBayState.setup(input)
  const hooks = {
    'chat.message': event => prompt(event),
    event: async ({ event }) => {
      queued.push(event)
      wake?.()
      await new Promise(resolve => setImmediate(resolve))
    },
    dispose: cleanup,
  }
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
    hooks, state, reports, reads, sessions, timers, input, launch, subscribed,
    disposed: () => disposed,
    async disconnect(error) { streamError = error; ended = true; wake?.(); await new Promise(resolve => setImmediate(resolve)) },
    kills: () => kills,
    flush: () => state.queue,
    async chat(session = 'ses_root') {
      const output = { message: { text: 'PRIVATE PROMPT' }, parts: [{ text: 'PRIVATE PART' }] }
      const event = { sessionID: session, get prompt() { throw new Error('Private prompt inspected') } }
      await hooks['chat.message'](event, output)
      assert.equal(output.message.text, 'PRIVATE PROMPT')
    },
    async event(type, properties) {
      await hooks.event({ event: { type, data: properties } })
    },
    async status(status, session = 'ses_root') {
      await hooks.event({ event: { type: 'session.status', data: { sessionID: session, status: { type: status } } } })
    },
    async tick() { await state.queue; for (const timer of [...timers]) timer.fn(); await state.queue },
  }
}
const observations = h => h.reports.map(r => r.observation)
test('new launch binds only an ancestry-verified chat root, never first event or history', async t => {
  const h = await harness(t)
  await h.status('busy', 'ses_other')
  await h.event('session.created', { sessionID: 'ses_other' })
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
  const h = await harness(t, { lookup: async (_, sessions) => { await barrier; return sessions.get('ses_root') } })
  await h.chat()
  for (let i = 0; i < 200; i += 1) await h.status('busy')
  release()
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
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
    return sessions.get('ses_root')
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

test('module has the reviewed definition and subscribes only to lifecycle metadata', async t => {
  const h = await harness(t)
  assert.equal(SessionBayState.id, 'sessionbay.launch-state.v2')
  assert.equal(typeof SessionBayState.setup, 'function')
  assert(h.subscribed.signal instanceof AbortSignal)
  assert(h.subscribed.types.includes('permission.asked'))
  assert(!h.subscribed.types.some(type => /message|tool|text|reasoning/.test(type)))
  assert.equal(await SessionBayState.setup(h.input), undefined)
  await h.hooks.dispose()
  assert(h.subscribed.signal.aborted)
  assert.equal(h.disposed(), 1)
  assert.equal(await SessionBayState.setup(h.input), undefined)
})

test('permission IDs are tracked without accessing private event contents', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  const data = { sessionID: 'ses_root', id: 'per_a' }
  for (const key of ['message', 'resources', 'metadata', 'source']) {
    Object.defineProperty(data, key, { get() { throw new Error('Private content was inspected') } })
  }
  await h.event('permission.asked', data)
  await h.event('permission.asked', { sessionID: 'ses_root', id: 'per_b' })
  await h.event('permission.replied', { sessionID: 'ses_child', requestID: 'per_a' })
  await h.event('permission.replied', { sessionID: 'ses_root', requestID: 'per_a' })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'awaitingPermission')
  await h.event('permission.replied', { sessionID: 'ses_root', requestID: 'per_b' })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'busy')
})

for (const outcome of ['failed', 'interrupted']) test(`execution ${outcome} survives generic idle until fresh work`, async t => {
  const h = await harness(t, { resume: 'ses_root' })
  await h.event('session.execution.started', { sessionID: 'ses_root' })
  const data = { sessionID: 'ses_root' }
  Object.defineProperty(data, 'error', { get() { throw new Error('Private error inspected') } })
  await h.event(`session.execution.${outcome}`, data)
  await h.status('idle')
  await h.tick()
  assert.equal(h.reports.at(-1).observation, outcome)
  await h.event('session.execution.started', { sessionID: 'ses_root' })
  await h.event('session.execution.succeeded', { sessionID: 'ses_root' })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'idle')
})

test('native deletion expires the root and generic events cannot rebind', async t => {
  const h = await harness(t, { resume: 'ses_root' })
  await h.status('busy')
  await h.event('session.deleted', { sessionID: 'ses_root' })
  await h.status('busy')
  await h.tick()
  assert.deepEqual(observations(h), ['unknown', 'busy', 'unknown'])
  assert.equal(h.timers.size, 0)
})

for (const error of [undefined, new Error('synthetic stream failure')]) {
  test(`stream completion or failure stops heartbeat (${!!error})`, async t => {
    const h = await harness(t, { resume: 'ses_root' })
    await h.status('busy')
    await h.flush()
    await h.disconnect(error)
    await h.tick()
    assert(h.state.disabled)
    assert.equal(h.timers.size, 0)
  })
}

test('changed v1 envelope and malformed native identity fail closed', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  await h.flush()
  await h.hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_root', status: { type: 'idle' } } } })
  await h.tick()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
  assert.equal(h.reports.at(-1).observation, 'busy')
})

for (const options of [{ exitCode: 1 }, { pipeError: true }]) test('failed helper stops queued reports', async t => {
  const h = await harness(t, options)
  await h.chat()
  await h.status('busy')
  await h.tick()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
  assert.deepEqual(observations(h), ['unknown'])
})

for (const info of [undefined,
  { id: 'ses_other', location: { directory: '/synthetic project' } },
  { id: 'ses_root', location: { directory: '/other' } },
  { id: 'ses_root', parentID: null, location: { directory: '/synthetic project' } },
  { id: 'ses_root', parentID: 'ses_parent', location: { directory: '/synthetic project' } },
]) test('ambiguous ancestry never reports a resume root', async t => {
  const h = await harness(t, { resume: 'ses_root', lookup: () => info })
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.reports.length, 0)
})

test('permission identity and pending limits cannot renew stale state', async t => {
  const h = await harness(t)
  await h.chat()
  await h.status('busy')
  for (let i = 0; i <= 128; i += 1) {
    await h.event('permission.asked', { sessionID: 'ses_root', id: `per_${i}` })
    await h.flush()
  }
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
})

test('malformed permission identity stops the observer', async t => {
  const h = await harness(t, { resume: 'ses_root' })
  await h.status('busy')
  await h.event('permission.asked', { sessionID: 'ses_root', id: 'bad\nidentity' })
  await h.flush()
  assert(h.state.disabled)
  assert.equal(h.timers.size, 0)
})

test('native retry and step metadata report retry then resumed busy without inspecting payloads', async t => {
  const h = await harness(t, { resume: 'ses_root' })
  await h.event('session.execution.started', { sessionID: 'ses_root' })
  await h.event('session.retry.scheduled', { sessionID: 'ses_child' })
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'busy')
  const data = { sessionID: 'ses_root' }
  for (const key of ['error', 'agent', 'model', 'snapshot', 'assistantMessageID']) {
    Object.defineProperty(data, key, { get() { throw new Error('Non-allowlisted payload inspected') } })
  }
  await h.event('session.retry.scheduled', data)
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'retry')
  await h.event('session.step.started', data)
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'busy')
  await h.event('session.retry.scheduled', data)
  await h.event('session.step.streamed', data)
  await h.flush()
  assert.equal(h.reports.at(-1).observation, 'busy')
})
