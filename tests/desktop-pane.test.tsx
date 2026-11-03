import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The pane off the terminal: the desktop app (and VS Code, mobile) lays a page out, where a layer drawn on top sits
// above everything else and the surface scrolls the pane itself. So there the pane is one plain column, while the
// terminal keeps its fixed header and footer.

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// A session in a repository with nothing to report; the mod's plugin.json names version 9.9.9.
const engine = (on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 30, window: 100, percent: 30 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', (_, e) => ({ value: /plugin\.json$/.test(String((e as { path: string }).path)) ? '{ "version": "9.9.9" }' : null }) as never)
  on('fs.stat', () => ({ value: null }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock }
}

// Every Box in the drawing, with its props.
const boxes = async (ui: { findAll: (q: { type: 'Box' }) => Promise<{ props: Record<string, unknown> }[]> }) => ui.findAll({ type: 'Box' })

test('off the terminal the pane is one plain column: header, content, footer, nothing laid over anything', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect({ surface, absolute: (await boxes(ui)).filter(b => b.props.position === 'absolute').length }).toEqual({ surface, absolute: 0 })
    expect({ surface, blank: await ui.find({ key: 'header-blank' }) }).toEqual({ surface, blank: undefined })
    expect({ surface, footer: !!(await ui.find({ key: 'footer', text: /Context: 30%/ })) }).toEqual({ surface, footer: true })
    const content = await ui.find({ key: 'content' })
    expect({ surface, marginTop: content?.props.marginTop, paddingTop: content?.props.paddingTop }).toEqual({ surface, marginTop: undefined, paddingTop: undefined })
    // The surface draws the pane's name, so there is no name line; the version sits in the header instead.
    expect({ surface, name: await ui.find({ type: 'Text', text: /✻/ }) }).toEqual({ surface, name: undefined })
    expect({ surface, version: !!(await ui.find({ key: 'header', text: /v9\.9\.9/ })) }).toEqual({ surface, version: true })
    await ui.unmount()
  }
})

test('off the terminal the area bar presses, and the view bar may wrap', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'area-work' })
  expect(await ui.find({ key: 'view-runs' })).toBeDefined()
  await ui.press({ key: 'area-debug' })
  expect(await ui.find({ key: 'view-settings' })).toBeDefined()
  expect((await boxes(ui)).some(b => b.props.flexWrap === 'wrap')).toBe(true)
  await ui.unmount()
})

test('the terminal keeps its fixed header and footer, drawn over the content, with its name line', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'header-blank' })).toBeDefined()
  expect((await ui.find({ key: 'footer' }))?.props.position).toBe('absolute')
  expect(await ui.find({ type: 'Text', text: /✻/ })).toBeDefined()
  expect((await boxes(ui)).some(b => b.props.flexWrap === 'wrap')).toBe(false)
  await ui.unmount()
})

// Which surface's pane scrolls its own content can't be driven here: the test host lays nothing out, so a scroll event
// carries no whole row numbers and the hook passes it on on every surface. The layouts above are what the scroll acts on.
