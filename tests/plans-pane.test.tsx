import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { markdownLinks } from '../hooks/plans/archive'

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
// PR's lookups, and `toasts` holds what was toasted. `all` is every file (written ones too; `rm` removes one), and a
// dialog is answered with `dialog.answer`, its questions kept in `dialog.questions`.
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>, prs: Record<number, string> = {}, stored: Record<string, unknown> = {}) => {
  const all: Record<string, string> = { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: USER_PACK, ...files }
  const mtimes: Record<string, number> = {}
  const reads: Record<string, number> = {}
  const asked: Record<number, number> = {}
  const toasts: string[] = []
  const dialog = { answer: 'Archive', questions: [] as string[] }
  on('fs.write', (_, e) => {
    if (posix(e.path).endsWith('/read-only.md')) throw new Error('EPERM: operation not permitted')
    all[posix(e.path)] = e.text
    mtimes[posix(e.path)] = (mtimes[posix(e.path)] ?? 1) + 1
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, stored)
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
    const rm = (e as { argv: string[] }).argv
    if (rm[0] === 'rm' && rm[1] === '--') {
      delete all[posix(rm[2]!)]
      return out('')
    }
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {}, text: 'ok' }
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    dialog.questions.push(question)
    return { result: { questions: [], answers: { [question]: dialog.answer } }, text: dialog.answer } as never
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const change = (path: string, text: string) => {
    all[path] = text
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  return { clock, reads, change, asked, toasts, all, dialog }
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

// A finished plan, and what refers to it: the dev plan by path, a note by a link, a memory note by path. The plan
// links back to the dev plan. Memory notes sit under the session folder's project folder (HOME is /home/test).
const LOGIN = '.local/plans/2026-10-01-login.md'
const LOGIN_ARCHIVED = '.local/plans/archive/2026-10-01-login.md'
const MEMORY = '/home/test/.claude/projects/-repo/memory'
const ARCHIVE_TREE = {
  [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK,
  ['/repo/' + LOGIN]: '# Login\n### C1: form, done\n### C2: reset, dropped\n\nSee [the dev plan](../DEV-PLAN.md).',
  '/repo/.local/plans/2026-10-29-search.md': SEARCH,
  '/repo/.local/DEV-PLAN.md': '# Dev\nThe login plan: `.local/plans/2026-10-01-login.md`.',
  '/repo/.local/notes/links.md': 'See [login](../plans/2026-10-01-login.md#c1).',
  [MEMORY + '/notes.md']: 'The login plan is .local/plans/2026-10-01-login.md',
}

// Every relative link in the repo's .local Markdown files, as a path from the repo's top.
const linksIn = (all: Record<string, string>) =>
  Object.entries(all)
    .filter(([p]) => p.startsWith('/repo/.local/') && p.endsWith('.md'))
    .flatMap(([p, text]) =>
      markdownLinks(text).map(link => {
        const parts: string[] = []
        for (const part of (p.slice(0, p.lastIndexOf('/')) + '/' + link).split('/')) part === '..' ? parts.pop() : part && part !== '.' && parts.push(part)
        return '/' + parts.join('/')
      }),
    )

const openPlans = async ($: Parameters<TestBody>[0], clock: { settle: () => Promise<unknown> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('a selected plan is archived after asking: one copy, in the archive, with every reference pointing there', async ($, on) => {
  const { clock, all, dialog, toasts } = engine(on, ARCHIVE_TREE)
  const original = all['/repo/' + LOGIN]!
  const ui = await openPlans($, clock)
  expect(await ui.find({ key: 'plan-archive' })).toBeUndefined()
  await ui.press({ key: 'plan-pick-' + LOGIN })
  expect(await ui.find({ type: 'Text', text: '▍› 2026-10-01-LOGIN.MD' })).toBeDefined()
  await ui.press({ key: 'plan-archive' })
  await clock.settle()

  expect(dialog.questions).toEqual([
    `Move ${LOGIN} to ${LOGIN_ARCHIVED} and update references in 3 files (.local/DEV-PLAN.md, .local/notes/links.md, memory/notes.md)?`,
  ])
  // One copy, in the archive: the same plan, its link to the dev plan leading from its new folder.
  expect('/repo/' + LOGIN in all).toBe(false)
  expect(all['/repo/' + LOGIN_ARCHIVED]).toBe(original.replace('](../DEV-PLAN.md)', '](../../DEV-PLAN.md)'))
  expect(all['/repo/.local/DEV-PLAN.md']).toBe('# Dev\nThe login plan: `.local/plans/archive/2026-10-01-login.md`.')
  expect(all['/repo/.local/notes/links.md']).toBe('See [login](../plans/archive/2026-10-01-login.md#c1).')
  expect(all[MEMORY + '/notes.md']).toBe('The login plan is .local/plans/archive/2026-10-01-login.md')
  // No link in .local leads nowhere.
  expect(linksIn(all).filter(target => !(target in all))).toEqual([])
  expect(toasts).toEqual(['Archived 2026-10-01-login.md, 3 files updated'])
  // Off the board, and no longer selected; the other plan stays.
  expect(await ui.find({ type: 'Text', text: /2026-10-01-LOGIN/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▍2026-10-29-SEARCH.MD' })).toBeDefined()
  expect(await ui.find({ key: 'plan-archive' })).toBeUndefined()
  await ui.unmount()
})

test('Cancel changes nothing, and a plan still open says how much is left', async ($, on) => {
  const { clock, all, dialog } = engine(on, ARCHIVE_TREE)
  dialog.answer = 'Cancel'
  const before = { ...all }
  const ui = await openPlans($, clock)
  await ui.press({ key: 'plan-pick-.local/plans/2026-10-29-search.md' })
  await ui.press({ key: 'plan-archive' })
  await clock.settle()
  expect(dialog.questions).toEqual([
    'Move .local/plans/2026-10-29-search.md to .local/plans/archive/2026-10-29-search.md? 3 checkpoints are still open.',
  ])
  expect(all).toEqual(before)
  await ui.unmount()
})

test("a reference that can't be written keeps the original: nothing is removed, and a toast says so", async ($, on) => {
  const { clock, all, toasts } = engine(on, { ...ARCHIVE_TREE, [MEMORY + '/read-only.md']: 'Also .local/plans/2026-10-01-login.md' })
  const ui = await openPlans($, clock)
  await ui.press({ key: 'plan-pick-' + LOGIN })
  await ui.press({ key: 'plan-archive' })
  await clock.settle()
  expect(toasts).toEqual([`Couldn't update memory/read-only.md, so ${LOGIN} was kept: the archive copy is in place`])
  expect('/repo/' + LOGIN in all).toBe(true)
  expect('/repo/' + LOGIN_ARCHIVED in all).toBe(true)
  await ui.unmount()
})

test('a plan whose name the archive already holds is refused before any dialog', async ($, on) => {
  const { clock, all, dialog, toasts } = engine(on, { ...ARCHIVE_TREE, ['/repo/' + LOGIN_ARCHIVED]: '# Old login' })
  const ui = await openPlans($, clock)
  await ui.press({ key: 'plan-pick-' + LOGIN })
  await ui.press({ key: 'plan-archive' })
  await clock.settle()
  expect(dialog.questions).toEqual([])
  expect(toasts).toEqual([`Already in the archive: ${LOGIN_ARCHIVED}`])
  expect(all['/repo/' + LOGIN_ARCHIVED]).toBe('# Old login')
  expect('/repo/' + LOGIN in all).toBe(true)
  await ui.unmount()
})

test('a pack plan with no archive folder says so, and a selected plan leaves Work › Runs alone', async ($, on) => {
  const noArchive = USER_PACK.replace(',"archiveDir":"plans/archive"', '')
  expect(noArchive).not.toBe(USER_PACK)
  const { clock } = engine(on, { [PACKS + '/shop.pack.jsonc']: noArchive, '/repo/plans/backend.md': BACKEND })
  const ui = await openPlans($, clock)
  await ui.press({ key: 'plan-pick-plans/backend.md' })
  expect(await ui.find({ type: 'Text', text: /no archive folder: set plans\.archiveDir in the pack/ })).toBeDefined()
  expect(await ui.find({ key: 'plan-archive' })).toBeUndefined()
  // Runs shares Work's selected row: a plan there opens no run, so Runs has nothing to close.
  await ui.press({ key: 'view-runs' })
  expect(await ui.find({ key: 'run-close' })).toBeUndefined()
  await ui.unmount()
})

const REMINDER = '1 finished plan: archive it in Work › Plans (select it, then a)'

test('a finished plan is reminded of at most once a day, by the check that runs away from the board', CLOCK_HEAVY, async ($, on) => {
  const { clock, toasts } = engine(on, { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, ['/repo/' + LOGIN]: ARCHIVE_TREE['/repo/' + LOGIN]! })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
  await clock.advance(600_000)
  await clock.settle()
  expect(toasts).toEqual([REMINDER])
  await clock.advance(600_000)
  await clock.settle()
  expect(toasts).toEqual([REMINDER])
})

test('the reminder comes again once a day has passed since the last, whichever session gave it', CLOCK_HEAVY, async ($, on) => {
  // Another session reminded 23 h 50 min before this one's first check (at 1 600 000): not yet, then due at the next.
  const lastAt = 1_600_000 - 24 * 60 * 60_000 + 600_000
  const { clock, toasts } = engine(
    on,
    { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, ['/repo/' + LOGIN]: ARCHIVE_TREE['/repo/' + LOGIN]! },
    {},
    { 'plansReminded:-repo-git': lastAt },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
  await clock.advance(600_000)
  await clock.settle()
  expect(toasts).toEqual([])
  await clock.advance(600_000)
  await clock.settle()
  expect(toasts).toEqual([REMINDER])
})

test('no reminder while nothing is finished', CLOCK_HEAVY, async ($, on) => {
  const { clock, toasts } = engine(on, { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, '/repo/.local/plans/2026-10-29-search.md': SEARCH })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
  await clock.advance(600_000)
  await clock.settle()
  expect(toasts).toEqual([])
})

test('with the board open on a finished plan for 10 minutes, no reminder comes', CLOCK_HEAVY, async ($, on) => {
  const { clock, toasts } = engine(on, { [PACKS + '/shop.pack.jsonc']: NO_PLANS_IN_PACK, ['/repo/' + LOGIN]: ARCHIVE_TREE['/repo/' + LOGIN]! })
  const ui = await openPlans($, clock)
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
  await clock.advance(600_000)
  await clock.settle()
  expect(toasts).toEqual([])
  expect(await ui.find({ type: 'Text', text: /ready to archive/ })).toBeDefined()
  await ui.unmount()
})
