import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { EXPLAIN_TEXTS, PERMISSIONS, PERMISSION_GROUPS } from '../hooks/core/permissions'
import { AGENTS_TEXTS, AGENT_ROLES, DEFAULT_SKILLS, PLAN_FILES, agentsExplain } from '../hooks/core/skills'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 400 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
const SKILLS_FILE = '/home/test/.claude/ccinformer/skills.json'

// How the store misbehaves for a test: `afterKeys` and `afterSet` run as another session writing in between (after the
// keys are listed, after a key is set); `keysFail` rejects that many key listings; `setFails` rejects every set of
// those keys.
type StoreOpts = {
  afterKeys?: (store: Map<string, unknown>) => void
  afterSet?: (key: string, store: Map<string, unknown>) => void
  keysFail?: number
  setFails?: string[]
}

// A session in a folder that is no repository, with the store in memory and open to the test: `store` is what every
// session sees, `sets` every key written, `registered` every command registered. Seeded by default with a key an older
// version wrote, so it is an install from before 0.24.0. `holdNextRead()` makes the next read of the choices wait until
// `release()`, as a slow read would; it resolves once that read is waiting.
const engine = (on: Parameters<TestBody>[1], seed: Record<string, unknown> = { area: 'code' }, opts: { submitDrop?: string } & StoreOpts = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const submits: { text: string; context: readonly string[] }[] = []
  const toasts: string[] = []
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') submits.push({ text: e.text, context: e.context ?? [] })
    else contexts.push(...(e.context ?? []))
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
  const sets: string[] = []
  const registered: string[] = []
  let keysFail = opts.keysFail ?? 0
  on('store.set', (_, e) => {
    if (opts.setFails?.includes(e.key)) throw new Error('the store could not be written')
    sets.push(e.key)
    store.set(e.key, e.value)
    opts.afterSet?.(e.key, store)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => {
    if (keysFail > 0) {
      keysFail -= 1
      throw new Error('the store could not be read')
    }
    const value = [...store.keys()]
    opts.afterKeys?.(store)
    return { value } as never
  })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/elsewhere' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  // The files the mod reads and writes, the planning skills' settings among them.
  const files = new Map<string, string>()
  on('fs.read', (_, e) => ({ value: files.get(posix(e.path)) ?? null }) as never)
  on('fs.write', (_, e) => {
    files.set(posix(e.path), e.text)
    return { value: undefined } as never
  })
  const commands: string[] = []
  const contexts: string[] = []
  on('process.run', (_, e) => {
    commands.push((e as { argv: string[] }).argv.join(' '))
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return {
    clock,
    store,
    sets,
    registered,
    commands,
    contexts,
    submits,
    toasts,
    files,
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

const DEFAULTS = { base: 'defaults', set: {} }
const NEW_INSTALL = { base: 'off', set: {} }
const allOn = async (ui: Ui) => {
  for (const d of PERMISSIONS) expect(await rowState(ui, d.id)).toBe('on')
}
const quiet = async (ui: Ui) => {
  for (const d of PERMISSIONS) expect(await rowState(ui, d.id)).toBe(d.group === 'safety' ? 'on' : 'off')
}

test('an install from before 0.24.0 keeps every switch on, pinned at the first read: every permission in a row of its own', async ($, on) => {
  const { clock, store } = engine(on)
  await start($)
  expect(store.get('permissions')).toEqual(DEFAULTS)
  expect(store.has('settingsFirst')).toBe(false)
  const ui = await settings($)
  await clock.settle()
  expect(await ui.find({ key: 'settings-approve' })).toBeDefined()
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('perm-'))
  expect(rows.length).toBe(PERMISSIONS.length)
  await allOn(ui)
  expect(await ui.find({ type: 'Text', text: `${PERMISSIONS.length} of ${PERMISSIONS.length} on` })).toBeDefined()
  await ui.unmount()
})

test('a new install (empty store) starts with only Safety on, and stores the marker before the choices', async ($, on) => {
  const { clock, store, sets } = engine(on, {})
  await start($)
  expect(sets).toEqual(['settingsFirst', 'permissions'])
  expect(store.get('permissions')).toEqual(NEW_INSTALL)
  const ui = await settings($)
  await clock.settle()
  await quiet(ui)
  expect(await ui.find({ type: 'Text', text: 'passive' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A new install starts that way, except Safety\./ })).toBeDefined()
  await ui.unmount()
})

test('choices another session stores between this one\'s key listing and its read stand, and nothing is written', async ($, on) => {
  const approved = { base: 'defaults', set: { 'notify.ciToast': true } }
  const { clock, store, sets } = engine(on, {}, { afterKeys: s => s.set('permissions', approved) })
  await start($)
  // The start's own work (the session row, the pack) finishes before the test does.
  await clock.settle()
  expect(store.get('permissions')).toEqual(approved)
  expect(sets.filter(k => k === 'permissions' || k === 'settingsFirst')).toEqual([])
})

test('choices another session stores between this one\'s marker and its choices stand', async ($, on) => {
  const approved = { base: 'defaults', set: { 'notify.ciToast': true } }
  const { clock, store, sets } = engine(on, {}, { afterSet: (key, s) => key === 'settingsFirst' && s.set('permissions', approved) })
  await start($)
  expect(store.get('permissions')).toEqual(approved)
  expect(sets.filter(k => k === 'permissions' || k === 'settingsFirst')).toEqual(['settingsFirst'])
  const ui = await settings($)
  await clock.settle()
  await allOn(ui)
  await ui.unmount()
})

test('an odd stored value is read as the defaults and never rewritten', async ($, on) => {
  const { clock, store, sets } = engine(on, { permissions: 'odd' })
  await start($)
  const ui = await settings($)
  await clock.settle()
  await allOn(ui)
  expect(store.get('permissions')).toBe('odd')
  expect(sets.includes('permissions')).toBe(false)
  await ui.unmount()
})

test('choices deleted mid-session leave the session as it was, never at the defaults', async ($, on) => {
  const { clock, store } = engine(on, {})
  await start($)
  const ui = await settings($)
  await clock.settle()
  store.delete('permissions')
  await clock.advance(6000)
  await clock.settle()
  await quiet(ui)
  expect(store.has('permissions')).toBe(false)
  await ui.unmount()
})

test('a store that cannot be read at start: quiet, nothing written, /ccinformer still there; the next poll decides', async ($, on) => {
  const { clock, store, sets, registered } = engine(on, {}, { keysFail: 1 })
  await start($)
  expect(sets).toEqual([])
  expect(registered).toContain('ccinformer')
  await clock.advance(6000)
  await clock.settle()
  expect(store.get('permissions')).toEqual(NEW_INSTALL)
  expect(store.get('settingsFirst')).toBe(true)
})

test('a store that cannot be read at start decides before /ccinformer writes anything, so the pane can\'t make it look older', async ($, on) => {
  const { clock, store } = engine(on, {}, { keysFail: 1 })
  await start($)
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await clock.settle()
  expect(store.get('isOpen')).toBe(true)
  expect(store.get('permissions')).toEqual(NEW_INSTALL)
})

test('choices that could not be stored leave the marker, so the next session is still a new install', async ($, on) => {
  // What a first session leaves when its choices couldn't be stored and the person then opened the pane.
  const { clock, store } = engine(on, { settingsFirst: true, isOpen: true, columns: 40, area: 'code' })
  await start($)
  expect(store.get('permissions')).toEqual(NEW_INSTALL)
  const ui = await settings($)
  await clock.settle()
  await quiet(ui)
  await ui.unmount()
})

test('choices that cannot be stored are tried again on the next poll', async ($, on) => {
  const failing = ['permissions']
  const { clock, store } = engine(on, {}, { setFails: failing })
  await start($)
  expect(store.get('settingsFirst')).toBe(true)
  expect(store.has('permissions')).toBe(false)
  failing.length = 0
  await clock.advance(6000)
  await clock.settle()
  expect(store.get('permissions')).toEqual(NEW_INSTALL)
})

const bare = ($: Parameters<TestBody>[0]) => $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
const mount = ($: Parameters<TestBody>[0]) => $.ui.mount({ ...PANE, surface: 'terminal' })
const isOnSettings = async (ui: Ui) => !!(await ui.find({ key: 'settings-approve' }))
const isOnCode = async (ui: Ui) => !!(await ui.find({ type: 'Text', text: /not a git repository/ }))

test("a new install's first bare /ccinformer opens on Settings, once, without keeping that area or reading git", async ($, on) => {
  const { clock, store, commands, submits, contexts } = engine(on, {})
  await start($)
  const before = commands.length
  await bare($)
  const ui = await mount($)
  await clock.settle()
  expect(await isOnSettings(ui)).toBe(true)
  await quiet(ui)
  expect(await ui.find({ type: 'Text', text: 'passive' })).toBeDefined()
  expect(store.has('settingsFirst')).toBe(false)
  expect(store.has('area')).toBe(false)
  expect(commands.slice(before).filter(c => /^(git|gh) /.test(c))).toEqual([])
  // Nothing about it reaches Claude.
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
  expect(submits).toEqual([])
  expect(contexts).toEqual([])
  // The pane keeps its area for the rest of the session, as it always has.
  await bare($)
  await bare($)
  await clock.settle()
  expect(await isOnSettings(ui)).toBe(true)
  await ui.unmount()
})

test("a new install's next session opens on Code, from what the first one left behind", async ($, on) => {
  const { clock } = engine(on, { permissions: NEW_INSTALL, isOpen: false, columns: 40 })
  await start($)
  await bare($)
  const ui = await mount($)
  await clock.settle()
  expect(await isOnSettings(ui)).toBe(false)
  expect(await isOnCode(ui)).toBe(true)
  await ui.unmount()
})

test('on a new install a named area wins and keeps the marker, so the next bare open still shows Settings', async ($, on) => {
  const { clock, store } = engine(on, {})
  await start($)
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  const ui = await mount($)
  await clock.settle()
  expect(await isOnCode(ui)).toBe(true)
  expect(store.get('settingsFirst')).toBe(true)
  await bare($)
  await bare($)
  await clock.settle()
  expect(await isOnSettings(ui)).toBe(true)
  expect(store.has('settingsFirst')).toBe(false)
  await ui.unmount()
})

test('on a new install, picking Settings in Debug clears the marker', async ($, on) => {
  const { clock, store } = engine(on, {})
  await start($)
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'debug' })
  const ui = await mount($)
  await clock.settle()
  expect(store.get('settingsFirst')).toBe(true)
  await ui.press({ key: 'view-settings' })
  await clock.settle()
  expect(await isOnSettings(ui)).toBe(true)
  expect(store.has('settingsFirst')).toBe(false)
  await ui.unmount()
})

test("an older install's bare /ccinformer opens where it always did", async ($, on) => {
  const { clock } = engine(on)
  await start($)
  await bare($)
  const ui = await mount($)
  await clock.settle()
  expect(await isOnCode(ui)).toBe(true)
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
  for (const d of PERMISSIONS) expect(await rowState(ui, d.id)).toBe(d.group === 'safety' && d.id !== 'safety.envBand' ? 'on' : 'off')

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

// Real time, so the press's work runs on until it waits behind the held read; the mocked clock can't move it, and a
// settle would wait for the held read. The test runner has timers, but the types describe a hooks module's globals,
// which have none.
const waitReal = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (done: () => void, ms: number) => unknown }).setTimeout(resolve, ms))

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
  await waitReal(50)
  release()
  await clock.settle()
  expect(store.get('permissions')).toEqual({ base: 'defaults', set: { 'notify.memory': false } })
  expect(await rowState(ui, 'notify.memory')).toBe('off')
  await ui.unmount()
})

const mainEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't-main', reason: 'answer' } as never

test('the planning skills\' Plan files switch: on with no file, a press writes the file off, approve all and deny all leave it, and a new session reads it back', async ($, on) => {
  const { clock, files } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('on')
  await ui.press({ key: 'skills-planFiles' })
  await clock.settle()
  expect(files.get(SKILLS_FILE)).toBe('{\n  "planFiles": false\n}\n')
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('off')
  await ui.press({ key: 'settings-approve' })
  await clock.settle()
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('off')
  await ui.press({ key: 'settings-deny' })
  await clock.settle()
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('off')
  expect(await rowState(ui, 'notify.ciToast')).toBe('off')
  await ui.unmount()

  // A later session reads the file; the switch is not in the store.
  await start($)
  const again = await settings($)
  await clock.settle()
  expect((await again.find({ key: 'skills-planFiles' }))?.text).toBe('off')
  await again.press({ key: 'skills-planFiles' })
  await clock.settle()
  expect(files.get(SKILLS_FILE)).toBe('{\n  "planFiles": true\n}\n')
  expect((await again.find({ key: 'skills-planFiles' }))?.text).toBe('on')
  await again.unmount()
})

test('a skills file written elsewhere is read when Settings is shown again, and one that is not JSON reads as on', async ($, on) => {
  const { clock, files } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  files.set(SKILLS_FILE, '{ "planFiles": false }')
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('off')
  files.set(SKILLS_FILE, 'not json')
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('on')
  await ui.unmount()
})

const agentValue = async (ui: Ui, id: string) => (await ui.find({ key: 'agent-' + id }))?.text
const badge = async (ui: Ui, text: string) => !!(await ui.find({ type: 'Text', text }))

test('the workflow agents: every row shows its default with no file; a press moves a value on and writes the file, keeping Plan files', async ($, on) => {
  const { clock, files } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  for (const d of AGENT_ROLES) {
    expect(await agentValue(ui, `${d.script}.${d.role}-model`)).toBe(d.model)
    expect(await agentValue(ui, `${d.script}.${d.role}-effort`)).toBe(d.effort)
  }
  expect(await badge(ui, AGENTS_TEXTS.defaults)).toBe(true)
  expect(files.has(SKILLS_FILE)).toBe(false)

  await ui.press({ key: 'skills-planFiles' })
  await ui.press({ key: 'agent-plan-fanout.critic-effort' })
  await clock.settle()
  expect(await agentValue(ui, 'plan-fanout.critic-effort')).toBe('low')
  expect(await agentValue(ui, 'plan-fanout.critic-model')).toBe('opus')
  expect(await agentValue(ui, 'plan-review.critic-effort')).toBe('medium')
  expect(await badge(ui, AGENTS_TEXTS.changed(1))).toBe(true)
  expect(JSON.parse(files.get(SKILLS_FILE)!)).toEqual({ planFiles: false, agents: { 'plan-fanout': { critic: { effort: 'low' } } } })

  // Flipping Plan files keeps the agents; approve all and deny all leave them.
  await ui.press({ key: 'skills-planFiles' })
  await ui.press({ key: 'settings-approve' })
  await ui.press({ key: 'settings-deny' })
  await clock.settle()
  expect(JSON.parse(files.get(SKILLS_FILE)!)).toEqual({ planFiles: true, agents: { 'plan-fanout': { critic: { effort: 'low' } } } })
  expect(await agentValue(ui, 'plan-fanout.critic-effort')).toBe('low')
  await ui.unmount()

  // A later session reads it back.
  await start($)
  const again = await settings($)
  await clock.settle()
  expect(await agentValue(again, 'plan-fanout.critic-effort')).toBe('low')
  await again.unmount()
})

test('the workflow agents: two presses close together both count, and return to default removes them all and keeps Plan files', async ($, on) => {
  const { clock, files } = engine(on)
  files.set(SKILLS_FILE, '{ "planFiles": false }')
  await start($)
  const ui = await settings($)
  await clock.settle()
  void ui.press({ key: 'agent-plan-fanout.scout-model' })
  void ui.press({ key: 'agent-build-fanout.reviewer-effort' })
  await clock.settle()
  expect(JSON.parse(files.get(SKILLS_FILE)!)).toEqual({
    planFiles: false,
    agents: { 'plan-fanout': { scout: { model: 'opus' } }, 'build-fanout': { reviewer: { effort: 'low' } } },
  })
  expect(await badge(ui, AGENTS_TEXTS.changed(2))).toBe(true)

  await ui.press({ key: 'skills-agents-reset' })
  await clock.settle()
  expect(files.get(SKILLS_FILE)).toBe('{\n  "planFiles": false\n}\n')
  expect(await agentValue(ui, 'plan-fanout.scout-model')).toBe('sonnet')
  expect(await agentValue(ui, 'build-fanout.reviewer-effort')).toBe('high')
  expect(await badge(ui, AGENTS_TEXTS.defaults)).toBe(true)
  expect((await ui.find({ key: 'skills-planFiles' }))?.text).toBe('off')
  await ui.unmount()
})

test('the workflow agents: a file changed elsewhere shows after a refresh, a press builds on the file as it is, and a key this version does not know stays', async ($, on) => {
  const { clock, files } = engine(on)
  await start($)
  const ui = await settings($)
  await clock.settle()
  files.set(SKILLS_FILE, '{ "someLater": [1], "agents": { "plan-review": { "critic": { "model": "sonnet" } }, "plan-fanout": { "scout": { "model": "fable" } } } }')
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await agentValue(ui, 'plan-review.critic-model')).toBe('sonnet')
  // A value off the lists reads as the default.
  expect(await agentValue(ui, 'plan-fanout.scout-model')).toBe('sonnet')

  // Another session sets one more; this one's press keeps it.
  files.set(SKILLS_FILE, '{ "someLater": [1], "agents": { "plan-review": { "critic": { "model": "sonnet" } }, "audit-docs-fanout": { "auditor": { "effort": "medium" } } } }')
  await ui.press({ key: 'agent-plan-review.critic-effort' })
  await clock.settle()
  expect(JSON.parse(files.get(SKILLS_FILE)!)).toEqual({
    someLater: [1],
    planFiles: true,
    agents: { 'plan-review': { critic: { model: 'sonnet', effort: 'high' } }, 'audit-docs-fanout': { auditor: { effort: 'medium' } } },
  })
  expect(await agentValue(ui, 'audit-docs-fanout.auditor-effort')).toBe('medium')
  await ui.unmount()
})

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
  expect(submits[0]!.text).toContain(`On · ${PLAN_FILES.group} · ${PLAN_FILES.label}: ${PLAN_FILES.description}`)
  expect(submits[0]!.text).toContain(agentsExplain(DEFAULT_SKILLS))
  expect(submits[0]!.text).toContain("the planning skills' settings (Plan files and the workflow agents)")
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
  const { clock, submits, toasts } = engine(on, { area: 'code' }, { submitDrop: 'the session is closing' })
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
