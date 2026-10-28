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

// Nothing sits beneath the plugin in a test: these hooks stand for the engine. `opened` collects the ids of the
// panes the plugin opens.
const engine = (on: Parameters<TestBody>[1], opened: string[] = []) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
}

test('/ccinformer and its alias /side both open the pane, which names itself as a working copy', async ($, on) => {
  const opened: string[] = []
  engine(on, opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
  await $.command.run({ ...typed, command: 'ccinformer', args: '' })
  // With the pane open, an area argument switches the area and keeps it open, so the alias opens it again.
  await $.command.run({ ...typed, command: 'side', args: 'debug' })
  expect(opened).toEqual(['ccinformer', 'ccinformer'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // A test loads the mod from its folder, not from the plugin cache, so the pane says it's a working copy.
  expect(await ui.find({ type: 'Text', text: 'CCInformer · dev' })).toBeDefined()
  expect(await ui.find({ key: 'area-debug' })).toBeDefined()
  await ui.unmount()
})

test('the areas draw, and a tool call shows in Debug', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'area-code' })).toBeDefined()
  expect(await ui.find({ key: 'area-work' })).toBeDefined()

  await ui.press({ key: 'area-debug' })
  expect(await ui.find({ type: 'Text', text: /git status/ })).toBeDefined()
  await ui.unmount()
})

test('Work says so when nothing has run', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-work' })
  expect(await ui.find({ type: 'Text', text: /No workflow has run/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('Now lists this session, alone in its folder', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-now' })
  await ui.press({ key: 'view-sessions' })
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No other session in this folder/ })).toBeDefined()
  await ui.unmount()
})

test('Code says what git said when the folder is no repository', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-code' })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
  await ui.unmount()
})
