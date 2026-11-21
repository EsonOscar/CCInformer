import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: {
    title: 'CCInformer',
    isFocused: true,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// The engine beneath the mod, with what a /clear does to it: the process goes on under a new session id, and the new
// session's state starts empty, so every value reads as never written until the mod writes it again.
const engine = (on: Parameters<TestBody>[1]) => {
  const world = { id: 'first-session-id', opened: [] as string[], closed: [] as string[], beats: [] as string[], dropped: [] as string[] }
  let written: Set<string> | null = null
  on('state.get', async (_, e, next) => {
    const result = await next(e)
    return written && !written.has(e.key) && result.value ? ({ value: { ...result.value, value: undefined } } as never) : result
  })
  on('state.set', (_, e, next) => {
    written?.add(e.key)
    return next(e)
  })
  // Registered first, so they stand outside the store mock and see what the mod writes for the other sessions.
  on('store.set', { key: /^session:/ }, (_, e, next) => {
    world.beats.push(e.key)
    return next(e)
  })
  on('store.delete', { key: /^session:/ }, (_, e, next) => {
    world.dropped.push(e.key)
    return next(e)
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: world.id }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('fs.read', (_, e) => ({ value: /plugin\.json$/.test(e.path) ? '{ "name": "ccinformer", "version": "9.8.7" }' : null }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  // Nothing tells the mod the new session began: its next tick finds the id moved (`tickMs` 0 stops before that tick).
  const clear = async ($: Parameters<TestBody>[0], reason: 'clear' | 'resume', tickMs = 1000) => {
    await $.session.end({ reason, sessionId: world.id } as never)
    written = new Set()
    world.id = 'second-session-id'
    await clock.advance(tickMs)
  }
  return { clock, world, clear }
}

const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
const texts = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = ((await ui.findAll({ type: 'Text' })) as { text?: string }[]).map(t => t.text ?? '')
  await ui.unmount()
  return found
}

for (const reason of ['clear', 'resume'] as const) {
  test(`after a /${reason} the open pane is the same pane: its version, its view and its place among the sessions`, async ($, on) => {
    const { clock, world, clear } = engine(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.command.run({ ...typed, command: 'ccinformer', args: 'settings' })
    await clock.settle()
    const before = await texts($)
    expect(before.includes('v9.8.7')).toBe(true)
    expect(before.some(t => t.startsWith('▍SETTINGS'))).toBe(true)

    await clear($, reason)
    const after = await texts($)
    expect(after.includes('v9.8.7')).toBe(true)
    expect(after.some(t => t.startsWith('▍SETTINGS'))).toBe(true)

    // The mod still knows the pane is open: its clock runs, and a bare /ccinformer closes it rather than opening it again.
    world.beats.length = 0
    await clock.advance(15_000)
    expect([...new Set(world.beats)]).toEqual(['session:second-session-id'])
    expect(world.dropped).toEqual(['session:first-session-id'])
    await $.command.run({ ...typed, command: 'ccinformer', args: '' })
    expect([world.opened, world.closed]).toEqual([['ccinformer'], ['ccinformer']])
  })
}

test('a bare /ccinformer typed right after a /clear, before the next tick, still closes the open pane', async ($, on) => {
  const { clock, world, clear } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...typed, command: 'ccinformer', args: '' })
  await clock.settle()

  await clear($, 'clear', 0)
  await $.command.run({ ...typed, command: 'ccinformer', args: '' })
  expect([world.opened, world.closed]).toEqual([['ccinformer'], ['ccinformer']])
})

test('a /clear starts the conversation over: the tool calls Debug listed are gone, while the workflow runs stay', async ($, on) => {
  const { clock, clear } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: "export const meta = {\n  name: 'nightly-sweep',\n}\n" })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.command.run({ ...typed, command: 'ccinformer', args: 'tools' })
  await clock.settle()
  expect((await texts($)).some(t => t.includes('git status'))).toBe(true)

  await clear($, 'clear')
  const after = await texts($)
  expect(after.includes('v9.8.7')).toBe(true)
  expect(after.some(t => t.includes('git status'))).toBe(false)

  await $.command.run({ ...typed, command: 'ccinformer', args: 'runs' })
  await clock.settle()
  expect((await texts($)).some(t => t.includes('nightly-sweep'))).toBe(true)
})
