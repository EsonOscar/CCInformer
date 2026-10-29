import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

const PACKS = '/home/test/.claude/ccinformer/packs'
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })
const HEAD = 'abc1234def'
// HEAD was committed at 900 s; the mocked clock starts at 1 000 s.
const HEAD_SECONDS = 900
const source = (measure: string) => [
  { kind: 'command', argv: ['node', 'tools/bundle/report.mjs', '--check'], parse: `Start ${measure}: ([\\d.]+) KB`, scale: 1024, freshAfter: 'dist/index.html', build: ['npm', 'run', 'build'] },
  { kind: 'ci-log', job: 'checks', step: 'Bundle budget', parse: `Start ${measure}: ([\\d.]+) KB`, scale: 1024 },
]
const budget = (measure: string, label: string) => ({
  id: 'start-' + measure,
  label,
  unit: 'bytes',
  direction: 'max',
  limit: { relative: 1.05, baseline: { kind: 'json', path: 'tools/bundle/baseline.json', pointer: '/start/' + measure } },
  sources: source(measure),
  cost: 'cheap',
})
const USER_PACK = JSON.stringify({
  schema: 1,
  id: 'acme-shop',
  version: '1',
  match: { remote: ['github.com/acme/*'] },
  extends: ['node-vite'],
  budgets: [budget('brotli', 'Start-up brotli'), budget('raw', 'Start-up raw')],
})
const BASELINE = JSON.stringify({ start: { brotli: 400_000, raw: 1_800_000 } })
// 412.1 KB is 5.5 % over 400 000 bytes; 1800.0 KB is 2.4 % over 1 800 000.
const REPORT_OVER = 'Start brotli: 412.1 KB, baseline 390.6 KB (5.5%, over the 5% budget)\nStart raw: 1800.0 KB, baseline 1757.8 KB (2.4%, within the 5% budget)\n'
const CI_LOG = 'checks\tUNKNOWN STEP\t2026-10-29T06:18:42Z Start brotli: 395.3 KB, baseline 390.6 KB (1.2%, within the 5% budget)\nchecks\tUNKNOWN STEP\t2026-10-29T06:18:42Z Start raw: 1757.8 KB, baseline 1757.8 KB (0.0%, within the 5% budget)\n'

const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo with a bundle report. `report` is what the report prints and how it exits; `dist` the built index's
// modified time (none: not built); `ci` the CI runs of each commit and the branch, each with a job log. A build
// stamps dist/index.html with the clock's time. `calls` counts each command by its first words.
const engine = (
  on: Parameters<TestBody>[1],
  opts: { report?: { text: string; exit: number; ms?: number }; dist?: number; ci?: { commit: Record<string, { id: number; sha: string }[]>; branch: { id: number; sha: string }[]; logs: Record<number, string> } } = {},
) => {
  const files: Record<string, string> = { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: USER_PACK, '/repo/tools/bundle/baseline.json': BASELINE }
  const mtimes: Record<string, number> = {}
  if (opts.dist !== undefined) {
    files['/repo/dist/index.html'] = '<html></html>'
    mtimes['/repo/dist/index.html'] = opts.dist
  }
  const calls: Record<string, number> = {}
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: files[posix(e.path)] ?? null }) as never)
  on('fs.write', (_, e) => {
    files[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const path = posix(e.path)
    return { value: path in files ? { kind: 'file', size: files[path]!.length, mtimeMs: mtimes[path] ?? 1 } : null } as never
  })
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: mtimes[p] ?? 1 })) } as never
  })
  on('process.run', async (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const line = argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const count = (name: string) => (calls[name] = (calls[name] ?? 0) + 1)
    if (line.includes('report.mjs')) {
      count('report')
      await clock.sleep(opts.report?.ms ?? 0)
      return out(opts.report?.text ?? '', opts.report?.exit ?? 0)
    }
    if (line === 'npm run build') {
      count('build')
      files['/repo/dist/index.html'] = '<html></html>'
      mtimes['/repo/dist/index.html'] = clock.now()
      return out('built')
    }
    if (line === 'git log -1 --format=%H %ct') return out(`${HEAD} ${HEAD_SECONDS}\n`)
    if (line === 'git rev-parse --abbrev-ref HEAD') return out('main\n')
    if (line.startsWith('gh run list --commit')) return out(JSON.stringify((opts.ci?.commit[argv[4]!] ?? []).map(r => ({ databaseId: r.id, headSha: r.sha, status: 'completed' }))))
    if (line.startsWith('gh run list --branch')) return out(JSON.stringify((opts.ci?.branch ?? []).map(r => ({ databaseId: r.id, headSha: r.sha, status: 'completed' }))))
    if (/^gh run view \d+ --json jobs$/.test(line)) return out(JSON.stringify({ jobs: [{ databaseId: Number(argv[3]) * 10, name: 'checks' }] }))
    if (line.startsWith('gh run view --job')) {
      count('log')
      const log = opts.ci?.logs[Number(argv[4])]
      return log === undefined ? out('', 1) : out(log)
    }
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git check-ignore')) return out('', 0)
    if (line.startsWith('git status')) return out('# branch.oid abc123\n# branch.head main\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Write') {
      const write = e as unknown as { file_path: string; content: string }
      files[posix(write.file_path)] = write.content
      return { result: { type: 'create', filePath: write.file_path, content: write.content, structuredPatch: [] }, text: 'written' } as never
    }
    return { result: {}, text: 'ok' }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, calls }
}

const openBudgets = async ($: Parameters<TestBody>[0], clock: { settle: () => Promise<void> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'budgets' })
  await clock.settle()
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('raw and brotli are each gauged from one run of the report, read even when it exits 1', async ($, on) => {
  const { clock, calls } = engine(on, { report: { text: REPORT_OVER, exit: 1 }, dist: 950_000 })
  const ui = await openBudgets($, clock)

  expect(calls.report).toBe(1)
  expect(await ui.find({ type: 'Text', text: '412.1 KB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "5.5% over the baseline, past the 5% budget · from the repo's report" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1800.0 KB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: "2.4% over the baseline, within the 5% budget · from the repo's report" })).toBeDefined()
  // A fresh reading over its budget shows on Code's badge.
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeDefined()
  // No CI log was needed: the report was fresh.
  expect(calls.log).toBeUndefined()
  await ui.unmount()
})

test("a build older than HEAD is stale, and CI's reading of HEAD takes its place", async ($, on) => {
  const ci = { commit: { [HEAD]: [{ id: 7, sha: HEAD }] }, branch: [], logs: { 70: CI_LOG } }
  const { clock } = engine(on, { report: { text: REPORT_OVER, exit: 1 }, dist: 800_000, ci })
  const ui = await openBudgets($, clock)

  expect(await ui.find({ type: 'Text', text: '395.3 KB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\.2% over the baseline, within the 5% budget · from CI$/ })).toBeDefined()
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeUndefined()
  await ui.unmount()
})

test("a build older than Claude's last write is shown, marked stale, when CI has nothing", async ($, on) => {
  const { clock } = engine(on, { report: { text: REPORT_OVER, exit: 1 }, dist: 950_000 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/app.ts', content: 'export const a = 1\n' })
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'budgets' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /412\.1 KB/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /stale: dist\/index\.html is older than the last change/ })).toBeDefined()
  // A stale reading over its budget doesn't raise the badge.
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeUndefined()
  await ui.unmount()
})

test('with nothing built it says so; m builds, then reads', async ($, on) => {
  const { clock, calls } = engine(on, { report: { text: REPORT_OVER, exit: 1 } })
  const ui = await openBudgets($, clock)

  expect(await ui.find({ type: 'Text', text: /dist\/index\.html isn't there: build first \(m\)/ })).toBeDefined()
  expect(calls.report).toBeUndefined()

  await ui.press({ key: 'budgets-measure' })
  await clock.settle()
  expect(calls.build).toBe(1)
  expect(calls.report).toBe(1)
  expect(await ui.find({ type: 'Text', text: "5.5% over the baseline, past the 5% budget · from the repo's report" })).toBeDefined()
  await ui.unmount()
})

test("CI's reading of an older commit is shown as stale, and each finished job's log is fetched once", async ($, on) => {
  const ci = { commit: {}, branch: [{ id: 5, sha: 'def4567aaa' }], logs: { 50: CI_LOG } }
  const { clock, calls } = engine(on, { ci })
  const ui = await openBudgets($, clock)

  expect(await ui.find({ type: 'Text', text: /from CI · stale: CI's run of def4567, not HEAD/ })).toBeDefined()
  // Both budgets read the same job's log, fetched once; a refresh fetches nothing new.
  expect(calls.log).toBe(1)
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(calls.log).toBe(1)
  await ui.unmount()
})

test('reading again over readings already shown moves nothing: the readings stay, and only the heading says reading', async ($, on) => {
  const { clock, calls } = engine(on, { report: { text: REPORT_OVER, exit: 1, ms: 2000 }, dist: 950_000 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'budgets' })
  await clock.advance(3000)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(calls.report).toBe(1)

  await ui.press({ key: 'refresh' })
  await clock.advance(500)
  expect(calls.report).toBe(2)
  expect(await ui.find({ type: 'Text', text: 'reading…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Reading the budgets/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '412.1 KB' })).toBeDefined()

  await clock.advance(2000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'read just now' })).toBeDefined()
  await ui.unmount()
})
