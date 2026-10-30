import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
// The mocked-clock tests run in real time too, and a busy machine can push them past the default 5 s.
const CLOCK_HEAVY = { timeoutMs: 20_000 }

const PACKS = '/home/test/.claude/ccinformer/packs'
// Where a yes to repo trust is kept for /repo (its git folder made a key).
const TRUST_KEY = 'trust:-repo-git'
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })
// A user pack, so the repo's own tools may run: files under src/ get a 10-line limit and ESLint after each turn.
const USER_PACK = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] }, "extends": ["node-vite"],
  "checks": [
    { "id": "max-lines", "label": "File length", "on": ["src/**/*.ts"], "analyzer": "size-lines", "cost": "edit", "class": "ci",
      "rules": ["max-lines"], "options": { "max": 10 }, "suppressions": "eslint-suppressions.json" },
    { "id": "eslint", "label": "ESLint", "on": ["src/**/*.ts"], "analyzer": "eslint-json", "cost": "turn", "class": "ci" }
  ] }`

const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const a${i} = ${i}`).join('\n') + '\n'
const turnEnd = (agentId?: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId: 't-' + (agentId ?? 'main'), reason: 'answer' as const, ...(agentId ? { agentId } : {}) })
const anyError = (line: number) => ({ ruleId: '@typescript-eslint/no-explicit-any', severity: 2, message: 'Unexpected any. Specify a different type.', line })

// The engine hands file hooks native paths (C:\repo\x on Windows); the files are keyed as /repo/x.
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo at /repo with an acme remote, its files in memory. A Write changes a file there. ESLint answers with
// `lint`'s messages for each file it was given, after `lintMs` on the mocked clock; `runs` holds the files of each
// run, and `mostAtOnce` how many ran together. `submitted` is each prompt as it entered, with its context.
const engine = (
  on: Parameters<TestBody>[1],
  files: Record<string, string>,
  opts: { lint?: (file: string) => object[]; lintMs?: number; answer?: string; store?: Record<string, unknown> } = {},
) => {
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(files).map(p => [p, 1]))
  const runs: string[][] = []
  const asked: string[] = []
  const submitted: { text: string; context: readonly string[] }[] = []
  let running = 0
  let mostAtOnce = 0
  const clock = mock.clock(on, { now: 1_000_000 })
  const change = (path: string, text: string) => {
    files[path] = text
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  mock.store(on, opts.store ?? {})
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: files[posix(e.path)] ?? null }) as never)
  on('fs.write', (_, e) => {
    change(posix(e.path), e.text)
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
    if (line.includes('eslint')) {
      const checked = argv.filter(a => a.startsWith('src/'))
      runs.push(checked)
      running += 1
      mostAtOnce = Math.max(mostAtOnce, running)
      await clock.sleep(opts.lintMs ?? 0)
      running -= 1
      const results = checked.map(f => ({ filePath: '/repo/' + f, messages: opts.lint?.(f) ?? [] }))
      return out(JSON.stringify(results), results.some(r => r.messages.length) ? 1 : 0)
    }
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git check-ignore')) return out('', 0)
    if (line.startsWith('git status')) return out('# branch.oid abc123\n# branch.head main\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      asked.push(question)
      const answer = opts.answer ?? 'Allow'
      return { result: { questions: [], answers: { [question]: answer } }, text: answer } as never
    }
    if (e.tool === 'Write') {
      const write = e as unknown as { file_path: string; content: string }
      change(posix(write.file_path), write.content)
      return { result: { type: 'create', filePath: write.file_path, content: write.content, structuredPatch: [] }, text: 'written' } as never
    }
    return { result: {}, text: 'ok' }
  })
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, context: e.context } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, runs, asked, submitted, change, mostAtOnce: () => mostAtOnce }
}

// ESLint is installed in the repo: the turn check runs node_modules/eslint/bin/eslint.js, which the engine answers.
const ESLINT_INSTALLED = { '/repo/node_modules/eslint/bin/eslint.js': '' }
const REPO = { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: USER_PACK, ...ESLINT_INSTALLED }

test('a file written over its limit tells the model with the result; Code › Rules lists it until dismissed', async ($, on) => {
  const { clock } = engine(on, { ...REPO })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/big.ts', content: lines(12) })
  expect(result.context?.join('\n')).toContain('- src/big.ts max-lines: 12 lines, over the limit of 10 [CI will fail]')
  // A file within its limit, or outside what the check covers, adds nothing.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/small.ts', content: lines(3) })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs/long.ts', content: lines(30) })).context).toBeUndefined()

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /12 lines, over the limit of 10/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 would fail CI' })).toBeDefined()
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeDefined()

  const row = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('finding-press-') && /12 lines/.test(b.text))!
  await ui.press({ key: row.key! })
  await ui.press({ key: 'finding-dismiss' })
  expect(await ui.find({ type: 'Text', text: /12 lines, over the limit/ })).toBeUndefined()
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeUndefined()
  await ui.unmount()
})

test('a suppressed file over its limit is information only, and the model is told nothing', async ($, on) => {
  const { clock } = engine(on, { ...REPO, '/repo/eslint-suppressions.json': '{ "src/big.ts": { "max-lines": { "count": 1 } } }' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/src/big.ts', content: lines(14) })
  expect(result.context).toBeUndefined()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /14 lines, over the limit of 10 but suppressed: don't grow it/ })).toBeDefined()
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeUndefined()
  await ui.unmount()
})

test("a turn's ESLint findings reach the model with the next prompt the person types, once, never with a slash command or a peer's message", async ($, on) => {
  const { clock, runs, submitted } = engine(on, { ...REPO }, { lint: f => (f === 'src/app.ts' ? [anyError(3)] : []) })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/app.ts', content: lines(4) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(runs).toEqual([['src/app.ts']])

  await $.prompt.submit({ text: '/diff', command: { name: 'diff', args: '' }, origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: 'from another session', origin: { kind: 'peer' }, wait: false })
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: 'and then', origin: { kind: 'composer' }, wait: false })
  expect(submitted.map(s => s.context.length)).toEqual([0, 0, 1, 0])
  expect(submitted[2]!.context[0]).toContain('- src/app.ts:3 @typescript-eslint/no-explicit-any: Unexpected any. Specify a different type. [CI will fail]')
})

test('a finding is not told once its file changed after the run', async ($, on) => {
  const { clock, submitted, change } = engine(on, { ...REPO }, { lint: () => [anyError(1)] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/app.ts', content: lines(4) })
  await $.turn.complete(turnEnd())
  await clock.settle()

  change('/repo/src/app.ts', lines(5))
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  expect(submitted[0]!.context).toEqual([])
})

test("ESLint runs once per main turn, over every agent's files, and never at a subagent's turn end", async ($, on) => {
  const { clock, runs } = engine(on, { ...REPO })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2), agentId: 'agent-1' } as never)
  await $.turn.complete(turnEnd('agent-1'))
  await clock.settle()
  expect(runs).toEqual([])

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.ts', content: lines(2) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(runs).toEqual([['src/a.ts', 'src/b.ts']])

  // A turn that wrote nothing runs nothing.
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(runs.length).toBe(1)
})

test('one ESLint run at a time: a turn that ends during a run is checked after it', CLOCK_HEAVY, async ($, on) => {
  const { clock, runs, mostAtOnce } = engine(on, { ...REPO }, { lintMs: 5000 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2) })
  await $.turn.complete(turnEnd())
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.ts', content: lines(2) })
  await $.turn.complete(turnEnd())
  await clock.advance(1000)
  expect(runs).toEqual([['src/a.ts']])

  await clock.advance(10_000)
  await clock.settle()
  expect(runs).toEqual([['src/a.ts'], ['src/b.ts']])
  expect(mostAtOnce()).toBe(1)
})

test("without a user pack, the first turn check asks once whether the repo's tools may run, and waits on a no", async ($, on) => {
  const { clock, runs, asked } = engine(on, { '/repo/package.json': VITE_PKG, ...ESLINT_INSTALLED }, { answer: "Don't allow" })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(asked.length).toBe(1)
  expect(runs).toEqual([])

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ESLint waits until this repo's own tools may run/ })).toBeDefined()
  await ui.unmount()

  // It doesn't ask again this session.
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(asked.length).toBe(1)
  expect(runs).toEqual([])

  // Nor in a later session: the no is kept for the repo.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(3) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(asked.length).toBe(1)
  expect(runs).toEqual([])
})

test('a yes that lapsed when the config changed is not asked about again: the files wait for the person', async ($, on) => {
  const store = { [TRUST_KEY]: { hash: 'config-before-the-change', at: 1 } }
  const { clock, runs, asked } = engine(on, { '/repo/package.json': VITE_PKG, ...ESLINT_INSTALLED }, { store })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(asked).toEqual([])
  expect(runs).toEqual([])
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'debug' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-pack' })
  expect(await ui.find({ type: 'Text', text: /the config changed since you allowed them. Press a to allow them again/ })).toBeDefined()
  await ui.unmount()
})

test('a yes to trust lets the waiting files run', async ($, on) => {
  const { clock, runs, asked } = engine(on, { '/repo/package.json': VITE_PKG, ...ESLINT_INSTALLED })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: lines(2) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect(asked.length).toBe(1)
  expect(runs).toEqual([['src/a.ts']])
})

// Design rules for .tsx files outside src/ui/: raw <button> is a project rule; raw <input> is a CI rule ESLint enforces
// as no-restricted-syntax, so the regex check stands for it. ESLint runs over the same files after each turn.
const DESIGN_PACK = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] }, "extends": ["node-vite"],
  "checks": [
    { "id": "raw-button", "label": "Raw <button>", "on": ["src/**/*.tsx"], "ignore": ["src/ui/**"], "analyzer": "regex-lines", "cost": "edit",
      "class": "advise", "options": { "pattern": "<button\\\\b", "message": "use <Button> from the design system" } },
    { "id": "raw-input", "label": "Raw <input>", "on": ["src/**/*.tsx"], "ignore": ["src/ui/**"], "analyzer": "regex-lines", "cost": "edit",
      "class": "ci", "rules": ["no-restricted-syntax"], "options": { "pattern": "<input\\\\b", "message": "use <Input> from the design system" } },
    { "id": "eslint", "label": "ESLint", "on": ["src/**/*.tsx"], "analyzer": "eslint-json", "cost": "turn", "class": "ci" }
  ] }`
const DESIGN_REPO = { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: DESIGN_PACK, ...ESLINT_INSTALLED }
const PAGE = ['export const Page = () => (', '  <div>', '    <input value={v} />', '    <button onClick={go}>Go</button>', '  </div>', ')'].join('\n')
const restricted = (line: number) => ({ ruleId: 'no-restricted-syntax', severity: 2, message: 'Raw form elements are not allowed.', line })

test('a design rule is told with the write: a project rule, or CI for one ESLint enforces; files it exempts give nothing', async ($, on) => {
  const { clock } = engine(on, { ...DESIGN_REPO })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const note = (await $.tool.call({ tool: 'Write', file_path: '/repo/src/page.tsx', content: PAGE })).context?.join('\n') ?? ''
  expect(note).toContain('- src/page.tsx:3 no-restricted-syntax: use <Input> from the design system [CI will fail]')
  expect(note).toContain('- src/page.tsx:4 raw-button: use <Button> from the design system [project rule]')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/ui/button.tsx', content: PAGE })).context).toBeUndefined()

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'L4 raw-button: use <Button> from the design system' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'rule' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'L3 no-restricted-syntax: use <Input> from the design system' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 would fail CI' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/ui\/button\.tsx/ })).toBeUndefined()
  await ui.unmount()
})

test("the turn's ESLint finding on a line a design rule already reports shows and is told once; its others stay", async ($, on) => {
  const { clock, submitted } = engine(on, { ...DESIGN_REPO }, { lint: f => (f === 'src/page.tsx' ? [restricted(3), restricted(5)] : []) })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/page.tsx', content: PAGE })
  await $.turn.complete(turnEnd())
  await clock.settle()

  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  const told = submitted[0]!.context.join('\n')
  expect(told).toContain('- src/page.tsx:5 no-restricted-syntax: Raw form elements are not allowed. [CI will fail]')
  expect(told).not.toContain('src/page.tsx:3')

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text', text: /^L3 no-restricted-syntax/ })).length).toBe(1)
  expect(await ui.find({ type: 'Text', text: 'L5 no-restricted-syntax: Raw form elements are not allowed.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 would fail CI' })).toBeDefined()
  await ui.unmount()
})

test('a repo without ESLint installed skips the turn check quietly: no run, no error, no trust question', async ($, on) => {
  // No user pack (so trust would be asked) and no node_modules/eslint: node-vite's ESLint check has nothing to run.
  const { clock, runs, asked } = engine(on, { '/repo/package.json': VITE_PKG })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/app.ts', content: lines(4) })
  await $.turn.complete(turnEnd())
  await clock.settle()
  expect([runs, asked]).toEqual([[], []])

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /could not be read|ESLint on/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing found in the files changed so far/ })).toBeDefined()
  await ui.unmount()
})
