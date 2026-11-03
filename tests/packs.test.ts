import { describe, expect, test } from 'claude-code/testing'

import { cleanRemote, detect, normalizeRemote, remoteMatches } from '../hooks/packs/detect'
import { parseJsonc } from '../hooks/packs/jsonc'
import { hostTone } from '../hooks/packs/merge'
import { BUILTINS } from '../hooks/packs/node-vite'
import { resolvePack } from '../hooks/packs/resolve'
import type { PackInput } from '../hooks/packs/resolve'
import { configHash, runnableChecks, trustOf } from '../hooks/packs/trust'
import type { ResolvedPack } from '../hooks/packs/types'
import { checkPack, groupsOf, scanPattern } from '../hooks/packs/validate'

// A synthetic Vite shop: invented names, the shapes of a real repo.
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })

const USER_PACK = `{
  // The shop's own values, kept outside the repo.
  "schema": 1, "id": "acme-shop", "version": "1",
  "match": { "remote": ["github.com/acme/*"] },
  "extends": ["node-vite"],
  "environments": [
    { "id": "staging", "label": "staging", "tone": "shared", "hostPatterns": ["*.staging.example.test"],
      "approvals": [{ "id": "staging-writes", "tool": "Bash", "commandRegex": "migrate", "label": "staging migration", "scope": "once" }] },
  ],
  "locks": [{ "id": "migrations", "glob": "db/migrations/**", "mode": "exclusive", "reason": "one migration at a time" }],
  "checks": [{ "id": "eslint", "label": "ESLint (shop rules)", "on": ["src/**/*.ts"], "analyzer": "eslint-json", "cost": "turn", "class": "ci" }],
  "budgets": [{ "id": "bundle", "label": "bundle", "unit": "bytes", "direction": "max", "limit": 500000, "sources": [], "cost": "demand" }],
  "disable": ["playwright"],
}`

const input = (over: Partial<PackInput> = {}): PackInput => ({
  root: '/work/shop',
  remote: 'git@github.com:Acme/Shop.git',
  repoKey: 'work-shop-git',
  markers: { 'package.json': VITE_PKG, 'vite.config.ts': '', 'vite.config.js': null, 'vite.config.mts': null },
  userPacks: [],
  repo: null,
  local: null,
  isLocalIgnored: true,
  realPaths: {},
  storedTrust: null,
  hash: 'h1',
  now: 1000,
  ...over,
})

const withUser = (over: Partial<PackInput> = {}) => input({ userPacks: [{ path: '/home/me/.claude/ccinformer/packs/shop.pack.jsonc', text: USER_PACK }], ...over })
const row = (r: ReturnType<typeof resolvePack>, layer: string) => r.report.layers.find(l => l.layer === layer)!
const entry = (r: ReturnType<typeof resolvePack>, section: string, id: string) => r.report.entries.find(e => e.section === section && e.id === id)

describe('reading pack files', () => {
  test('JSONC: comments and trailing commas go, strings keep what looks like them', async () => {
    expect(parseJsonc('{\n  // a note\n  "a": "x // y", /* b */ "b": [1, 2,],\n}').value).toEqual({ a: 'x // y', b: [1, 2] })
    expect(parseJsonc('{ "a": }').error).toBeDefined()
  })

  test('a remote reads the same over ssh and https, and a user pack matches it by glob', async () => {
    expect(normalizeRemote('git@github.com:Acme/Shop.git')).toBe('github.com/acme/shop')
    expect(normalizeRemote('https://someone@github.com/Acme/Shop/')).toBe('github.com/acme/shop')
    expect(remoteMatches('github.com/acme/*', 'https://github.com/Acme/Shop.git')).toBe(true)
    expect(remoteMatches('github.com/acme/*', 'https://github.com/Acme/Shop/sub')).toBe(false)
    expect(remoteMatches('github.com/other/*', 'git@github.com:acme/shop.git')).toBe(false)
    // A token in the URL never reaches the pane, a question or the store.
    expect(cleanRemote('https://someone:s3cret@github.com/acme/shop.git\n')).toBe('https://github.com/acme/shop.git')
    expect(cleanRemote('git@github.com:acme/shop.git')).toBe('git@github.com:acme/shop.git')
  })

  test('every built-in pack is valid', async () => {
    for (const pack of BUILTINS) expect({ id: pack.id, reasons: checkPack(pack, 'built-in').reasons }).toEqual({ id: pack.id, reasons: [] })
  })

  test('a regex-lines check needs a pattern that compiles, and runs on each write', async () => {
    const check = (fields: object) => ({ id: 'raw-button', label: 'Raw <button>', on: ['src/**/*.tsx'], analyzer: 'regex-lines', cost: 'edit', class: 'advise', ...fields })
    const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
    expect(checkPack(pack(check({ options: { pattern: '<button\\b', message: 'use <Button>' } })), 'user').reasons).toEqual([])
    expect(checkPack(pack(check({})), 'user').reasons).toEqual(['check raw-button: needs "options.pattern", the regex each line is tested against'])
    expect(checkPack(pack(check({ options: { pattern: '<button(' } })), 'user').reasons).toEqual(['check raw-button: "options.pattern" doesn\'t compile'])
    expect(checkPack(pack(check({ cost: 'turn', options: { pattern: 'x', message: 3 } })), 'user').reasons).toEqual([
      'check raw-button: a regex-lines check runs on each write, so its cost must be "edit"',
      'check raw-button: "options.message" must be a string',
    ])
  })

  test('an i18n-keysets check runs once a turn ends and names its languages', async () => {
    const check = (fields: object) => ({ id: 'i18n', label: 'Translation keys', on: ['src/i18n/**/*.json'], analyzer: 'i18n-keysets', cost: 'turn', class: 'ci', ...fields })
    const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
    const noLanguages = 'check i18n: needs "options.languages", the languages every table must have (e.g. ["da", "en", "sv"])'
    expect(checkPack(pack(check({ options: { languages: ['da', 'en', 'sv'] } })), 'user').reasons).toEqual([])
    expect(checkPack(pack(check({})), 'user').reasons).toEqual([noLanguages])
    expect(checkPack(pack(check({ options: { languages: [] } })), 'user').reasons).toEqual([noLanguages])
    expect(checkPack(pack(check({ options: { languages: 'da' } })), 'user').reasons).toEqual([noLanguages])
    expect(checkPack(pack(check({ cost: 'edit', options: { languages: ['da'] } })), 'user').reasons).toEqual([
      'check i18n: an i18n-keysets check runs once a turn ends, so its cost must be "turn"',
    ])
  })
})

describe('command checks: sarif and problem-matcher', () => {
  const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
  const reasons = (c: object) => checkPack(pack(c), 'user').reasons
  const sarif = (fields: object) =>
    ({ id: 'ruff', label: 'ruff', on: ['**/*.py'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['ruff', 'check', '--output-format', 'sarif', '{files}'], ...fields })
  // The README's gcc pattern.
  const GCC =
    '^(?<file>(?:[A-Za-z]:)?[^:]+):(?<line>\\d+):(?:(?<column>\\d+):)?\\s+(?:fatal\\s+)?(?<severity>error|warning|note):\\s+(?<message>.*?)(?:\\s+\\[(?<code>-W[^\\]]+)\\])?$'
  const matcher = (fields: object) =>
    ({ id: 'gcc', label: 'gcc', on: ['**/*.c'], analyzer: 'problem-matcher', cost: 'turn', class: 'ci', bin: ['gcc', '-fsyntax-only', '{files}'], options: { pattern: GCC }, ...fields })
  const needsBin = (analyzer: string, example: string) => `check ${analyzer === 'sarif' ? 'ruff' : 'gcc'}: needs "bin", the command to run as a list (e.g. ${example})`
  const RUFF_BIN = '["ruff", "check", "--output-format", "sarif", "{files}"]'

  test('a sarif check names its command: {files} on its own, {output} inside an item, a bounded timeout', async () => {
    expect(reasons(sarif({}))).toEqual([])
    expect(reasons(sarif({ bin: ['dotnet', 'build', '-p:ErrorLog={output}%2Cversion=2.1'], timeoutMs: 300_000 }))).toEqual([])
    expect(reasons(sarif({ cost: 'edit' }))).toEqual(['check ruff: a sarif check runs the repo\'s tool once a turn ends, so its cost must be "turn"'])
    for (const bin of [undefined, [], ['', 'x'], 'ruff']) expect(reasons(sarif({ bin }))).toEqual([needsBin('sarif', RUFF_BIN)])
    expect(reasons(sarif({ bin: ['{files}', 'ruff'] }))).toEqual(['check ruff: "bin"\'s first item is the program to run; "{files}" and "{output}" can\'t be it'])
    const onItsOwn = 'check ruff: "{files}" must be a list item on its own, at most once; it\'s replaced by the files to check'
    expect(reasons(sarif({ bin: ['ruff', '--files={files}'] }))).toEqual([onItsOwn])
    expect(reasons(sarif({ bin: ['ruff', '{files}', '{files}'] }))).toEqual([onItsOwn])
    const timeout = 'check ruff: "timeoutMs" must be a whole number of milliseconds, from 1 to 600000'
    for (const timeoutMs of [0, -5, 1.5, 600_001, '30s']) expect(reasons(sarif({ timeoutMs }))).toEqual([timeout])
  })

  test('a problem-matcher check names its pattern: the groups, the guards against a hanging regex, the severity words', async () => {
    expect(reasons(matcher({}))).toEqual([])
    expect(reasons(matcher({ bin: ['gcc', '-o', '{output}', '{files}'] }))).toEqual(['check gcc: "{output}" is for sarif checks; a problem-matcher check reads the command\'s output'])
    expect(reasons(matcher({ bin: undefined }))).toEqual([needsBin('problem-matcher', '["gcc", "-fsyntax-only", "{files}"]')])
    expect(reasons(matcher({ options: {} }))).toEqual(['check gcc: needs "options.pattern", the regex each output line is tested against'])
    expect(reasons(matcher({ options: { pattern: '(' } }))).toEqual(['check gcc: "options.pattern" doesn\'t compile'])
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1)' } }))).toEqual([
      'check gcc: "options.pattern" needs the named groups file, line and message (missing: message), e.g. (?<file>[^:]+):(?<line>\\d+): (?<message>.*)',
    ])
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1):(?<col>2) (?<message>.*)' } }))).toEqual([
      'check gcc: "options.pattern" has a group "col"; the groups are file, line, column, severity, code and message',
    ])
    const hangs = 'check gcc: "options.pattern" repeats a group that itself repeats or branches, like (\\w+)+ or (a|b)+, which can hang on a long line; drop the outer repeat'
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1) (?<message>(\\w+\\s?)+)' } }))).toEqual([hangs])
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1) (?<message>(x|y)+)' } }))).toEqual([hangs])
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1) (?<message>(?:x{2,})*)' } }))).toEqual([hangs])
    // Repeats inside a character class, a bounded `?` after the group, and a bounded count are fine.
    expect(reasons(matcher({ options: { pattern: '(?<file>[+*]+):(?<line>1)(?:(?<column>\\d+):)?(?:\\d{1,3}\\.){3} (?<message>.*)' } }))).toEqual([])
    expect(reasons(matcher({ options: { pattern: '(?<file>.*):(?<line>.+):(?<message>.*)' } }))).toEqual([
      'check gcc: "options.pattern" has more than two unbounded wildcards (.* or .+); anchor the fields instead',
    ])
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1) (?<message>.*)'.padEnd(301, 'x') } }))).toEqual(['check gcc: "options.pattern" is over 300 characters'])
    expect(reasons(matcher({ options: { pattern: GCC, severity: 'fatal' } }))).toEqual(['check gcc: "options.severity" must be "error", "warn" or "info"'])
    expect(reasons(matcher({ options: { pattern: GCC, severity: 'warn' } }))).toEqual([])
    expect(groupsOf(GCC)).toEqual(['file', 'line', 'column', 'severity', 'message', 'code'])
    expect(scanPattern(GCC)).toEqual({ repeatsRepeat: false, wildcards: 1 })
  })

  test('an eslint-json check gets its files appended, so a placeholder in its bin is refused', async () => {
    const eslint = (bin: string[]) => ({ id: 'eslint', label: 'ESLint', on: ['src/**/*.ts'], analyzer: 'eslint-json', cost: 'turn', class: 'ci', bin })
    expect(reasons(eslint(['node', 'node_modules/eslint/bin/eslint.js']))).toEqual([])
    expect(reasons(eslint(['node', 'node_modules/eslint/bin/eslint.js', '{files}']))).toEqual([
      'check eslint: an eslint-json check gets its files appended; drop "{files}" and "{output}" from "bin"',
    ])
  })

  test('a repo config holding a check is refused whole; without trust a sarif check is left out; a reused id keeps the built-in\'s fields', async () => {
    const repo = resolvePack(input({ repo: `{ "checks": [{ "id": "x", "analyzer": "sarif", "bin": ["sh"] }] }` }))
    expect(row(repo, 'repo').state).toBe('refused')
    expect(row(repo, 'repo').reasons.join('\n')).toMatch(/"checks": a repo config can't name commands/)
    const own: ResolvedPack = { id: 'own', processes: [], environments: [], checks: [sarif({}) as never], budgets: [], locks: [], noise: [], signals: [], claudeMd: [] }
    expect(runnableChecks(own, false)).toEqual([])
    expect(runnableChecks(own, true).map(c => c.id)).toEqual(['ruff'])
    // A user pack check with the built-in's id merges field by field, so node-vite's suppressions stay on it: an
    // ESLint SARIF check takes its own id (the README says so).
    const reused = resolvePack(withUser())
    expect(reused.pack.checks.find(c => c.id === 'eslint')?.suppressions).toBe('eslint-suppressions.json')
  })
})

describe('the four layers', () => {
  test('(1) a user pack matched by its remote extends node-vite, changes a check and switches one off', async () => {
    const r = withUser()
    const resolved = resolvePack(r)
    expect(row(resolved, 'built-in')).toMatchObject({ source: 'node-vite', state: 'loaded', note: 'extended by acme-shop' })
    expect(row(resolved, 'user')).toMatchObject({ state: 'loaded', note: 'matched git@github.com:Acme/Shop.git' })
    expect(resolved.pack.id).toBe('acme-shop')
    expect(resolved.pack.checks.find(c => c.id === 'eslint')).toMatchObject({ label: 'ESLint (shop rules)', on: ['src/**/*.ts'], bin: ['node', 'node_modules/eslint/bin/eslint.js'] })
    expect(entry(resolved, 'checks', 'eslint')).toMatchObject({ layer: 'built-in', changedBy: ['user'] })
    expect(entry(resolved, 'locks', 'migrations')).toMatchObject({ layer: 'user', changedBy: [] })
    expect(entry(resolved, 'processes', 'playwright')).toMatchObject({ layer: 'built-in', removedBy: 'user' })
    expect(resolved.pack.processes.some(p => p.id === 'playwright')).toBe(false)
    expect(entry(resolved, 'processes', 'vitest')).toMatchObject({ layer: 'built-in' })
    expect(resolved.report.trust).toMatchObject({ isTrusted: true, by: 'user pack' })
  })

  test('a user pack for another remote is not used', async () => {
    const resolved = resolvePack(withUser({ remote: 'git@github.com:other/thing.git' }))
    expect(row(resolved, 'user')).toMatchObject({ state: 'absent' })
    expect(resolved.pack.id).toBe('node-vite')
  })

  test('(2) node-vite is detected from package.json, and nothing is when vite is missing', async () => {
    const resolved = resolvePack(input())
    expect(row(resolved, 'built-in')).toMatchObject({ source: 'node-vite', state: 'loaded', note: 'detected' })
    expect(detect(BUILTINS, { 'package.json': '{"name":"plain"}', 'vite.config.ts': '' })).toBeNull()
    const none = resolvePack(input({ markers: { 'package.json': null } }))
    expect(row(none, 'built-in')).toMatchObject({ state: 'absent' })
    expect(none.pack.id).toBe('')
  })

  test('(3) a repo config naming a command to run is refused whole', async () => {
    const repo = `{ "locks": { "warn": ["package-lock.json"] }, "preflight": { "steps": [{ "argv": ["npm", "test"] }] } }`
    const resolved = resolvePack(input({ repo }))
    expect(row(resolved, 'repo').state).toBe('refused')
    expect(row(resolved, 'repo').reasons.join('\n')).toMatch(/"preflight": a repo config can't name commands/)
    // Nothing from the file applies, not even its valid lock.
    expect(resolved.pack.locks.some(l => l.glob === 'package-lock.json')).toBe(false)
    const bin = resolvePack(input({ repo: `{ "budgets": { "bundle": { "limit": 1, "bin": ["sh"] } } }` }))
    expect(row(bin, 'repo').reasons.join('\n')).toMatch(/"budgets.bundle.bin"/)
  })

  test('(4) a repo config may not switch off an approval from the user pack', async () => {
    const resolved = resolvePack(withUser({ repo: `{ "disable": ["staging-writes"] }` }))
    expect(row(resolved, 'repo').state).toBe('refused')
    expect(row(resolved, 'repo').reasons[0]).toMatch(/can't switch off/)
    expect(entry(resolved, 'approvals', 'staging-writes')?.removedBy).toBeUndefined()
    expect(resolved.pack.environments.find(e => e.id === 'staging')?.approvals?.map(a => a.id)).toEqual(['staging-writes'])
  })

  test('(5) a repo path outside the root is refused, by its text or by where it really leads', async () => {
    const up = resolvePack(input({ repo: `{ "locks": { "exclusive": ["../other/**"] } }` }))
    expect(row(up, 'repo').reasons[0]).toMatch(/leaves the repo/)
    const absolute = resolvePack(input({ repo: `{ "plans": { "archiveDir": "/tmp/archive" } }` }))
    expect(row(absolute, 'repo').reasons[0]).toMatch(/must be relative/)
    const linked = resolvePack(input({ repo: `{ "plans": { "globs": ["notes/*.md"] } }`, realPaths: { notes: '/elsewhere/notes' } }))
    expect(row(linked, 'repo').reasons[0]).toMatch(/"notes" leads outside the repo/)
    const inside = resolvePack(input({ repo: `{ "plans": { "globs": ["notes/*.md"] } }`, realPaths: { notes: '/work/shop/notes' } }))
    expect(row(inside, 'repo').state).toBe('loaded')
    expect(inside.pack.plans?.globs).toEqual(['notes/*.md'])
  })

  test('(6) a regex in a repo config is refused: as a key, a host or a glob', async () => {
    for (const repo of [
      `{ "envHosts": { "prod": ["^db\\\\..*$"] } }`,
      `{ "locks": { "warn": ["src/(a|b)/**"] } }`,
      `{ "plans": { "globs": ["*.md"], "checkpoint": "CP\\\\d+" } }`,
    ]) {
      const resolved = resolvePack(input({ repo }))
      expect({ repo, state: row(resolved, 'repo').state }).toEqual({ repo, state: 'refused' })
      expect(row(resolved, 'repo').reasons.join('\n')).toMatch(/regex/)
    }
  })

  test('(7) a repo config may name a built-in, not a user pack', async () => {
    const resolved = resolvePack(input({ repo: `{ "pack": "acme-shop" }` }))
    expect(row(resolved, 'repo').reasons[0]).toMatch(/"pack" may name a built-in only/)
    const named = resolvePack(input({ markers: { 'package.json': null }, repo: `{ "pack": "node-vite" }` }))
    expect(row(named, 'built-in')).toMatchObject({ source: 'node-vite', note: 'named by .ccinformer.jsonc' })
  })

  test('a repo config adds locks and hosts and tightens a budget, never loosens one', async () => {
    const tight = resolvePack(withUser({ repo: `{ "budgets": { "bundle": { "limit": 400000 } }, "envHosts": { "prod": ["db.example.test"] }, "locks": { "warn": ["package-lock.json"] } }` }))
    expect(row(tight, 'repo').state).toBe('loaded')
    expect(tight.pack.budgets.find(b => b.id === 'bundle')?.limit).toBe(400000)
    expect(entry(tight, 'budgets', 'bundle')).toMatchObject({ layer: 'user', changedBy: ['repo'] })
    expect(entry(tight, 'locks', 'repo:package-lock.json')).toMatchObject({ layer: 'repo' })
    expect(hostTone(tight.pack, 'db.example.test')).toBe('prod')
    const loose = resolvePack(withUser({ repo: `{ "budgets": { "bundle": { "limit": 600000 } } }` }))
    expect(row(loose, 'repo').reasons[0]).toMatch(/looser/)
    const local = resolvePack(input({ local: `{ "envHosts": { "local": ["dev.test"] } }` }))
    expect(row(local, 'local').reasons[0]).toMatch(/shared or prod environments only/)
  })

  test('a host matching two tones takes the stricter', async () => {
    const resolved = resolvePack(withUser({ repo: `{ "envHosts": { "prod": ["*.example.test"] } }` }))
    expect(hostTone(resolved.pack, 'api.staging.example.test')).toBe('prod')
    expect(hostTone(resolved.pack, 'localhost')).toBe('local')
    expect(hostTone(resolved.pack, 'elsewhere.test')).toBeNull()
  })

  test('(8) without trust, no check that runs the repo’s tools: only the mod’s own', async () => {
    const own = `{ "schema": 1, "id": "own", "version": "1", "match": { "remote": ["github.com/acme/*"] },
      "checks": [{ "id": "size", "label": "file size", "on": ["src/**"], "analyzer": "size-lines", "cost": "edit", "class": "advise" }] }`
    const { pack } = resolvePack(input({ userPacks: [{ path: 'own.pack.jsonc', text: own }] }))
    expect(runnableChecks(pack, false).map(c => c.id)).toEqual(['size'])
    expect(runnableChecks(pack, true).map(c => c.id)).toEqual(['eslint', 'size'])
    const detected = resolvePack(input())
    expect(detected.report.trust.isTrusted).toBe(false)
    expect(entry(detected, 'checks', 'eslint')?.needsTrust).toBe(true)
    expect(runnableChecks(detected.pack, detected.report.trust.isTrusted)).toEqual([])
  })

  test('translation tables are compared inside the mod, so that check needs no trust', async () => {
    const own = `{ "schema": 1, "id": "own", "version": "1", "match": { "remote": ["github.com/acme/*"] },
      "checks": [{ "id": "i18n", "label": "Translation keys", "on": ["src/i18n/**/*.json"], "analyzer": "i18n-keysets", "cost": "turn",
        "class": "ci", "options": { "languages": ["da", "en"] } }] }`
    const resolved = resolvePack(input({ userPacks: [{ path: 'own.pack.jsonc', text: own }] }))
    expect(runnableChecks(resolved.pack, false).map(c => c.id)).toEqual(['i18n'])
    expect(entry(resolved, 'checks', 'i18n')?.needsTrust).toBe(false)
  })

  test('a yes holds for the config files it was given for, and goes stale when they change', async () => {
    const before = await configHash(['{ "locks": {} }', null])
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    expect(await configHash(['{ "locks": {} }', null])).toBe(before)
    expect(trustOf(false, { hash: before, at: 5 }, before)).toEqual({ isTrusted: true, by: 'you', at: 5, isStale: false })
    const after = await configHash(['{ "locks": { "warn": ["x"] } }', null])
    expect(trustOf(false, { hash: before, at: 5 }, after)).toEqual({ isTrusted: false, by: '', at: 0, isStale: true })
  })

  test('(9) a broken file adds nothing and says why; the rest still resolves', async () => {
    const resolved = resolvePack(input({ repo: '{ "locks": ', userPacks: [{ path: 'bad.pack.jsonc', text: '{ "schema": 2 }' }] }))
    expect(row(resolved, 'repo')).toMatchObject({ state: 'broken' })
    expect(resolved.report.layers.find(l => l.source === 'bad.pack.jsonc')).toMatchObject({ state: 'refused', reasons: ['needs "schema": 1', 'needs an "id"', 'needs a "version" (a string)'] })
    expect(resolved.pack.id).toBe('node-vite')
  })

  test('a local config git doesn’t ignore still applies, with a warning', async () => {
    const resolved = resolvePack(input({ local: `{ "locks": { "warn": ["notes.md"] } }`, isLocalIgnored: false }))
    expect(row(resolved, 'local')).toMatchObject({ state: 'loaded', note: 'not ignored by git: it may get committed' })
  })
})
