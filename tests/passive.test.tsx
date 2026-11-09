import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Minutes of mocked time, a tick at a time: slow in real time on a busy machine, which says nothing about the mod.
const CLOCK_HEAVY = { timeoutMs: 60_000 }

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
const BAND = {
  plugin: 'ccinformer',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PACKS = '/home/test/.claude/ccinformer/packs'
const PACKAGE = JSON.stringify({ devDependencies: { vite: '^5.0.0' }, scripts: { e2e: 'playwright test', 'dev:staging': 'vite --mode staging' } })
// The shop's own pack: files under src/ get a 3-line limit, and the staging environment is shared.
const USER_PACK = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] }, "extends": ["node-vite"],
  "environments": [{ "id": "staging", "label": "staging", "tone": "shared", "argRegex": "--mode[= ]staging\\\\b" }],
  "checks": [{ "id": "max-lines", "label": "File length", "on": ["src/**/*.ts"], "analyzer": "size-lines", "cost": "edit", "class": "ci",
    "rules": ["max-lines"], "options": { "max": 3 } },
    { "id": "tidy", "label": "tidy", "on": ["src/**/*.ts"], "analyzer": "problem-matcher", "cost": "turn", "class": "advise", "bin": ["tidy", "{files}"],
      "options": { "pattern": "^(?<file>[^:]+):(?<line>\\\\d+): (?<message>.*)$" } },
    { "id": "scenes", "label": "Scene node paths", "on": ["**/*.tscn", "**/*.cs"], "analyzer": "tscn-nodepaths", "cost": "turn", "class": "advise" }] }`
// A plan whose open checkpoint names PR #9, which GitHub says is still open.
const PLAN = '# Cart\n### CP1: cart page (#9)\n'
// An invented Godot C# game, and the telemetry file its autoload wrote while it ran.
const GODOT_PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="Lantern"\n\n[dotnet]\n\nproject/assembly_name="Lantern"\n'
const GODOT_TELEMETRY = JSON.stringify({ schema: 1, startedAt: 0, errorSource: 'logger', errorCount: 0, samples: [{ t: 1_000_000, fps: 60, slowestFrameMs: 16.7, slowestPhysicsMs: 2, drawCalls: 10, objects: 100, memMb: 50 }], errors: [], screenshot: null })
const PR = JSON.stringify({ number: 7, title: 'Cart', url: 'https://github.com/acme/shop/pull/7', baseRefName: 'main', isDraft: false, state: 'OPEN' })
const checks = (bucket: 'pending' | 'fail') =>
  JSON.stringify([{ name: 'lint', workflow: 'CI', bucket, startedAt: '', completedAt: '', link: 'https://github.com/acme/shop/actions/runs/100/job/11' }])
const DENY_ALL = { base: 'off', set: {} }
const SESSION_KEY = 'session:self-session-id'
// The pack read, which runs whatever the switches say: it reads the mod's own config. Nothing in a pack read asks
// git what it ignores, so a check-ignore here was asked for by something else.
const PACK_READ = /^git (rev-parse --show-toplevel --git-common-dir|config --get remote\.origin\.url)/

const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i}`).join('\n') + '\n'
const turnEnd = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' }) as never

// A Vite repo on feat/cart with PR #7, whose lint check is pending until `ci.bucket` says it failed; a plan naming PR #9;
// ESLint installed. Every command, toast, notification, status, question, pane opening and plugin prompt is recorded,
// and the store is open to the test.
// With `godot`, the repo is a Godot C# game instead, with a telemetry file its autoload wrote.
const engine = (on: Parameters<TestBody>[1], seed: Record<string, unknown> = {}, opts: { userPack?: boolean; godot?: boolean } = {}) => {
  const files: Record<string, string> = opts.godot
    ? { '/repo/project.godot': GODOT_PROJECT, '/repo/.local/telemetry/telemetry.json': GODOT_TELEMETRY }
    : {
        '/repo/package.json': PACKAGE,
        '/repo/node_modules/eslint/bin/eslint.js': '',
        '/repo/.local/plans/2026-10-30-cart.md': PLAN,
        ...(opts.userPack === false ? {} : { [PACKS + '/shop.pack.jsonc']: USER_PACK }),
      }
  const ci = { bucket: 'pending' as 'pending' | 'fail' }
  const seen = {
    commands: [] as string[],
    toasts: [] as string[],
    notifies: [] as string[],
    statuses: [] as string[],
    asks: [] as string[],
    opens: 0,
    submits: [] as string[],
    contexts: [] as string[],
    writes: [] as string[],
    tools: [] as string[],
    stats: [] as string[],
    reads: [] as string[],
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const store = new Map<string, unknown>(Object.entries(seed))
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
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
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => {
    seen.reads.push(posix(e.path))
    return { value: files[posix(e.path)] ?? null } as never
  })
  on('fs.write', (_, e) => {
    seen.writes.push(posix(e.path))
    files[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    seen.stats.push(posix(e.path))
    return { value: posix(e.path) in files ? { kind: 'file', size: files[posix(e.path)]!.length, mtimeMs: 1 } : null } as never
  })
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: 1 })) } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    seen.commands.push(line)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git status')) return out('# branch.oid abc1234def5678\n# branch.head feat/cart\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    if (line === 'gh pr view 9 --json state') return out('{"state":"OPEN"}')
    if (line.startsWith('gh pr view')) return out(PR)
    if (line.startsWith('gh pr checks')) return out(checks(ci.bucket), ci.bucket === 'fail' ? 1 : 8)
    if (line.startsWith('gh run list')) return out('[]')
    if (line.includes('eslint')) return out('[]')
    if (line.startsWith('tidy ')) return out('')
    if (line === 'cat /proc/meminfo') return out('MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      seen.asks.push((e as unknown as { questions: { question: string }[] }).questions[0]!.question)
      return { result: { questions: [], answers: {} }, text: '' } as never
    }
    if (e.tool === 'Write') {
      const write = e as unknown as { file_path: string; content: string }
      files[posix(write.file_path)] = write.content
      return { result: { type: 'create', filePath: write.file_path, content: write.content, structuredPatch: [] }, text: 'written' } as never
    }
    if (e.tool === 'Bash') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' }, text: 'ok' } as never
    return { result: {}, text: 'ok' }
  })
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin') seen.submits.push(e.text)
    else seen.contexts.push(...(e.context ?? []))
    return { text: e.text, context: e.context } as never
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    seen.notifies.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.status', (_, e) => {
    if (e.text !== undefined) seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => {
    seen.opens += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="nothing" />
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => {
    const name = (e as unknown as { name: string }).name
    seen.tools.push(name)
    return { value: { tool: 'mcp__ccinformer__' + name } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, ci, seen, store, files }
}

type Env = ReturnType<typeof engine>
type Dollar = Parameters<TestBody>[0]

// A working session: the person opens Code (CI reads pending) and closes the pane again; from here on nothing the
// person does asks for anything in the background. Claude starts the end-to-end tests in the background, writes a file
// past its limit, pushes, ends its turn; the person types; CI fails; Now › Sessions is opened and closed; then a long turn
// runs past the 10-minute mark. Returns how many commands had run when the person closed the pane, and the Write's result.
// `atStart` looks at the session right after it started, before the person does anything.
const workingSession = async ($: Dollar, env: Env, atStart: () => void = () => {}) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  atStart()
  const opensAtStart = env.seen.opens
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  await env.clock.settle()
  const mark = env.seen.commands.length

  await $.turn.start({ text: 'add the cart', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm run e2e', run_in_background: true })
  const written = await $.tool.call({ tool: 'Write', file_path: '/repo/src/cart.ts', content: lines(5) })
  await $.tool.call({ tool: 'Write', file_path: '/repo/atrium/lobby.tscn', content: '[node name="Lobby" type="Control"]\n' })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await env.clock.advance(2000)
  await $.turn.complete(turnEnd('t1'))
  await env.clock.settle()
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  env.ci.bucket = 'fail'
  await env.clock.advance(20_000)
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'sessions' })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  // A long turn keeps the session active past the 10-minute background checks.
  await $.turn.start({ text: 'and the rest', turnId: 't2' })
  await env.clock.advance(600_000)
  await env.clock.settle()
  return { mark, opensAtStart, written }
}

test('an install that ran an older version (other keys, nothing chosen) does all it did before', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { isOpen: true })
  const { opensAtStart, written } = await workingSession($, env)
  expect(opensAtStart).toBe(1)
  expect(written.context?.join('\n')).toContain('5 lines, over the limit of 3')
  expect(env.seen.commands).toContain('gh pr view 9 --json state')
  expect(env.seen.commands).toContain('cat /proc/meminfo')
  expect(env.seen.commands.some(c => c.includes('eslint'))).toBe(true)
  expect(env.seen.commands).toContain('tidy src/cart.ts')
  // The scene check reads git once a turn that wrote a scene ends: the commit first.
  expect(env.seen.commands).toContain('git rev-parse HEAD')
  expect(env.seen.toasts).toContain('✗ CI failed on PR #7: lint')
  expect(env.seen.notifies).toContain('CI failed on PR #7: lint')
  expect(env.store.has(SESSION_KEY)).toBe(true)
  // Pinned at the first read, with no first-open marker.
  expect(env.store.get('permissions')).toEqual({ base: 'defaults', set: {} })
  expect(env.store.has('settingsFirst')).toBe(false)
})

test('a new install (empty store): a working session runs nothing in the background, says nothing and tells Claude nothing', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on)
  const { mark, opensAtStart, written } = await workingSession($, env, () => {
    // Right after start: only the pack read, and only the Settings' own record in the store.
    expect(env.seen.commands.filter(c => !PACK_READ.test(c))).toEqual([])
    expect([...env.store.keys()].sort()).toEqual(['permissions', 'settingsFirst'])
    expect(env.store.get('permissions')).toEqual(DENY_ALL)
  })
  expect(opensAtStart).toBe(0)
  expect(env.seen.commands.slice(mark).filter(c => !PACK_READ.test(c))).toEqual([])
  expect(written.context).toBeUndefined()
  expect(env.seen.contexts).toEqual([])
  expect(env.seen.toasts).toEqual([])
  expect(env.seen.notifies).toEqual([])
  expect(env.seen.statuses).toEqual([])
  expect(env.seen.asks).toEqual([])
  expect(env.seen.submits).toEqual([])
  expect(env.seen.writes).toEqual([])
  // Beyond the Settings' record, only what the person's own actions wrote (opening Code, closing the pane).
  const own = ['permissions', 'settingsFirst', 'isOpen', 'columns', 'area', 'ciPinged']
  expect([...env.store.keys()].filter(k => !own.includes(k))).toEqual([])

  // What the person asks for still runs.
  const before = env.seen.commands.length
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  expect(env.seen.commands.slice(before).some(c => c.startsWith('git status'))).toBe(true)
})

test("a new install's first bare /ccinformer shows Settings and reads nothing for Code", async ($, on) => {
  const env = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  const mark = env.seen.commands.length
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  await env.clock.settle()
  expect(env.seen.opens).toBe(1)
  expect(env.seen.commands.slice(mark).filter(c => !PACK_READ.test(c))).toEqual([])
  expect(env.store.has('settingsFirst')).toBe(false)
})

test("a new install's second session reopens nothing, runs nothing by itself and keeps the choices", CLOCK_HEAVY, async ($, on) => {
  // What a new install's first session leaves behind when the person left the pane open on Code.
  const env = engine(on, { permissions: DENY_ALL, settingsFirst: true, isOpen: true, columns: 40, area: 'code' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.advance(60_000)
  expect(env.seen.opens).toBe(0)
  expect(env.store.get('permissions')).toEqual(DENY_ALL)
  expect(env.seen.commands.filter(c => !PACK_READ.test(c))).toEqual([])
})

test('with Deny all, a working session runs nothing in the background, says nothing and tells Claude nothing', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { isOpen: true, permissions: DENY_ALL, [SESSION_KEY]: { id: 'self-session-id' } })
  const { mark, opensAtStart, written } = await workingSession($, env)
  expect(opensAtStart).toBe(0)
  expect(env.seen.commands.slice(mark).filter(c => !PACK_READ.test(c))).toEqual([])
  expect(written.context).toBeUndefined()
  expect(env.seen.contexts).toEqual([])
  expect(env.seen.toasts).toEqual([])
  expect(env.seen.notifies).toEqual([])
  expect(env.seen.statuses).toEqual([])
  expect(env.seen.asks).toEqual([])
  expect(env.seen.submits).toEqual([])
  expect(env.store.has(SESSION_KEY)).toBe(false)

  // What the person asks for still runs.
  const before = env.seen.commands.length
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  await env.clock.settle()
  expect(env.seen.commands.slice(before).some(c => c.startsWith('git status'))).toBe(true)

  // So does the pack-checking tool: Claude calls it and it writes nothing, so no switch gates it (CONTRIBUTING).
  expect(env.seen.tools).toEqual(['check_pack'])
  const checked = await $.tool.call({ tool: 'mcp__ccinformer__check_pack' } as never)
  expect((JSON.parse(String((checked as { result: unknown }).result)) as { packsDir: string }).packsDir).toBe(PACKS)
})

test('CI finished notification off: the toast still comes, the desktop notification does not', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, { permissions: { base: 'defaults', set: { 'notify.ciOs': false } } })
  await workingSession($, env)
  expect(env.seen.toasts).toContain('✗ CI failed on PR #7: lint')
  expect(env.seen.notifies).toEqual([])
})

test('Reopen the pane off: a pane left open is not opened at the next start', async ($, on) => {
  const env = engine(on, { isOpen: true, permissions: { base: 'defaults', set: { 'show.paneReopen': false } } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  expect(env.seen.opens).toBe(0)
})

test('Ask about repo trust off: no question and no mark, the files wait; a trusted repo still runs ESLint', async ($, on) => {
  const env = engine(on, { permissions: { base: 'defaults', set: { 'ask.repoTrust': false } } }, { userPack: false })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2) })
  await $.turn.complete(turnEnd('t1'))
  await env.clock.settle()
  expect(env.seen.asks).toEqual([])
  expect(env.seen.commands.some(c => c.includes('eslint'))).toBe(false)
  expect([...env.store.keys()].some(k => k.startsWith('trustAsked:'))).toBe(false)
})

test('Ask about repo trust off does not stop a repo already trusted', async ($, on) => {
  const env = engine(on, { permissions: { base: 'defaults', set: { 'ask.repoTrust': false } } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2) })
  await $.turn.complete(turnEnd('t1'))
  await env.clock.settle()
  expect(env.seen.commands.some(c => c.includes('eslint'))).toBe(true)
})

// Starts a dev server aimed at staging in the background, and says whether the band shows it.
const isBandShown = async ($: Dollar, env: Env) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev:staging', run_in_background: true })
  const isShown = !!(await band.find({ type: 'Text', text: '⚠ STAGING' }))
  await band.unmount()
  return isShown
}

test('the band follows its own switch', async ($, on) => {
  expect(await isBandShown($, engine(on, { permissions: { base: 'defaults', set: { 'safety.envBand': false } } }))).toBe(false)
})

test('Deny all leaves the band on', async ($, on) => {
  expect(await isBandShown($, engine(on, { permissions: DENY_ALL }))).toBe(true)
})

test('the band shows on a new install', async ($, on) => {
  expect(await isBandShown($, engine(on))).toBe(true)
})

test('Tell other sessions switched off in another session takes this one out of their list within seconds', async ($, on) => {
  const env = engine(on, { permissions: { base: 'defaults', set: {} } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.advance(16_000)
  expect(env.store.has(SESSION_KEY)).toBe(true)
  env.store.set('permissions', { base: 'defaults', set: { 'bg.sessionBeat': false } })
  await env.clock.advance(5000)
  await env.clock.settle()
  expect(env.store.has(SESSION_KEY)).toBe(false)
  await env.clock.advance(30_000)
  expect(env.store.has(SESSION_KEY)).toBe(false)
})


test('a new install in a Godot game: with the pane closed or on Sessions, telemetry is never read and git is never asked what it ignores', CLOCK_HEAVY, async ($, on) => {
  const env = engine(on, {}, { godot: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'sessions' })
  await env.clock.advance(30_000)
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
  await env.clock.advance(300_000)
  await env.clock.settle()
  const telemetry = (paths: string[]) => paths.filter(p => p.includes('.local/telemetry'))
  expect(telemetry(env.seen.stats)).toEqual([])
  expect(telemetry(env.seen.reads)).toEqual([])
  expect(env.seen.commands.filter(c => c.startsWith('git check-ignore'))).toEqual([])
  expect(env.seen.writes).toEqual([])
})
