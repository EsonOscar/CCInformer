import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { EXPLAIN_TEXTS, PERMISSIONS, PERMISSION_GROUPS } from '../hooks/core/permissions'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 400 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

// A session in a folder that is no repository, with the store in memory and open to the test: `store` is what every
// session sees. `holdNextRead()` makes the next read of the choices wait until `release()`, as a slow read would; it
// resolves once that read is waiting.
const engine = (on: Parameters<TestBody>[1], seed: Record<string, unknown> = {}, opts: { submitDrop?: string } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const submits: { text: string; context: readonly string[] }[] = []
  const toasts: string[] = []
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') submits.push({ text: e.text, context: e.context ?? [] })
    return (opts.submitDrop ? { drop: opts.submitDrop } : { text: e.text, context: e.context }) as never
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  mock.env(on, { HOME: '/home/test' })
  const store = new Map<string, unknown>(Object.entries(seed))
  let isHolding = false
  let release = () => {}
  let reached = () => {}
  on('store.get', async (_, e) => {
    const value = store.get(e.key)
    if (isHolding && e.key === 'permissions') {
      isHolding = false
      const held = new Promise<void>(resolve => (release = resolve))
      reached()
      await held
    }
    return { value } as never
  })
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/elsewhere' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: null }) as never)
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return {
    clock,
    store,
    submits,
    toasts,
    holdNextRead: () => {
      isHolding = true
      return new Promise<void>(resolve => (reached = resolve))
    },
    release: () => release(),
  }
}

const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
const settings = async ($: Parameters<TestBody>[0]) => {
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'settings' })
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}
type Ui = Awaited<ReturnType<typeof settings>>
const rowState = async (ui: Ui, id: string) => (await ui.find({ key: 'perm-' + id }))?.text

test('/ccinformer settings opens the view: every permission in a row of its own, all on with nothing stored', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  expect(await ui.find({ key: 'settings-approve' })).toBeDefined()
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('perm-'))
  expect(rows.length).toBe(PERMISSIONS.length)
  for (const d of PERMISSIONS) expect(await rowState(ui, d.id)).toBe('on')
  expect(await ui.find({ type: 'Text', text: `${PERMISSIONS.length} of ${PERMISSIONS.length} on` })).toBeDefined()
  await ui.unmount()
})

test('a press flips one switch, and the choice is kept for the next session', async ($, on) => {
  const { clock, store } = engine(on)
  await start($)
  const ui = await settings($)
  await ui.press({ key: 'perm-notify.ciToast' })
  await clock.settle()
  expect(await rowState(ui, 'notify.ciToast')).toBe('off')
  expect(await rowState(ui, 'notify.ciOs')).toBe('on')
  expect(store.get('permissions')).toEqual({ base: 'defaults', set: { 'notify.ciToast': false } })
  await ui.unmount()

  // A later session reads it back.
  await start($)
  const again = await settings($)
  await clock.settle()
  expect(await rowState(again, 'notify.ciToast')).toBe('off')
  await again.unmount()
})

test('two presses close together both count', async ($, on) => {
  const { clock, store } = engine(on)
  await start($)
  const ui = await settings($)
  void ui.press({ key: 'perm-notify.ciToast' })
  void ui.press({ key: 'perm-notify.ciOs' })
  await clock.settle()
  expect(store.get('permissions')).toEqual({ base: 'defaults', set: { 'notify.ciToast': false, 'notify.ciOs': false } })
  await ui.unmount()
})

test('deny all leaves only the Safety switches on; approve all turns the rest back on, a Safety switch set by hand stays as it is', async ($, on) => {
  const { clock } = engine(on)
  await start($)
  const ui = await settings($)
  await ui.press({ key: 'perm-safety.envBand' })
  await ui.press({ key: 'settings-deny' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'passive' })).toBeDefined()
  for (const d of PERMISSIONS) expect(await rowState(ui, d.id)).toBe(d.id === 'safety.prodStatus' ? 'on' : 'off')

  await ui.press({ key: 'settings-approve' })
  await clock.settle()
  for (const d of PERMISSIONS) expect(await rowState(ui, d.id)).toBe(d.id === 'safety.envBand' ? 'off' : 'on')
  await ui.unmount()
})

test("a change made in another session shows here within a few seconds; one this version doesn't know is kept", async ($, on) => {
  const { clock, store } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  store.set('permissions', { base: 'off', set: { 'bg.ciWatch': true, 'some.future': true } })
  await clock.advance(5000)
  await clock.settle()
  expect(await rowState(ui, 'bg.ciWatch')).toBe('on')
  expect(await rowState(ui, 'notify.ciToast')).toBe('off')
  expect(await ui.find({ key: 'perm-some.future' })).toBeUndefined()

  // A press here keeps what this version doesn't know.
  await ui.press({ key: 'perm-notify.ciToast' })
  await clock.settle()
  expect(store.get('permissions')).toEqual({ base: 'off', set: { 'bg.ciWatch': true, 'some.future': true, 'notify.ciToast': true } })
  await ui.unmount()
})

test('a read of the store that began before a press never undoes it', async ($, on) => {
  const { clock, store, holdNextRead, release } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  // The next re-read starts, and waits; meanwhile the person presses a switch.
  const isReading = holdNextRead()
  void clock.advance(5000)
  await isReading
  void ui.press({ key: 'perm-notify.memory' })
  await new Promise(resolve => setTimeout(resolve, 50))
  release()
  await clock.settle()
  expect(store.get('permissions')).toEqual({ base: 'defaults', set: { 'notify.memory': false } })
  expect(await rowState(ui, 'notify.memory')).toBe('off')
  await ui.unmount()
})

const mainEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't-main', reason: 'answer' } as never

test('explain hands Claude one prompt naming every switch and its state, and only once until the session ends a turn', async ($, on) => {
  const { clock, submits, toasts } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  expect(submits).toEqual([])

  await ui.press({ key: 'settings-deny' })
  await ui.press({ key: 'settings-explain' })
  await clock.settle()
  expect(submits.length).toBe(1)
  for (const d of PERMISSIONS) {
    const group = PERMISSION_GROUPS.find(g => g.id === d.group)!.label
    expect(submits[0]!.text).toContain(`${d.group === 'safety' ? 'On' : 'Off'} · ${group} · ${d.label}: ${d.description}`)
  }
  expect(submits[0]!.context).toEqual([])
  expect(toasts).toContain(EXPLAIN_TEXTS.sent)

  // A second press before the session ends a turn sends nothing more; after one, it asks again.
  await ui.press({ key: 'settings-explain' })
  await clock.settle()
  expect(submits.length).toBe(1)
  await $.turn.complete(mainEnd)
  await ui.press({ key: 'settings-explain' })
  await clock.settle()
  expect(submits.length).toBe(2)
  await ui.unmount()
})

test("a prompt Claude Code doesn't take says why, and the button works again", async ($, on) => {
  const { clock, submits, toasts } = engine(on, {}, { submitDrop: 'the session is closing' })
  await start($)
  const ui = await settings($)
  await ui.press({ key: 'settings-explain' })
  await clock.settle()
  expect(toasts).toContain(EXPLAIN_TEXTS.refused('the session is closing'))
  await ui.press({ key: 'settings-explain' })
  await clock.settle()
  expect(submits.length).toBe(2)
  await ui.unmount()
})
