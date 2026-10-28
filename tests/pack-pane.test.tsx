import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

const PACKS = '/home/test/.claude/ccinformer/packs'
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })
const USER_PACK = `{
  "schema": 1, "id": "acme-shop", "version": "1",
  "match": { "remote": ["github.com/acme/*"] },
  "extends": ["node-vite"],
  "locks": [{ "id": "migrations", "glob": "db/migrations/**", "mode": "exclusive", "reason": "one migration at a time" }],
  "checks": [{ "id": "eslint", "label": "ESLint (shop rules)", "on": ["src/**/*.ts"], "analyzer": "eslint-json", "cost": "turn", "class": "ci" }],
}`

// The engine hands file hooks native paths (C:\repo\x on Windows); the files are keyed as /repo/x.
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo at /repo with an acme remote, its files in memory: `files` maps a path to its text, and `mtimes`
// to when it last changed, so a test can change a file. `asked` collects each question put to the person, and
// `answer` is what they pick.
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>) => {
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(files).map(p => [p, 1]))
  const asked: string[] = []
  const state = { answer: 'Allow' }
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: files[posix(e.path)] ?? null }) as never)
  on('fs.stat', (_, e) => {
    const path = posix(e.path)
    return { value: path in files ? { kind: 'file', size: files[path]!.length, mtimeMs: mtimes[path] ?? 1 } : null } as never
  })
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: mtimes[p] ?? 1 })) } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git check-ignore')) return out('', 0)
    if (line.startsWith('git status')) return out('# branch.oid abc123\n# branch.head main\n1 .M N... 1 1 1 a b src/app.ts\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {}, text: 'ok' }
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(question)
    return { result: { questions: [], answers: { [question]: state.answer } }, text: state.answer } as never
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  const change = (path: string, text: string) => {
    files[path] = text
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  return { asked, state, change }
}

test('/ccinformer pack shows each layer and every value with the layer that set it', async ($, on) => {
  engine(on, { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: USER_PACK, '/repo/.ccinformer.jsonc': '{ "locks": { "warn": ["package-lock.json"] } }' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'pack' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /PACK · ACME-SHOP/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /extended by acme-shop/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /matched git@github.com:acme\/shop.git/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ESLint (shop rules) · eslint' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'built-in → user pack' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'db/migrations/** · migrations' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'package-lock.json · repo:package-lock.json' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /a user pack matches this repo/ })).toBeDefined()
  // A user pack's trust is withdrawn in the pack, not here.
  expect(await ui.find({ key: 'pack-trust' })).toBeUndefined()
  await ui.unmount()
})

test('a broken file adds nothing, the Pack view says why, and the rest of the pane still draws', async ($, on) => {
  engine(on, { '/repo/package.json': VITE_PKG, [PACKS + '/shop.pack.jsonc']: '{ "schema": 1, ', '/repo/.ccinformer.jsonc': '{ "pack": "acme-shop" }' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'area-code' })
  expect(await ui.find({ type: 'Text', text: /Unstaged · 1/ })).toBeDefined()
  // Debug's badge says something needs a look.
  expect(await ui.find({ key: 'area-debug', text: /•/ })).toBeDefined()

  await ui.press({ key: 'area-debug' })
  await ui.press({ key: 'view-pack' })
  expect(await ui.find({ type: 'Text', text: /PACK · NODE-VITE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'broken' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'refused' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /"pack" may name a built-in only/ })).toBeDefined()
  await ui.unmount()
})

test('repo tools wait until the person allows them, once, and can be stopped again', async ($, on) => {
  const { asked, state } = engine(on, { '/repo/package.json': VITE_PKG })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'pack' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /repo tools wait until you allow them/ })).toBeDefined()

  state.answer = 'Not now'
  const no = await $.command.run({ ...TYPED, command: 'side', args: 'pack trust' })
  expect(no.text).toMatch(/Not allowed/)
  expect(await ui.find({ type: 'Text', text: /repo tools wait until you allow them/ })).toBeDefined()

  state.answer = 'Allow'
  const yes = await $.command.run({ ...TYPED, command: 'ccinformer', args: 'pack trust' })
  expect(yes.text).toMatch(/may run here/)
  expect(asked).toEqual([
    "Let CCInformer run this repo's own tools (linters, builds) for git@github.com:acme/shop.git?",
    "Let CCInformer run this repo's own tools (linters, builds) for git@github.com:acme/shop.git?",
  ])
  expect(await ui.find({ type: 'Text', text: /repo tools may run: allowed by you/ })).toBeDefined()

  // The key in the view withdraws it, with no question.
  await ui.press({ key: 'pack-trust' })
  expect(await ui.find({ type: 'Text', text: /repo tools wait until you allow them/ })).toBeDefined()
  expect(asked.length).toBe(2)
  const odd = await $.command.run({ ...TYPED, command: 'ccinformer', args: 'pack maybe' })
  expect(odd.text).toMatch(/takes no "maybe": try trust or untrust/)
  await ui.unmount()
})

test('a yes goes stale when the repo config changes, and the pack is read again on the next turn', async ($, on) => {
  const { change } = engine(on, { '/repo/package.json': VITE_PKG, '/repo/.ccinformer.jsonc': '{ "locks": { "warn": ["a.md"] } }' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'pack trust' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /allowed by you/ })).toBeDefined()

  change('/repo/.ccinformer.jsonc', '{ "locks": { "warn": ["a.md", "b.md"] } }')
  await $.turn.start({ text: 'go on', turnId: 'turn-1' })
  expect(await ui.find({ type: 'Text', text: 'b.md · repo:b.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /the config changed since you allowed them/ })).toBeDefined()
  await ui.unmount()
})
