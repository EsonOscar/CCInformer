import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { readUsage, usageLine } from '../hooks/usage'
import { scrolledTop } from '../hooks/view-pane'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
// The engine's clock, and two resets: 4 h 12 min and 6 d 3 h 20 min from it (plus 30 s, which rounds down).
const NOW = 1_000_000
const MINUTE = 60_000
const FIVE_HOUR_RESET = new Date(NOW + (4 * 60 + 12) * MINUTE + 30_000).toISOString()
const SEVEN_DAY_RESET = new Date(NOW + ((6 * 24 + 3) * 60 + 20) * MINUTE + 30_000).toISOString()

test("the footer's line: whole percent for the context, the limits' one decimal kept, a dash for no reading", async () => {
  expect(usageLine(readUsage({ tokens: 20, window: 100, percent: 34.4 }, [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 7 }]), NOW)).toBe(
    'Context: 34% | 5hr: 23.5% | 7d: 7%',
  )
  // Without a subscription there are no windows; without a percent the context comes from its tokens.
  expect(usageLine(readUsage({ tokens: 50, window: 200 }, []), NOW)).toBe('Context: 25% | 5hr: – | 7d: –')
  expect(usageLine(readUsage(undefined, undefined), NOW)).toBe('Context: – | 5hr: – | 7d: –')
})

test("the footer's line: the time left until each window resets, in whole minutes, none once it has passed", async () => {
  const limits = [
    { kind: 'five_hour', percentUsed: 12, resetsAt: FIVE_HOUR_RESET },
    { kind: 'seven_day', percentUsed: 40.5, resetsAt: SEVEN_DAY_RESET },
  ]
  expect(usageLine(readUsage(undefined, limits), NOW)).toBe('Context: – | 5hr (4h12m): 12% | 7d (6d3h20m): 40.5%')
  // Under an hour, and under a day: the leading units read 0. Past the reset, before a new reading: 0 left.
  expect(usageLine(readUsage(undefined, limits), Date.parse(SEVEN_DAY_RESET) - 5 * MINUTE)).toBe(
    'Context: – | 5hr (0h0m): 12% | 7d (0d0h5m): 40.5%',
  )
  // An unreadable time, or no clock reading yet, gives no countdown.
  expect(usageLine(readUsage(undefined, [{ kind: 'five_hour', percentUsed: 12, resetsAt: 'soon' }]), NOW)).toBe('Context: – | 5hr: 12% | 7d: –')
  expect(usageLine(readUsage(undefined, limits), 0)).toBe('Context: – | 5hr: 12% | 7d: 40.5%')
})

// A session whose usage starts at `usage`; nothing else about the repo matters here.
const engine = (on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on, { now: NOW })
  // An install from before 0.24.0 (it ran at the defaults), so every switch keeps its old default.
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 30, window: 100, percent: 30 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12, resetsAt: FIVE_HOUR_RESET },
        { kind: 'seven_day', percentUsed: 40.5, resetsAt: SEVEN_DAY_RESET },
      ],
      cost: { usd: 0 },
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: null }) as never)
  on('fs.stat', () => ({ value: null }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.measure', (_, e) => ({ changed: e.changed }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock }
}

test('every area shows the footer, and it follows each new measurement', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  for (const area of ['area-now', 'area-code', 'area-work', 'area-debug']) {
    await ui.press({ key: area })
    expect({ area, footer: !!(await ui.find({ type: 'Text', text: /^Context: 30% \| 5hr \(4h12m\): 12% \| 7d \(6d3h20m\): 40\.5%/ })) }).toEqual({ area, footer: true })
  }

  // A measurement without reset times drops the countdowns.
  await $.session.measure({
    context: { tokens: 62, window: 100, percent: 62 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 13 }, { kind: 'seven_day', percentUsed: 41 }],
    changed: ['context', 'rateLimits'],
  } as never)
  expect(await ui.find({ type: 'Text', text: /^Context: 62% \| 5hr: 13% \| 7d: 41%/ })).toBeDefined()
  await ui.unmount()
})

test('the footer, under its line, is drawn at the bottom row of the window, wherever the pane is scrolled', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })

  // Unscrolled, the 2 footer rows are the window's last 2 of 40; scrolled down 25 rows, they move down with it.
  for (const [offset, top] of [
    [0, 38],
    [25, 63],
  ] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset, bodyRows: 40 } }, surface: 'terminal' })
    const footer = await ui.find({ key: 'footer' })
    expect({ offset, position: footer?.props.position, top: footer?.props.top }).toEqual({ offset, position: 'absolute', top })
    // Two full-width lines: the one under the areas, and the footer's own.
    expect((await ui.findAll({ type: 'Text', text: /^─{20,}$/ })).length).toBe(2)
    await ui.unmount()
  }
})

test("the pane's own scroll: rows down from where it is, never above the top, never past where the last row clears the footer", async () => {
  // A 100-row tree in a 40-row window, unscrolled: 3 down is 3; the end is 60; the top is 0.
  expect(scrolledTop(0, 3, 100, 40)).toBe(3)
  expect(scrolledTop(0, 1000, 100, 40)).toBe(60)
  expect(scrolledTop(10, -50, 90, 40)).toBe(0)
  // Scrolled 60 already, the tree as drawn is 40 rows: nothing further down, and back up works.
  expect(scrolledTop(60, 5, 40, 40)).toBe(60)
  expect(scrolledTop(60, -5, 40, 40)).toBe(55)
  // A tree that fits doesn't scroll.
  expect(scrolledTop(0, 5, 30, 40)).toBe(0)
})

test('content that got shorter while scrolled: the next scroll, either way, brings the last row back above the footer', async () => {
  // Scrolled 60, the content then lost rows: the tree as drawn is 10 rows in a 40-row window, so its end is 30 rows up.
  expect(scrolledTop(60, 1, 10, 40)).toBe(30)
  expect(scrolledTop(60, -1, 10, 40)).toBe(30)
  // Scrolled past every row (the tree is only the footer's padding): a long way back on the first tick.
  expect(scrolledTop(200, -1, 2, 40)).toBe(162)
})

// What an earlier drawing left in the pane's scroll position (the content moved 60 rows up), kept through a reload:
// state reads 60 until the mod writes the position itself.
const seedScrolled = (on: Parameters<TestBody>[1]) => {
  let isSeeded = true
  on('state.get', async (_, e, next) => {
    const result = await next(e)
    return e.key === 'paneTop' && isSeeded && result.value ? { value: { ...result.value, value: 60 } } : result
  })
  on('state.set', (_, e, next) => {
    if (e.key === 'paneTop') isSeeded = false
    return next(e)
  })
}

test('the terminal tree is no taller than its content, so a scroll reads where the content ends', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const root = await ui.find({ type: 'Box' })
  expect([root?.props.paddingBottom, root?.props.minHeight]).toEqual([2, undefined])
  await ui.unmount()
})

test('a reload keeps the scroll position, and switching areas still brings it back to the top', async ($, on) => {
  const { clock } = engine(on)
  seedScrolled(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'content' }))?.props.marginTop).toBe(-60)
  await ui.press({ key: 'area-work' })
  expect((await ui.find({ key: 'content' }))?.props.marginTop).toBe(0)
  await ui.unmount()
})

test('`r` brings a scrolled pane back to the top', async ($, on) => {
  const { clock } = engine(on)
  seedScrolled(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'content' }))?.props.marginTop).toBe(-60)
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'content' }))?.props.marginTop).toBe(0)
  await ui.unmount()
})

test('a pane opened again starts at the top', async ($, on) => {
  const { clock } = engine(on)
  seedScrolled(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'content' }))?.props.marginTop).toBe(-60)
  await ui.unmount()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const opened = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await opened.find({ key: 'content' }))?.props.marginTop).toBe(0)
  await opened.unmount()
})

// The scroll itself can't be driven here (the test host lays nothing out), so scrolledTop's own test covers the moves;
// this holds the layout they act on: the content in a box of its own, the footer apart from it.
test('the content sits in a box of its own, unscrolled at first, with the footer drawn apart from it', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } }, surface: 'terminal' })
  const content = await ui.find({ key: 'content' })
  expect(content?.props.marginTop).toBe(0)
  expect(await ui.find({ key: 'content', text: /Context:/ })).toBeUndefined()
  expect(await ui.find({ key: 'footer', text: /Context:/ })).toBeDefined()
  await ui.unmount()
})

test('the header (title, areas, line, view bar) is drawn at the window top, and the content starts below it', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Code has several views, so its header is 5 rows (title, areas, line, a blank row, the views); Debug's too.
  await ui.press({ key: 'area-code' })
  const header = await ui.find({ key: 'header' })
  expect([header?.props.position, header?.props.top]).toEqual(['absolute', 0])
  expect(await ui.find({ key: 'header', text: /Code/ })).toBeDefined()
  expect((await ui.find({ key: 'content' }))?.props.paddingTop).toBe(5)
  // The area buttons are in the header, not the content that scrolls.
  expect((await ui.findAll({ key: 'area-code' })).length).toBe(1)
  await ui.unmount()
})
