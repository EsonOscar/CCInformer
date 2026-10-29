import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 300 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

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
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>) => {
  const all: Record<string, string> = { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: USER_PACK, ...files }
  const mtimes: Record<string, number> = {}
  const reads: Record<string, number> = {}
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
  return { clock, reads, change }
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

test("a pack that names no plan files says so", async ($, on) => {
  const { clock } = engine(on, { [PACKS + '/shop.pack.jsonc']: USER_PACK.replace(/,"plans":\{[^}]*\}/, '') })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'plans' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /names no plan files/ })).toBeDefined()
  await ui.unmount()
})
