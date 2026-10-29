import { describe, expect, test } from 'claude-code/testing'

import { cleanRemote, detect, normalizeRemote, remoteMatches } from '../hooks/packs/detect'
import { parseJsonc } from '../hooks/packs/jsonc'
import { hostTone } from '../hooks/packs/merge'
import { BUILTINS } from '../hooks/packs/node-vite'
import { resolvePack } from '../hooks/packs/resolve'
import type { PackInput } from '../hooks/packs/resolve'
import { configHash, runnableChecks, trustOf } from '../hooks/packs/trust'
import { checkPack } from '../hooks/packs/validate'

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
