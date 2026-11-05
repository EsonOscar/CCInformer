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
// Per-check CI, for the tests where checks fail one by one while others still run: each check is one job of run 100.
type Bucket = 'pending' | 'fail' | 'pass'
const JOBS: Record<string, number> = { lint: 11, build: 12, e2e: 13 }
const checksOf = (state: Record<string, Bucket>) =>
  JSON.stringify(
    Object.entries(state).map(([name, bucket]) => ({ name, workflow: 'CI', bucket, startedAt: '', completedAt: '', link: `https://github.com/acme/shop/actions/runs/100/job/${JOBS[name]}` })),
  )
// The repo's recent runs, for likely-flaky checks: run 500, of another commit an hour before the mocked clock's now,
// was rerun, and its e2e job failed in attempt 1 and passed in attempt 2.
const RERUNS = JSON.stringify([
  { databaseId: 500, attempt: 2, headSha: 'other0', createdAt: new Date(1_000_000 - 3_600_000).toISOString(), url: 'https://github.com/acme/shop/actions/runs/500' },
])
const RERUN_JOBS_READ = 'gh api repos/acme/shop/actions/runs/500/jobs?filter=all&per_page=100'
const RERUN_JOBS = JSON.stringify({
  total_count: 2,
  jobs: [
    { name: 'e2e', workflow_name: 'CI', run_attempt: 1, conclusion: 'failure' },
    { name: 'e2e', workflow_name: 'CI', run_attempt: 2, conclusion: 'success' },
  ],
})
// A finished job's whole log as the API gives it: a byte-order mark, a timestamp on each line, the clean-up after.
const rawLog = (job: string) =>
  [
    '﻿2026-01-02T03:04:05.1234567Z ##[group]Run npm test',
    `2026-01-02T03:04:06.0000000Z job ${job}: x is unused`,
    '2026-01-02T03:04:06.5000000Z ##[error]Process completed with exit code 1.',
    '2026-01-02T03:04:07.0000000Z Post job cleanup.',
    '',
  ].join('\n')

// A repo on feat/cart (commit abc1234...) with PR #7, whose lint check is pending until `ci.bucket` says it failed. gh
// answers the failed job's log and the PR's diff. Submits, toasts and every command are recorded; a submit is refused
// when `submitDrop` is set. `mode` seeds the repo's CI mode in the shared store, `permissions` the Settings choices;
// with `slowLog`, the failed job's log takes 10 s of the mocked clock to read. `pack` is a user pack's text for the repo,
// and `diff` what gh answers for the PR's diff. `ci.state`, once set, gives each check's bucket instead of `ci.bucket`;
// while a check is pending, gh refuses a job's failed steps (as it does until the whole run ends) and the API gives the
// job's raw log. `claims` seeds the claims other sessions made; with `gate`, a hand-off's submit resolves only once
// `release()` is called (its turn has started).
const PACK_FILE = '/home/test/.claude/ccinformer/packs/shop.pack.jsonc'
const engine = (
  on: Parameters<TestBody>[1],
  opts: {
    mode?: 'active'
    submitDrop?: string
    permissions?: object
    slowLog?: boolean
    pack?: string
    diff?: string
    claims?: object[]
    gate?: boolean
    reruns?: { exitCode: number }
  } = {},
) => {
  const ci = { bucket: 'pending' as 'pending' | 'fail', state: null as Record<string, Bucket> | null }
  const submits: { text: string; origin: { kind: string } }[] = []
  const toasts: string[] = []
  const commands: string[] = []
  let opened = () => {}
  const gate = { held: opts.gate ? new Promise<void>(resolve => (opened = resolve)) : Promise.resolve(), release: () => opened() }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {
    ...(opts.mode ? { ['ciMode:' + REPO_KEY]: opts.mode } : {}),
    ...(opts.claims ? { ['ciInvestigated:' + REPO_KEY]: opts.claims } : {}),
    permissions: opts.permissions ?? { base: 'defaults', set: {} },
  })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  const isPack = (path: string) => !!opts.pack && path.replace(/\\/g, '/').replace(/^[a-z]:/i, '') === PACK_FILE
  on('fs.exists', (_, e) => ({ value: isPack(e.path) }))
  on('fs.read', (_, e) => ({ value: isPack(e.path) ? opts.pack : null }) as never)
  on('fs.stat', (_, e) => ({ value: isPack(e.path) ? { kind: 'file', size: opts.pack!.length, mtimeMs: 1 } : null }) as never)
  on('fs.list', (_, e) =>
    ({ value: opts.pack && PACK_FILE.startsWith(e.path.replace(/\\/g, '/').replace(/^[a-z]:/i, '') + '/') ? [{ name: 'shop.pack.jsonc', kind: 'file', mtimeMs: 1 }] : [] }) as never,
  )
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
    const buckets = ci.state ? Object.values(ci.state) : []
    if (line.startsWith('gh pr checks') && ci.state) return out(checksOf(ci.state), buckets.includes('pending') ? 8 : buckets.includes('fail') ? 1 : 0)
    if (line.startsWith('gh pr checks')) return out(prChecks(ci.bucket), ci.bucket === 'fail' ? 1 : 8)
    if (line.startsWith('gh run list --created') && opts.reruns) return out(RERUNS, opts.reruns.exitCode)
    if (line === RERUN_JOBS_READ) return out(RERUN_JOBS)
    if (line.startsWith('gh run list')) return out('[]')
    if (/^gh run view --job \d+ --log-failed$/.test(line) && buckets.includes('pending'))
      return { value: { exitCode: 1, stdout: '', stderr: 'run 100 is still in progress; logs will be available when it is complete', isStdoutTruncated: false, isStderrTruncated: false } }
    const api = /^gh api repos\/acme\/shop\/actions\/jobs\/(\d+)\/logs$/.exec(line)
    if (api) return out(rawLog(api[1]!))
    if (line === 'gh run view --job 11 --log-failed') return out('lint\tRun eslint\terror  no-unused-vars: x is unused\n')
    if (line === 'gh pr diff 7') return out(opts.diff ?? '+const x = 1\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('prompt.submit', async (_, e) => {
    submits.push(e as never)
    if (e.text.startsWith('ccinformer-ci:')) await gate.held
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
  return { clock, ci, submits, toasts, commands, gate }
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

test("the hand-off leaves the pack's generated output out of the diff, and names it", CLOCK_HEAVY, async ($, on) => {
  const pack = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] },
    "noise": [{ "id": "dist", "glob": "dist/**", "kind": "generated" }] }`
  const section = (path: string, line: string) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-x', '+' + line].join('\n')
  const diff = [section('src/cart.ts', 'const x = 1'), section('dist/app.js', 'bundled()'), ''].join('\n')
  const env = engine(on, { mode: 'active', pack, diff })
  await failCi($, env)
  const text = handoffs(env)[0]!.text
  expect(text).toContain('+const x = 1')
  expect(text).not.toContain('bundled()')
  expect(text).toContain('Left out as noise (generated or editor rewrites only): dist/app.js; read them if they matter.')
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
  // The button draws its key (i) itself, so its label is the mode it switches to, alone.
  expect(await ui.find({ key: 'ci-mode', text: 'passive' })).toBeDefined()

  await ui.press({ key: 'ci-mode' })
  await env.clock.settle()
  expect(env.toasts).toContain('CI passive here: a failed check gives a toast')
  expect(await ui.find({ type: 'Text', text: /on a failed check: a toast/ })).toBeDefined()
  expect(await ui.find({ key: 'ci-mode', text: 'active' })).toBeDefined()
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

// Early hand-offs: checks fail one by one while others still run. `startOn` reads CI once with every check as given,
// `poll` sets the checks and reads CI again (the claim reads itself back after a second).
const startOn = async ($: Dollar, env: Env, state: Record<string, Bucket>) => {
  env.ci.state = state
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
}
const poll = async ($: Dollar, env: Env, state: Record<string, Bucket>) => {
  env.ci.state = state
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  await env.clock.advance(1000)
  await env.clock.settle()
}
const EARLY_TOAST = 'A CI check failed while others still run: Claude looks into it in a turn of its own (read-only)'

test('active: a check that fails while others run is handed over at once, its log read through the API; the end hands nothing more', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await startOn($, env, { lint: 'pending', build: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending' })
  expect(handoffs(env).length).toBe(1)
  const text = handoffs(env)[0]!.text
  expect(env.commands).toContain('gh run view --job 11 --log-failed')
  expect(env.commands).toContain('gh api repos/acme/shop/actions/jobs/11/logs')
  expect(text).toContain('##[group]Run npm test\njob 11: x is unused\n##[error]Process completed with exit code 1.')
  expect(text).not.toContain('2026-01-02T')
  expect(text).not.toContain('Post job cleanup')
  expect(text).toContain("Still running: build (not part of this hand-off; CI hasn't finished).")
  expect(env.toasts).toContain(EARLY_TOAST)

  await poll($, env, { lint: 'fail', build: 'pass' })
  expect(env.toasts).toContain('✗ CI failed on PR #7: lint')
  expect(handoffs(env).length).toBe(1)
})

test('active: a check that fails on a later poll gets a hand-off of its own, naming the one before', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await startOn($, env, { lint: 'pending', build: 'pending', e2e: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending', e2e: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending', e2e: 'fail' })
  expect(handoffs(env).length).toBe(2)
  const second = handoffs(env)[1]!.text
  expect(second).toContain('- e2e (CI):')
  expect(second).not.toContain('- lint (CI):')
  expect(second).toContain('job 13: x is unused')
  expect(second).toContain('Handed over earlier for this commit: lint.')

  await poll($, env, { lint: 'fail', build: 'pass', e2e: 'fail' })
  expect(handoffs(env).length).toBe(2)
})

test("one hand-off at a time: the next waits until the turn before it has started, and that turn stays read-only", CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', gate: true })
  const edit = () => $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
  await startOn($, env, { lint: 'pending', build: 'pending', e2e: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending', e2e: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending', e2e: 'fail' })
  // The first hand-off still waits for its turn: the second isn't submitted.
  expect(handoffs(env).length).toBe(1)

  await $.turn.start({ text: `${MARKER}\nlogs`, turnId: 'first' })
  env.gate.release()
  await env.clock.settle()
  await env.clock.advance(1000)
  await env.clock.settle()
  expect(handoffs(env).length).toBe(2)
  expect(handoffs(env)[1]!.text.split('\n')[0]).toBe('ccinformer-ci:abc1234-2')
  // The second hand-off's marker didn't take the first turn's guard away.
  expect(isDenied(await edit())).toBe(true)
  await $.turn.complete(mainEnd('first'))
  await $.turn.start({ text: 'ccinformer-ci:abc1234-2\nlogs', turnId: 'second' })
  expect(isDenied(await edit())).toBe(true)
})

test("a check another session claimed isn't handed over again, nor its log read", CLOCK_HEAVY, async ($, on) => {
  const head = 'abc1234def5678'
  const byCheck = engine(on, { mode: 'active', claims: [{ head, session: 'other-session', check: 'CI/lint' }] })
  await startOn($, byCheck, { lint: 'pending', build: 'pending' })
  await poll($, byCheck, { lint: 'fail', build: 'pending' })
  expect(handoffs(byCheck)).toEqual([])
  expect(byCheck.commands.some(c => c.startsWith('gh run view') || c.startsWith('gh api'))).toBe(false)
})

test('an older version claimed the whole commit: nothing is handed over', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', claims: [{ head: 'abc1234def5678', session: 'other-session' }] })
  await startOn($, env, { lint: 'pending', build: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending' })
  expect(handoffs(env)).toEqual([])
})

test('passive: a check that fails while others run gives a toast at once, then the end toast; no hand-off', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on)
  await startOn($, env, { lint: 'pending', build: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending' })
  expect(env.toasts).toContain('✗ CI check failed on PR #7: lint (1 still running)')
  expect(env.toasts).not.toContain(EARLY_TOAST)
  await poll($, env, { lint: 'fail', build: 'pass' })
  expect(env.toasts).toContain('✗ CI failed on PR #7: lint')
  expect(handoffs(env)).toEqual([])
})

test('passive with the CI finished toast off: no early toast either', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { permissions: { base: 'defaults', set: { 'notify.ciToast': false } } })
  await startOn($, env, { lint: 'pending', build: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending' })
  expect(env.toasts.filter(t => t.startsWith('✗'))).toEqual([])
})

test('Look into failed CI off: an early failure in an active repo reads nothing and hands nothing over', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', permissions: { base: 'defaults', set: { 'claude.ciHandoff': false } } })
  await startOn($, env, { lint: 'pending', build: 'pending' })
  await poll($, env, { lint: 'fail', build: 'pending' })
  expect(handoffs(env)).toEqual([])
  expect(env.commands.some(c => c.startsWith('gh api'))).toBe(false)
})

test('asked while CI still runs: the failed job is read through the API and handed over', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on)
  await startOn($, env, { lint: 'pending', build: 'pending' })
  env.ci.state = { lint: 'fail', build: 'pending' }
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'ci investigate' })
  await env.clock.settle()
  expect(handoffs(env).length).toBe(1)
  expect(handoffs(env)[0]!.text).toContain('job 11: x is unused')
})

test("asked in an active repo when the ask's own refresh first sees the failure: one hand-off", CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active' })
  await startOn($, env, { lint: 'pending', build: 'pending' })
  env.ci.state = { lint: 'fail', build: 'pending' }
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'ci investigate' })
  await env.clock.settle()
  await env.clock.advance(1000)
  await env.clock.settle()
  expect(handoffs(env).length).toBe(1)
})

// Likely-flaky checks: the fixture's e2e job failed and then passed on a rerun of another commit; lint has no such past.
const flakyLists = (env: Env) => env.commands.filter(c => c.startsWith('gh run list --created')).length
const FLAKY_LINE = '(likely flaky: failed, then passed on a rerun, in 1 other run in the last 7 days)'

test('a failed check whose job lately flaked elsewhere is marked in the row, the hand-off and the toast; the reruns are read once', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', reruns: { exitCode: 0 } })
  await startOn($, env, { lint: 'pending', e2e: 'pending', build: 'pending' })
  expect(flakyLists(env)).toBe(0)
  await poll($, env, { lint: 'fail', e2e: 'fail', build: 'pass' })
  expect(env.toasts).toContain('✗ CI failed on PR #7: lint, e2e (likely flaky)')
  const text = handoffs(env)[0]!.text
  expect(text).toContain(`- e2e (CI): https://github.com/acme/shop/actions/runs/100/job/13 ${FLAKY_LINE}`)
  expect(text).toContain('- lint (CI): https://github.com/acme/shop/actions/runs/100/job/11\n')
  expect(text).toContain('Say whether this failure looks like that flakiness or like a real break from these changes')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text', text: /likely flaky/ })).length).toBe(1)
  await ui.unmount()

  await poll($, env, { lint: 'fail', e2e: 'fail', build: 'pass' })
  expect(flakyLists(env)).toBe(1)
})

test('passive: a likely-flaky check that fails while others run is marked in the early toast', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { reruns: { exitCode: 0 } })
  await startOn($, env, { e2e: 'pending', build: 'pending' })
  await poll($, env, { e2e: 'fail', build: 'pending' })
  expect(env.toasts).toContain('✗ CI check failed on PR #7: e2e (likely flaky) (1 still running)')
})

test('active: a failure that is only a likely-flaky check is still handed over, marked', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', reruns: { exitCode: 0 } })
  await startOn($, env, { e2e: 'pending', build: 'pending' })
  await poll($, env, { e2e: 'fail', build: 'pass' })
  expect(handoffs(env).length).toBe(1)
  expect(handoffs(env)[0]!.text).toContain(FLAKY_LINE)
})

test("gh can't list the runs: nothing is marked, and the list isn't asked again on the next poll", CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', reruns: { exitCode: 1 } })
  await startOn($, env, { lint: 'pending', e2e: 'pending' })
  await poll($, env, { lint: 'fail', e2e: 'pending' })
  await poll($, env, { lint: 'fail', e2e: 'fail' })
  expect(flakyLists(env)).toBe(1)
  expect(env.toasts.some(t => t.includes('likely flaky'))).toBe(false)
  expect(handoffs(env).some(h => h.text.includes('likely flaky'))).toBe(false)
})

test("no failed check: the repo's reruns aren't read", CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { mode: 'active', reruns: { exitCode: 0 } })
  await startOn($, env, { lint: 'pending', e2e: 'pending' })
  await poll($, env, { lint: 'pass', e2e: 'pass' })
  expect(flakyLists(env)).toBe(0)
})
