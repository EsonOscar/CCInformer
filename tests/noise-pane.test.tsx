import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const

const PACKS = '/home/test/.claude/ccinformer/packs'
// An invented Godot repo's user pack: the editor's cache folder is generated, and its scenes are rewritten on save.
const NOISE_PACK = `{ "schema": 1, "id": "kestrel", "version": "1", "match": { "remote": ["github.com/acme/*"] },
  "noise": [
    { "id": "godot-cache", "glob": "**/.godot/**", "kind": "generated" },
    { "id": "scenes", "glob": "**/*.tscn", "kind": "editor-rewrite", "normalize": ["uid=\\"[^\\"]*\\""] }
  ] }`

// Three changed files and the editor's cache: lobby.tscn only gained a uid, gazebo.tscn renamed a node.
const STATUS = [
  '# branch.oid abc123',
  '# branch.head main',
  '1 .M N... 1 1 1 a b atrium/lobby.tscn',
  '1 .M N... 1 1 1 a b atrium/gazebo.tscn',
  '1 .M N... 1 1 1 a b src/app.ts',
  '? .godot/',
  '',
].join('\n')
const section = (path: string, minus: string, plus: string) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-' + minus, '+' + plus].join('\n')
const REWRITES = [
  section('atrium/lobby.tscn', '[gd_scene format=3]', '[gd_scene format=3 uid="uid://kestrel_a"]'),
  section('atrium/gazebo.tscn', '[node name="Gauge" parent="."]', '[node name="Marquee" parent="."]'),
  '',
].join('\n')

const engine = (on: Parameters<TestBody>[1]) => {
  const files: Record<string, string> = { [PACKS + '/kestrel.pack.jsonc']: NOISE_PACK, '/repo/atrium/lobby.tscn': 'x', '/repo/atrium/gazebo.tscn': 'y' }
  const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
  const rewriteDiffs: string[][] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test', PATH: '/usr/bin' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: files[posix(e.path)] ?? null }) as never)
  on('fs.stat', (_, e) => ({ value: posix(e.path) in files ? { kind: 'file', size: files[posix(e.path)]!.length, mtimeMs: 1 } : null }) as never)
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: 1 })) } as never
  })
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const line = argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git status')) return out(STATUS)
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    if (argv.includes('-U0')) {
      rewriteDiffs.push(argv)
      return out(REWRITES)
    }
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, rewriteDiffs }
}

test("Code › Git folds the pack's noise: a uid-only resave and the generated cache, counted apart; all files shows them with their kind", async ($, on) => {
  const { clock, rewriteDiffs } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-code' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /CHANGES · 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 changed · 2 noise' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 noise · f shows all' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'atrium/gazebo.tscn' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'atrium/lobby.tscn' })).toBeUndefined()
  // Only the scenes are diffed, in one command.
  expect(rewriteDiffs.map(a => a.filter(x => x.startsWith(':(top,literal)')))).toEqual([[':(top,literal)atrium/lobby.tscn', ':(top,literal)atrium/gazebo.tscn']])

  await ui.press({ key: 'git-all' })
  expect(await ui.find({ type: 'Text', text: 'atrium/lobby.tscn' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'editor rewrite' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '.godot/' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'generated' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /noise · f shows all/ })).toBeUndefined()
  await ui.unmount()
})
