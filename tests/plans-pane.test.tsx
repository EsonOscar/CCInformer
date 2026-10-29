import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 300 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
// The tests that run the clock for minutes take a while of real time.
const CLOCK_HEAVY = { timeoutMs: 20_000 }

const PACKS = '/home/test/.claude/ccinformer/packs'
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })
const USER_PACK = JSON.stringify({
  schema: 1,
  id: 'acme-shop',
  version: '1',
  match: { remote: ['github.com/acme/*'] },
  extends: ['node-vite'],
  // `plans/**` reaches the archive folder too, so only `archiveDir` keeps it off the board.
  plans: { globs: ['plans/**/*.md', 'docs/**/*.plan.md'], archiveDir: 'plans/archive' },
})
const BACKEND = [
  '# Shop backend',
  '### R1: hosting move \u2014 ✅ DONE',
  '### R2: the API \u2014 🟡 PARTLY (#20, #21)',
  '### R3: reports \u2014 ⬜ TODO',
].join('\n')

const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo at /repo whose user pack names plan files; `reads` counts each file's reads, and `change` edits one.
// `prs` is GitHub's state for each PR gh knows (any other fails, as gh does; a test may change it), `asked` counts each
// PR's lookups, and `toasts` holds what was toasted.
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>, prs: Record<number, string> = {}) => {
  const all: Record<string, string> = { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: USER_PACK, ...files }
  const mtimes: Record<string, number> = {}
  const reads: Record<string, number> = {}
  const asked: Record<number, number> = {}
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in all }))
  on('fs.read', (_, e) => {
    const path = posix(e.path)
    reads[path] = (reads[path] ?? 0) + 1
    return { value: all[path] ?? null } as never
  })
  on('fs.stat', (_, e) => {
    const path = posix(e.path)
    return { value: path in all ? { kind: 'file', size: all[path]!.length, mtimeMs: mtimes[path] ?? 1 } : null } as never
  })
  // A folder lists its files and its subfolders, one level.
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = new Map<string, string>()
    for (const p of Object.keys(all).filter(p => p.startsWith(dir))) {
      const [first, ...more] = p.slice(dir.length).split('/')
      names.set(first!, more.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, mtimeMs: 1 })) } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git check-ignore')) return out('', 0)
    if (line.startsWith('git status')) return out('# branch.oid abc123\n# branch.head main\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    const pr = line.match(/^gh pr view (\d+) --json state$/)
    if (pr) {
      const n = Number(pr[1])
      asked[n] = (asked[n] ?? 0) + 1
      return prs[n] ? out(JSON.stringify({ state: prs[n] })) : out('', 1)
    }
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const change = (path: string, text: string) => {
    all[path] = text
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  return { clock, reads, change, asked, toasts }
}

test("Work › Plans lists each plan file's checkpoints, leaving out the archive and files that define none", async ($, on) => {
  const { clock } = engine(on, {
    '/repo/plans/backend.md': BACKEND,
    '/repo/plans/notes.md': '# Notes\nNothing planned here; R4 is only mentioned.',
    '/repo/plans/archive/old.md': '# Old\n### R9: archived \u2014 ✅',
    '/repo/docs/web/editor.plan.md': '# Editor\n### PR 1, previews \u2014 merged as #353\n### PR 2, tiles',
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: '▍BACKEND.MD' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/3 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '#20 #21' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▍EDITOR.PLAN.MD' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/2 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▍NOTES.MD' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /R9/ })).toBeUndefined()
  const marks = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => ['✓', '◐', '○'].includes(t))
  // Files in path order: docs/web/editor.plan.md (PR 1, PR 2), then plans/backend.md (R1, R2, R3).
  expect(marks).toEqual(['✓', '○', '✓', '◐', '○'])
  await ui.unmount()
})

test('r reads the plans again, parsing only the files that changed', async ($, on) => {
  const { clock, reads, change } = engine(on, { '/repo/plans/backend.md': BACKEND, '/repo/plans/other.md': '# Other\n### C1: first' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(reads['/repo/plans/backend.md']).toBe(1)

  change('/repo/plans/backend.md', BACKEND.replace('R3: reports \u2014 ⬜ TODO', 'R3: reports \u2014 merged as #30'))
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '2/3 done' })).toBeDefined()
  expect(reads['/repo/plans/backend.md']).toBe(2)
  expect(reads['/repo/plans/other.md']).toBe(1)
  await ui.unmount()
})

test('.local/plans/ is read in every repo, its archive left out, even when the pack names no plans', async ($, on) => {
  const { clock } = engine(on, {
    [PACKS + '/shop.pack.jsonc']: USER_PACK.replace(/,"plans":\{[^}]*\}/, ''),
    '/repo/.local/plans/2026-10-29-search.md': '# Search\n### CP1: index \u2014 merged as #41\n### CP2: results page',
    '/repo/.local/plans/archive/2026-09-01-old.md': '# Old\n### CP1: done long ago \u2014 done',
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '▍2026-10-29-SEARCH.MD' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/2 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2026-09-01-OLD/ })).toBeUndefined()
  await ui.unmount()
})

test('with no plans anywhere, the board says where a plan goes', async ($, on) => {
  const { clock } = engine(on, { [PACKS + '/shop.pack.jsonc']: USER_PACK.replace(/,"plans":\{[^}]*\}/, '') })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No plans yet: a plan in \.local\/plans\// })).toBeDefined()
  await ui.unmount()
})

// C1 is done (its PR needn't be asked about); C2 and C3 are open, C4 partly. GitHub: #42 merged, #43 closed, #44 open,
// and #45 unknown to gh.
const SEARCH = [
  '# Search',
  '### C1: index \u2014 merged as #41',
  '### C2: results page (#42)',
  '### C3: filters (#43, #44)',
  '### C4: sorting \u2014 🟡 PARTLY (#45)',
].join('\n')
const SEARCH_PRS = { 41: 'MERGED', 42: 'MERGED', 43: 'CLOSED', 44: 'OPEN' }
const NO_PLANS_IN_PACK = USER_PACK.replace(/,"plans":\{[^}]*\}/, '')

test("GitHub is asked only about an open checkpoint's PRs, and again only about those still open", async ($, on) => {
  const { clock, asked } = engine(on, { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, '/repo/.local/plans/2026-10-29-search.md': SEARCH }, SEARCH_PRS)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(asked).toEqual({ 42: 1, 43: 1, 44: 1, 45: 1 })

  // Merged and closed stay that way; the open PR and the one gh couldn't read are asked about again.
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(asked).toEqual({ 42: 1, 43: 1, 44: 2, 45: 2 })

  // The board keeps the plan's own statuses, whatever GitHub says.
  expect(await ui.find({ type: 'Text', text: '1/4 done' })).toBeDefined()
  const marks = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => ['✓', '◐', '○'].includes(t))
  expect(marks).toEqual(['✓', '○', '○', '◐'])
  await ui.unmount()
})

test('a merged PR on a checkpoint that reads open is a warning, and a plan with nothing left reads ready to archive', async ($, on) => {
  const { clock } = engine(
    on,
    {
      [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK,
      '/repo/.local/plans/2026-10-29-search.md': SEARCH,
      // Done and dropped: finished. Its done checkpoint names a merged PR, which is no warning.
      '/repo/.local/plans/2026-10-01-login.md': '# Login\n### C1: form \u2014 done (#42)\n### C2: reset \u2014 dropped',
      '/repo/.local/plans/2026-10-20-cart.md': '# Cart\n### C1: totals (#50)\n### C2: coupons (#51)',
    },
    { ...SEARCH_PRS, 50: 'MERGED', 51: 'MERGED' },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Search: C2's #42 merged; C3's #43 closed and #44 open, so its PRs show as before.
  expect((await ui.findAll({ type: 'Text', text: '⚠ #42 merged' })).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: '#43 #44' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 1 checkpoint names a merged PR but reads open: update the plan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/4 done' })).toBeDefined()
  // Cart: both rows warned, counted in the plural.
  expect(await ui.find({ type: 'Text', text: '⚠ #50 merged' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 2 checkpoints name a merged PR but read open: update the plan$/ })).toBeDefined()
  // Login: finished, its merged #42 shown plainly.
  expect(await ui.find({ type: 'Text', text: '#42' })).toBeDefined()
  const finished = await ui.findAll({ type: 'Text', text: /ready to archive/ })
  expect(finished.map(t => t.text.trim())).toEqual(['✓ Every checkpoint is done or dropped: ready to archive'])
  // The plans' own statuses: login ✓ –, cart ○ ○, search ✓ ○ ○ ◐.
  const marks = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => ['✓', '◐', '○', '–'].includes(t))
  expect(marks).toEqual(['✓', '–', '○', '○', '✓', '○', '○', '◐'])
  await ui.unmount()
})

test('a finished plan with nothing dropped reads done', async ($, on) => {
  const { clock } = engine(on, {
    [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK,
    '/repo/.local/plans/2026-10-01-login.md': '# Login\n### C1: form \u2014 done\n### C2: reset \u2014 merged as #7',
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Every checkpoint is done: ready to archive$/ })).toBeDefined()
  await ui.unmount()
})

test('while Work › Plans shows, a checkpoint marked done shows within 5 s, asking GitHub only about a new PR', async ($, on) => {
  const { clock, asked, change } = engine(
    on,
    { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, '/repo/.local/plans/2026-10-29-search.md': SEARCH },
    { ...SEARCH_PRS, 46: 'MERGED' },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '1/4 done' })).toBeDefined()

  change('/repo/.local/plans/2026-10-29-search.md', SEARCH.replace('### C2: results page (#42)', '### C2: results page, done (#42)') + '\n### C5: export (#46)')
  await clock.advance(5000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '2/5 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⚠ #46 merged' })).toBeDefined()
  // The new #46 once; the open #44 and the unreadable #45 wait for a recheck (opening the view, r, or the minute's).
  expect(asked).toEqual({ 42: 1, 43: 1, 44: 1, 45: 1, 46: 1 })
  await ui.unmount()
})

test('while Work › Plans shows, open PRs are asked about again each minute; one that merged raises a toast and the badge', CLOCK_HEAVY, async ($, on) => {
  const prs: Record<number, string> = { ...SEARCH_PRS }
  const { clock, asked, toasts } = engine(on, { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, '/repo/.local/plans/2026-10-29-search.md': SEARCH }, prs)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'area-work', text: /!/ })).toBeDefined()

  // #44 merges on GitHub; the 5 s poll doesn't ask about it, the minute's recheck does.
  prs[44] = 'MERGED'
  await clock.advance(5000)
  await clock.settle()
  expect([asked[44], toasts]).toEqual([1, []])
  await clock.advance(55_000)
  await clock.settle()
  expect(asked[44]).toBe(2)
  expect(toasts).toEqual(['PR #44 merged, but C3 in 2026-10-29-search.md still reads open'])
  expect(await ui.find({ type: 'Text', text: '⚠ #44 merged' })).toBeDefined()
  await ui.unmount()
})

test('away from Work › Plans, open PRs are asked about every 10 minutes in an active session, pane closed or not', CLOCK_HEAVY, async ($, on) => {
  const prs: Record<number, string> = { 44: 'OPEN' }
  const { clock, asked, toasts } = engine(on, { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, '/repo/.local/plans/2026-10-29-search.md': SEARCH }, prs)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  // A turn that runs throughout keeps the session active; the pane stays closed.
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
  await clock.advance(600_000)
  await clock.settle()
  expect(asked[44]).toBe(1)

  prs[44] = 'MERGED'
  await clock.advance(600_000)
  await clock.settle()
  expect(asked[44]).toBe(2)
  expect(toasts).toEqual(['PR #44 merged, but C3 in 2026-10-29-search.md still reads open'])
  // Opened on another area, Work's badge says a plan wants updating.
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'code' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'area-work', text: /!/ })).toBeDefined()
  await ui.unmount()
})
