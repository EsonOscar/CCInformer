import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { PackToolReport } from '../hooks/packs/check'

const TOOL = 'mcp__ccinformer__check_pack'
const PACKS = '/home/test/.claude/ccinformer/packs'
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })
// The shop's own pack, an older one for the same repo that the validator now refuses (no labels), and one for
// another repo.
const SHOP = `{
  "schema": 1, "id": "acme-shop", "version": "1",
  "match": { "remote": ["github.com/acme/*"] },
  "extends": ["node-vite"],
  "checks": [{ "id": "eslint", "on": ["src/**/*.ts"] }],
}`
const OLD = `{ "schema": 1, "id": "acme-old", "version": "1", "match": { "remote": ["github.com/acme/shop"] },
  "processes": [{ "id": "web", "match": "web", "kind": "dev" }] }`
const OTHER = `{ "schema": 1, "id": "other", "version": "1", "match": { "remote": ["github.com/other/*"] } }`
// What the mod's own copy of the skill's template reads as here.
const TEMPLATE = '// every pack setting, with what it does\n{ "schema": 1 }\n'

const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo at /repo with an acme remote and a packs folder in memory. `registered` collects each tool the mod
// registers; `writes` each file it writes.
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>) => {
  const registered: { name: string; isDeferred?: unknown }[] = []
  const writes: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: posix(e.path).endsWith('/skills/write-pack/pack-template.jsonc') ? TEMPLATE : (files[posix(e.path)] ?? null) }) as never)
  on('fs.stat', (_, e) => ({ value: posix(e.path) in files ? { kind: 'file', size: 1, mtimeMs: 1 } : null }) as never)
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: 1 })) } as never
  })
  on('fs.write', (_, e) => {
    writes.push(posix(e.path))
    return { value: undefined } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:Acme/Shop.git\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.register', (_, e) => {
    registered.push(e as unknown as { name: string; isDeferred?: unknown })
    return { value: { tool: 'mcp__ccinformer__' + (e as unknown as { name: string }).name } } as never
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { registered, writes, clock }
}

const FILES = {
  '/repo/package.json': VITE_PKG,
  [PACKS + '/shop.pack.jsonc']: SHOP,
  [PACKS + '/acme-old.pack.jsonc']: OLD,
  [PACKS + '/other.pack.jsonc']: OTHER,
}

// The tool's answer, parsed: the report it gives Claude.
const ask = async ($: Parameters<TestBody>[0], input: { text?: string; file?: string } = {}): Promise<PackToolReport> => {
  const answer = await $.tool.call({ tool: TOOL, ...input } as never)
  return JSON.parse(String((answer as { result: unknown }).result)) as PackToolReport
}

const draft = (fields: object) => JSON.stringify({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, extends: ['node-vite'], ...fields })

test('the mod registers the pack-checking tool behind ToolSearch', async ($, on) => {
  const { registered, clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(registered.map(r => [r.name, r.isDeferred])).toEqual([['check_pack', true]])
})

test('with no text: the repo, the packs folder and every pack in it, a refused one still matched to its repo, and the built-ins', async ($, on) => {
  const { clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const report = await ask($)
  expect(report.repo).toEqual({ root: '/repo', remote: 'github.com/acme/shop' })
  expect(report.packsDir).toBe(PACKS)
  expect(report.packs.map(p => [p.file, p.valid, p.matchesRepo])).toEqual([
    ['acme-old.pack.jsonc', false, true],
    ['other.pack.jsonc', true, false],
    ['shop.pack.jsonc', true, true],
  ])
  expect(report.packs[0]!.reasons[0]).toBe('process web needs "label", the name the pane shows')
  // No pack's text before a draft exists, so the draft is made from the repo, not from the old pack.
  expect(report.packs.every(p => p.text === undefined)).toBe(true)
  expect(report.builtins.map(b => [b.id, b.detected, b.pack.id])).toEqual([['node-vite', true, 'node-vite']])
  // The skill's template comes with this first look, from the mod's own folder.
  expect(report.template).toBe(TEMPLATE)
  expect(report.draft).toBeUndefined()
})

test("once a draft is checked: the text of this repo's own packs, never another repo's, and no template", async ($, on) => {
  const { clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const report = await ask($, { text: draft({}), file: 'zz.pack.jsonc' })
  expect(report.packs.map(p => [p.file, p.text === undefined ? 'no text' : p.text])).toEqual([
    ['acme-old.pack.jsonc', OLD],
    ['other.pack.jsonc', 'no text'],
    ['shop.pack.jsonc', SHOP],
  ])
  expect(report.template).toBeUndefined()
})

test('a valid draft: no reasons, the file it would replace, and the entries it resolves to', async ($, on) => {
  const { clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const { draft: d } = await ask($, { text: draft({ checks: [{ id: 'eslint', on: ['src/**/*.tsx'] }] }), file: 'shop.pack.jsonc' })
  expect(d).toMatchObject({ file: 'shop.pack.jsonc', valid: true, reasons: [], exists: true, existsMatchesRepo: true, matchesRepo: true })
  // acme-old.pack.jsonc sorts first but is refused, so the draft is what loads.
  expect(d!.shadowedBy).toBe('')
  expect(d!.entries.find(e => e.section === 'checks' && e.id === 'eslint')).toMatchObject({ label: 'ESLint', layer: 'built-in', changedBy: ['user'] })
})

test('a refused draft says why; a bad file name is one of the reasons; the name defaults to the id', async ($, on) => {
  const { clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const refused = (await ask($, { text: draft({ budgets: [{ id: 'size', label: 'size', unit: 'kb' }] }) })).draft!
  expect(refused.file).toBe('acme-shop.pack.jsonc')
  expect(refused.valid).toBe(false)
  expect(refused.reasons).toContain('budget size: "unit" must be one of bytes, ms, fps, mb, count, lines')
  expect(refused.entries).toEqual([])
  const misnamed = (await ask($, { text: draft({}), file: 'packs/shop.json' })).draft!
  expect(misnamed.reasons).toEqual(['"file" must be a file name ending in .pack.jsonc, with no folder, such as "acme-shop.pack.jsonc"'])
  const broken = (await ask($, { text: '{ "schema": 1, "id": "x", "match": { "remote": ["\\d"] } }' })).draft!
  expect(broken.valid).toBe(false)
  expect(broken.reasons.some(r => r.endsWith('check commas and quotes'))).toBe(true)
})

test('a draft for another remote, one a pack loads before, and a name another repo already uses', async ($, on) => {
  const { clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const elsewhere = (await ask($, { text: draft({ match: { remote: ['github.com/somebody/*'] } }), file: 'somebody.pack.jsonc' })).draft!
  expect([elsewhere.matchesRepo, elsewhere.shadowedBy, elsewhere.exists]).toEqual([false, '', false])
  // shop.pack.jsonc matches this repo and sorts before the draft, so it loads; the draft's entries are its own.
  const late = (await ask($, { text: draft({ checks: [{ id: 'size', label: 'size', on: ['src/**'], analyzer: 'size-lines', cost: 'edit', class: 'ci', options: { max: 400 } }] }), file: 'zz.pack.jsonc' })).draft!
  expect([late.valid, late.matchesRepo, late.shadowedBy]).toEqual([true, true, 'shop.pack.jsonc'])
  expect(late.entries.some(e => e.section === 'checks' && e.id === 'size')).toBe(true)
  // other.pack.jsonc is another repo's: saving there would overwrite it.
  const taken = (await ask($, { text: draft({}), file: 'other.pack.jsonc' })).draft!
  expect([taken.exists, taken.existsMatchesRepo]).toEqual([true, false])
})

test('checking a pack writes nothing', async ($, on) => {
  const { writes, clock } = engine(on, { ...FILES })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const before = writes.length
  await ask($)
  await ask($, { text: draft({}), file: 'shop.pack.jsonc' })
  expect(writes.slice(before)).toEqual([])
})
