import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Area } from '../types'
import { areaDef } from '../hooks/areas'
import { areaBarFit, viewBarFit, wrapRows } from '../hooks/ui'
import type { Badge } from '../hooks/ui'

// The terminal's header is drawn over the content at a height worked out before drawing, so a bar that doesn't fit one
// row must take more rows rather than squeeze: a squeezed last item wrapped into a narrow column ("Set / tin / gs") and
// spilled out of the header over the content.

const DEBUG_VIEWS = areaDef('debug').views
const NO_BADGES: Record<Area, Badge | null> = { now: null, code: null, work: null, timeline: null, debug: null }

describe('fitting the bars', () => {
  test('wrapRows fills each row in order, and an item wider than a row gets a row of its own', () => {
    expect(wrapRows([5, 5, 5], 12, 2)).toEqual([[0, 1], [2]])
    expect(wrapRows([3, 20, 3], 10, 2)).toEqual([[0], [1], [2]])
    expect(wrapRows([], 10, 2)).toEqual([])
  })

  test("Debug's view bar keeps its counts while they fit, drops them first, and wraps last", () => {
    const counts = { tools: '72', requests: '71', context: '177k' }
    // "t: Calls 72  q: Requests 71  c: Context 177k  p: Pack  s: Settings" is 66 cells.
    expect(viewBarFit(DEBUG_VIEWS, counts, 100)).toEqual({ gap: 2, rows: [[0, 1, 2, 3, 4]], hasCounts: true })
    expect(viewBarFit(DEBUG_VIEWS, counts, 62)).toEqual({ gap: 1, rows: [[0, 1, 2, 3, 4]], hasCounts: true })
    // Without the counts it is 55 cells at a gap of 2, 51 at 1.
    expect(viewBarFit(DEBUG_VIEWS, counts, 58)).toEqual({ gap: 2, rows: [[0, 1, 2, 3, 4]], hasCounts: false })
    expect(viewBarFit(DEBUG_VIEWS, counts, 52)).toEqual({ gap: 1, rows: [[0, 1, 2, 3, 4]], hasCounts: false })
    expect(viewBarFit(DEBUG_VIEWS, counts, 40)).toEqual({ gap: 2, rows: [[0, 1, 2], [3, 4]], hasCounts: false })
    expect(viewBarFit(DEBUG_VIEWS, counts, 21)).toEqual({ gap: 2, rows: [[0, 1], [2, 3], [4]], hasCounts: false })
    expect(viewBarFit(DEBUG_VIEWS, counts, 20)).toEqual({ gap: 2, rows: [[0], [1], [2, 3], [4]], hasCounts: false })
  })

  test('the area bar narrows its gaps before it wraps, and counts its badges and refresh', () => {
    // "1: Now  2: Code  3: Work  5: Debug  r: ⟳" is 40 cells.
    expect(areaBarFit(NO_BADGES, 40)).toEqual({ gap: 2, rows: [[0, 1, 2, 3, 4]], hasCounts: false })
    const badges = { ...NO_BADGES, code: { char: '✗', color: 'error' }, debug: { char: '•', color: 'error' } } as Record<Area, Badge | null>
    // Two badges add 4 cells: 44 at a gap of 2, 40 at 1.
    expect(areaBarFit(badges, 40)).toEqual({ gap: 1, rows: [[0, 1, 2, 3, 4]], hasCounts: false })
    expect(areaBarFit(badges, 30)).toEqual({ gap: 2, rows: [[0, 1, 2], [3, 4]], hasCounts: false })
  })
})

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  surface: 'terminal',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 42, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

// A session in a repository with nothing to report.
const engine = (on: Parameters<TestBody>[1]) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // An install from before 0.24.0 (it ran at the defaults), so every switch keeps its old default.
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 30, window: 100, percent: 30 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: null }) as never)
  on('fs.stat', () => ({ value: null }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock }
}

const openDebug = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'debug' })
}

test('a narrow terminal pane gives the view bar a second row, drops its counts, and moves the content down to match', async ($, on) => {
  await openDebug($, on)
  // 40 cells inside the padding: the area bar fits one row, Debug's views take two.
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'views-row-1' })).toBeDefined()
  expect(await ui.find({ key: 'views-row-2' })).toBeUndefined()
  expect(await ui.find({ key: 'areas-row-1' })).toBeUndefined()
  // Title, areas, line, blank, two view rows.
  expect((await ui.find({ key: 'content' }))?.props.paddingTop).toBe(6)
  expect((await ui.find({ key: 'header-blank' }))?.children.length).toBe(6)
  expect(await ui.find({ key: 'view-tools', text: /Calls 0/ })).toBeUndefined()
  // Every view still presses.
  await ui.press({ key: 'view-settings' })
  expect(await ui.find({ key: 'view-settings' })).toBeDefined()
  await ui.unmount()
})

test('a wide terminal pane keeps one row for each bar, with the counts', async ($, on) => {
  await openDebug($, on)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 102 } })
  expect(await ui.find({ key: 'views-row-1' })).toBeUndefined()
  expect(await ui.find({ key: 'areas-row-1' })).toBeUndefined()
  expect((await ui.find({ key: 'content' }))?.props.paddingTop).toBe(5)
  expect(await ui.find({ key: 'view-tools', text: /Calls 0/ })).toBeDefined()
  await ui.unmount()
})
