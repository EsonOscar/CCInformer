import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { AREAS, areaFor, isBuilt, keysOf } from '../hooks/areas'

describe('the areas and their keys', () => {
  test('no key is used twice within an area plus the global keys', async () => {
    for (const area of AREAS) {
      const keys = keysOf(area)
      expect({ area: area.id, keys: keys.filter((k, i) => keys.indexOf(k) !== i) }).toEqual({ area: area.id, keys: [] })
    }
  })

  test('the digits are fixed, and an area with nothing built is left out', async () => {
    expect(AREAS.map(a => a.digit + ' ' + a.id)).toEqual(['1 now', '2 code', '3 work', '4 timeline', '5 debug'])
    expect(AREAS.filter(isBuilt).map(a => a.id)).toEqual(['now', 'code', 'work', 'debug'])
  })

  test('a command names an area, a view, or a tab from before the areas', async () => {
    expect(areaFor('code')).toEqual({ area: 'code' })
    expect(areaFor(' Debug ')).toEqual({ area: 'debug' })
    expect(areaFor('git')).toEqual({ area: 'code', view: 'git' })
    expect(areaFor('settings')).toEqual({ area: 'debug', view: 'settings' })
    expect(areaFor('agents')).toEqual({ area: 'work', view: 'runs' })
    expect(areaFor('sessions')).toEqual({ area: 'now', view: 'sessions' })
    expect(areaFor('stats')).toEqual({ area: 'work', view: 'stats' })
    expect(areaFor('requests')).toEqual({ area: 'debug', view: 'requests' })
    expect(areaFor('timeline')).toBeNull()
    expect(areaFor('nope')).toBeNull()
  })
})

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

// A repository on develop with one unstaged file, as git answers for it; gh isn't set up.
const ANSWERS: [RegExp, string][] = [
  [/^git status/, '# branch.oid abc123\n# branch.head develop\n# branch.upstream origin/develop\n# branch.ab +1 -0\n1 .M N... 1 1 1 a b src/app.ts\n'],
  [/^git diff --numstat/, '3\t1\tsrc/app.ts\n'],
  [/^git diff --no-color/, 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n'],
  [/^git log/, 'abc123\x1fFix the ping\x1f2 minutes ago\n'],
  [/^git rev-parse/, '/repo/.git\n/repo\n'],
]

// `opened` and `closed` collect the pane ids the plugin opens and closes.
const engine = (on: Parameters<TestBody>[1], store: Record<string, unknown> = {}) => {
  const opened: string[] = []
  const closed: string[] = []
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const answer = ANSWERS.find(([pattern]) => pattern.test(line))
    const ok = !!answer || line.startsWith('git ')
    return { value: { exitCode: ok ? 0 : 1, stdout: answer?.[1] ?? '', stderr: ok ? '' : 'gh is not set up', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  return { opened, closed }
}

test('each view sits under its area, and Timeline is not drawn until it has a view', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'area-timeline' })).toBeUndefined()

  await ui.press({ key: 'area-now' })
  expect(await ui.find({ type: 'Text', text: /STARTED HERE/ })).toBeDefined()
  await ui.press({ key: 'view-sessions' })
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined()

  await ui.press({ key: 'area-code' })
  expect(await ui.find({ type: 'Text', text: /Unstaged · 1/ })).toBeDefined()

  await ui.press({ key: 'area-work' })
  expect(await ui.find({ type: 'Text', text: /No workflow has run/ })).toBeDefined()
  await ui.press({ key: 'view-stats' })
  expect(await ui.find({ type: 'Text', text: /No finished workflow runs/ })).toBeDefined()

  await ui.press({ key: 'area-debug' })
  expect(await ui.find({ key: 'view-tools', text: /Calls/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /git status/ })).toBeDefined()
  await ui.press({ key: 'view-requests' })
  await ui.press({ key: 'view-context' })
  expect(await ui.find({ key: 'view-context' })).toBeDefined()
  await ui.unmount()
})

test('every hotkey drawn in an area is in its key map, and none is drawn twice', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  for (const area of AREAS.filter(isBuilt)) {
    await ui.press({ key: 'area-' + area.id })
    for (const view of area.views.length > 1 ? area.views : [null]) {
      if (view) await ui.press({ key: 'view-' + view.id })
      const drawn = (await ui.findAll({ type: 'Button' })).map(b => b.props.hotkey).filter((h): h is string => typeof h === 'string')
      const where = area.id + (view ? '/' + view.id : '')
      expect({ where, twice: drawn.filter((h, i) => drawn.indexOf(h) !== i) }).toEqual({ where, twice: [] })
      expect({ where, unmapped: drawn.filter(h => !keysOf(area).includes(h)) }).toEqual({ where, unmapped: [] })
    }
  }
  await ui.unmount()
})

test('/ccinformer and /side open an area by its name or an old tab name, and an argument never closes the pane', async ($, on) => {
  const { opened, closed } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'debug' })
  expect(await ui.find({ key: 'view-tools' })).toBeDefined()
  // Open already: an old tab name moves to its area and keeps the pane open.
  await $.command.run({ ...TYPED, command: 'side', args: 'agents' })
  expect(await ui.find({ type: 'Text', text: /No workflow has run/ })).toBeDefined()
  const unknown = await $.command.run({ ...TYPED, command: 'ccinformer', args: 'nope' })
  expect(unknown.text).toMatch(/no area "nope".*now, code, work, debug/)
  expect(closed).toEqual([])
  expect(opened.length).toBe(3)

  // Bare, it toggles: open now, so it closes.
  await $.command.run({ ...TYPED, command: 'side', args: '' })
  expect(closed).toEqual(['ccinformer'])
  await ui.unmount()
})

test('a tab kept by an earlier version opens as its area', async ($, on) => {
  engine(on, { tab: 'sessions', isOpen: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined()
  await ui.unmount()
})

test('each area keeps its selected row while another area shows', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', script: "export const meta = {\n  name: 'first',\n}\n" })
  await $.tool.call({ tool: 'Workflow', script: "export const meta = {\n  name: 'second',\n}\n" })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Code: a pressed file is selected and shows its diff.
  await ui.press({ key: 'area-code' })
  await ui.press({ key: 'file-Unstaged-src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()

  // Work: the running run shows until another is picked; picking one selects it, and × (x) clears it.
  await ui.press({ key: 'area-work' })
  expect(await ui.find({ key: 'run-close' })).toBeUndefined()
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('run-') && b.key !== 'run-close')
  expect(rows.length).toBe(2)
  // 'second' runs, so it shows; picking 'first' selects it.
  await ui.press({ key: rows.find(r => /first/.test(r.text))!.key! })
  expect(await ui.find({ key: 'run-close' })).toBeDefined()

  await ui.press({ key: 'area-code' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.press({ key: 'area-work' })
  expect(await ui.find({ key: 'run-close' })).toBeDefined()
  await ui.press({ key: 'run-close' })
  expect(await ui.find({ key: 'run-close' })).toBeUndefined()
  await ui.unmount()
})
