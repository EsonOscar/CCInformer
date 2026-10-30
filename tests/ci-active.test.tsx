import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} },
} as const
const CLOCK_HEAVY = { timeoutMs: 20_000 }
const REPO_KEY = '-repo-git'
const MARKER = 'ccinformer-ci:abc1234-1'

const prChecks = (bucket: 'pending' | 'fail') =>
  JSON.stringify([
    { name: 'lint', workflow: 'CI', bucket, startedAt: '', completedAt: '', link: 'https://github.com/acme/shop/actions/runs/100/job/11' },
    { name: 'build', workflow: 'CI', bucket: bucket === 'fail' ? 'pass' : 'pending', startedAt: '', completedAt: '', link: 'https://github.com/acme/shop/actions/runs/100/job/12' },
  ])
const PR = JSON.stringify({ number: 7, title: 'Cart', url: 'https://github.com/acme/shop/pull/7', baseRefName: 'main', isDraft: false, state: 'OPEN' })

// A repo on feat/cart (commit abc1234...) with PR #7, whose lint check is pending until `ci.bucket` says it failed. gh
// answers the failed job's log and the PR's diff. Submits, toasts and every command are recorded; a submit is refused
// when `submitDrop` is set. `mode` seeds the repo's CI mode in the shared store, `permissions` the Settings choices;
// with `slowLog`, the failed job's log takes 10 s of the mocked clock to read.
const engine = (on: Parameters<TestBody>[1], opts: { mode?: 'active'; submitDrop?: string; permissions?: object; slowLog?: boolean } = {}) => {
  const ci = { bucket: 'pending' as 'pending' | 'fail' }
  const submits: { text: string; origin: { kind: string } }[] = []
  const toasts: string[] = []
  const commands: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { ...(opts.mode ? { ['ciMode:' + REPO_KEY]: opts.mode } : {}), ...(opts.permissions ? { permissions: opts.permissions } : {}) })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: null }) as never)
  on('fs.stat', () => ({ value: null }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', async (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    commands.push(line)
    if (opts.slowLog && line.startsWith('gh run view')) await clock.sleep(10_000)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git status')) return out('# branch.oid abc1234def5678\n# branch.head feat/cart\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    if (line.startsWith('gh pr view')) return out(PR)
    if (line.startsWith('gh pr checks')) return out(prChecks(ci.bucket), ci.bucket === 'fail' ? 1 : 8)
    if (line.startsWith('gh run list')) return out('[]')
    if (line === 'gh run view --job 11 --log-failed') return out('lint\tRun eslint\terror  no-unused-vars: x is unused\n')
    if (line === 'gh pr diff 7') return out('+const x = 1\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('prompt.submit', (_, e) => {
    submits.push(e as never)
    return (opts.submitDrop ? { drop: opts.submitDrop } : { text: e.text }) as never
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, ci, submits, toasts, commands }
}

type Env = ReturnType<typeof engine>
type Dollar = Parameters<TestBody>[0]

// Opens Code (CI reads pending), then the lint check fails and Code is read again: the moment the ping fires.
const failCi = async ($: Dollar, env: Env, isInteractive = true) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  env.ci.bucket = 'fail'
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  // The claim reads itself back after a second.
  await env.clock.advance(1000)
  await env.clock.settle()
}
const mainEnd = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as never
const handoffs = (env: Env) => env.submits.filter(s => s.text.startsWith('ccinformer-ci:'))
const isDenied = (r: unknown) => !!(r as { deny?: string }).deny

test('passive: a failed check only toasts, as before', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on)
  await failCi($, env)
  expect(env.toasts).toContain('✗ CI failed on PR #7: lint')
  expect(handoffs(env)).toEqual([])
})

test('active: the failed job is read, one turn brings its log and the diff to the session, and a re-poll brings no other', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await failCi($, env)
  expect(env.commands).toContain('gh run view --job 11 --log-failed')
  expect(handoffs(env).length).toBe(1)
  const text = handoffs(env)[0]!.text
  expect(text.split('\n')[0]).toBe(MARKER)
  expect(text).toContain('error  no-unused-vars: x is unused')
  expect(text).toContain('+const x = 1')
  expect(env.toasts).toContain('CI failed: Claude looks into why in a turn of its own (read-only)')

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.advance(1000)
  await env.clock.settle()
  expect(handoffs(env).length).toBe(1)
})

test('a headless session never hands a failure over', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await failCi($, env, false)
  expect(handoffs(env)).toEqual([])
})

test('the hand-off turn may only read; before it, after it and in subagents nothing is denied', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await failCi($, env)
  const edit = () => $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)

  // A person's turn first: the hand-off is still waiting, and this turn is theirs.
  await $.turn.start({ text: 'what time is it', turnId: 'person-1' })
  expect(isDenied(await edit())).toBe(false)
  await $.turn.complete(mainEnd('person-1'))

  await $.turn.start({ text: `The ccinformer plugin sent a message: ${MARKER}\n...`, turnId: 'handoff' })
  const denied = await edit()
  expect((denied as { deny?: string }).deny).toMatch(/^CCInformer: this turn looks into a failed CI check and is read-only/)
  for (const tool of ['Write', 'Bash', 'Agent']) expect(isDenied(await $.tool.call({ tool, command: 'ls' } as never))).toBe(true)
  expect(isDenied(await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as never))).toBe(false)
  // A subagent's calls are never the guard's.
  expect(isDenied(await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b', agentId: 'helper-1' } as never))).toBe(false)

  await $.turn.complete(mainEnd('handoff'))
  expect(isDenied(await edit())).toBe(false)
})

test("a hand-off turn whose end never arrives doesn't make the next turn read-only; typing into it takes it over", CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await failCi($, env)
  const edit = () => $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)

  await $.turn.start({ text: `${MARKER}\nlogs`, turnId: 'handoff' })
  expect(isDenied(await edit())).toBe(true)
  // The person types into the running turn: it is theirs again.
  await $.prompt.submit({ text: 'go ahead and fix it', origin: { kind: 'composer' }, turnId: 'handoff', wait: false } as never)
  expect(isDenied(await edit())).toBe(false)

  // No end arrives for the hand-off turn; the next turn decides afresh.
  await $.turn.start({ text: 'next thing', turnId: 'person-2' })
  expect(isDenied(await edit())).toBe(false)
})

test('a refused hand-off says so, and no turn is read-only', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', submitDrop: 'a host limit was reached' })
  await failCi($, env)
  expect(env.toasts).toContain("CI investigation didn't start: a host limit was reached")
  await $.turn.start({ text: `${MARKER}\nlogs`, turnId: 'later' })
  expect(isDenied(await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never))).toBe(false)
})

test('Code > Git shows the mode, i switches it, and a mode another session set shows after a refresh', CLOCK_HEAVY, async ($, on) => {
  // Another session already made this repo active: the store says so before this session knew.
  const env = engine(on, { mode: 'active' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /on a failed check: Claude looks into it \(read-only\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'i passive' })).toBeDefined()

  await ui.press({ key: 'ci-mode' })
  await env.clock.settle()
  expect(env.toasts).toContain('CI passive here: a failed check gives a toast')
  expect(await ui.find({ type: 'Text', text: /on a failed check: a toast/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'i active' })).toBeDefined()
  await ui.unmount()
})

test("the latest look's state shows under the mode", CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await failCi($, env)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'waits for an idle moment in the session' })).toBeDefined()
  await $.turn.start({ text: `${MARKER}\nlogs`, turnId: 'handoff' })
  expect(await ui.find({ type: 'Text', text: 'handed to the session' })).toBeDefined()
  await ui.unmount()
})

test('/ccinformer ci switches the mode and looks into a failure on request, with the pane closed and no CI read yet', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  const ci = async (args: string) => ((await $.command.run({ ...TYPED, command: 'ccinformer', args: `ci ${args}`.trim() })) as { text?: string }).text
  expect(await ci('active')).toBe('CI active here: a failed check makes Claude look into it (read-only, uses tokens)')
  expect(await ci('passive')).toBe('CI passive here: a failed check gives a toast')
  expect(await ci('')).toBe('/ccinformer ci takes active, passive or investigate.')

  // Nothing failed yet: it reads CI first, then says so.
  expect(await ci('investigate')).toBe("Checking this branch's CI: a failed check is looked into in a turn of its own (read-only).")
  await env.clock.settle()
  expect(env.toasts).toContain("No failed check on this branch's CI to look into.")
  expect(handoffs(env)).toEqual([])

  // In passive mode too, on request: the failed check is looked into, with no claim to wait for.
  env.ci.bucket = 'fail'
  await ci('investigate')
  await env.clock.settle()
  expect(handoffs(env).length).toBe(1)
})

test('Look into failed CI off: a repo set to active hands nothing over, and switching it on says it is held off', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', permissions: { base: 'defaults', set: { 'claude.ciHandoff': false } } })
  await failCi($, env)
  expect(handoffs(env)).toEqual([])
  expect(env.commands.some(c => c.startsWith('gh run view'))).toBe(false)
  const reply = await $.command.run({ ...TYPED, command: 'ccinformer', args: 'ci active' })
  expect(reply.text).toContain('It stays held off while Look into failed CI is off in Debug › Settings.')
})

test('a hand-off on its way when Look into failed CI is switched off is stopped before it reaches the session', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', slowLog: true })
  await failCi($, env)
  // The failed job's log is being read; meanwhile the person switches the hand-off off.
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'debug' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-settings' })
  await ui.press({ key: 'perm-claude.ciHandoff' })
  await env.clock.advance(10_000)
  await env.clock.settle()
  expect(env.commands).toContain('gh run view --job 11 --log-failed')
  expect(handoffs(env)).toEqual([])
  await ui.unmount()
})

test('Code > Git says when a Settings switch holds the mode off', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', permissions: { base: 'defaults', set: { 'claude.ciHandoff': false, 'notify.ciToast': false } } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /on a failed check: nothing \(Look into failed CI is off in Debug › Settings\)/ })).toBeDefined()
  await ui.press({ key: 'ci-mode' })
  await env.clock.settle()
  expect(env.toasts).toContain('CI passive here: a failed check gives a toast Nothing shows while CI finished toast is off in Debug › Settings.')
  expect(await ui.find({ type: 'Text', text: /on a failed check: nothing \(CI finished toast is off in Debug › Settings\)/ })).toBeDefined()
  await ui.unmount()
})
