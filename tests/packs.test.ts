import { describe, expect, test } from 'claude-code/testing'

import { cleanRemote, detect, normalizeRemote, remoteMatches } from '../hooks/packs/detect'
import { PARSE_HINT, parseJsonc } from '../hooks/packs/jsonc'
import { DEFAULT_CHECKPOINT, DEFAULT_DONE, DEFAULT_PR_REF } from '../hooks/plans/parse'
import { hostTone, mergeLayers } from '../hooks/packs/merge'
import { BUILTINS } from '../hooks/packs/builtins'
import { entryRows, resolvePack } from '../hooks/packs/resolve'
import type { PackInput } from '../hooks/packs/resolve'
import { isStoredTrust, runnableChecks, trustOf } from '../hooks/packs/trust'
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
  "checks": [{ "id": "eslint", "label": "ESLint (shop rules)", "on": ["src/**/*.ts"], "analyzer": "eslint-json", "cost": "turn", "class": "ci" }],
  "budgets": [{ "id": "bundle", "label": "bundle", "unit": "bytes", "direction": "max", "limit": 500000, "sources": [{ "kind": "json", "path": "perf/size.json", "pointer": "/bundle" }], "cost": "demand" }],
  "disable": ["playwright"],
}`

const input = (over: Partial<PackInput> = {}): PackInput => ({
  root: '/work/shop',
  remote: 'git@github.com:Acme/Shop.git',
  repoKey: 'work-shop-git',
  markers: { 'package.json': VITE_PKG, 'vite.config.ts': '', 'vite.config.js': null, 'vite.config.mts': null },
  userPacks: [],
  storedTrust: null,
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

  test('no two built-ins share an id, since a user pack extends one by id', async () => {
    const ids = BUILTINS.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a key outside the schema refuses the pack and names the keys it takes: a removed field or a typo', async () => {
    const pack = (extra: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, ...extra })
    const takes = 'it takes schema, id, version, match, detect, extends, processes, environments, checks, budgets, noise, plans, disable'
    expect(checkPack(pack({ plans: { globs: ['.local/*.md'] } }), 'user').reasons).toEqual([])
    for (const key of ['locks', 'signals', 'preflight', 'claudeMd', 'check'])
      expect(checkPack(pack({ [key]: [] }), 'user').reasons).toEqual([`"${key}" isn't a pack setting (${takes})`])
  })

  test('the removed analyzers and the batch cost are refused', async () => {
    const check = (fields: object) => ({ id: 'lint', label: 'lint', on: ['**/*.py'], analyzer: 'size-lines', cost: 'edit', class: 'advise', options: { max: 500 }, ...fields })
    const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
    const analyzers = 'regex-lines, size-lines, i18n-keysets, eslint-json, sarif, problem-matcher, tscn-connections, tscn-nodepaths'
    for (const analyzer of ['ruff-json', 'mypy-text', 'msbuild', 'alembic-check', 'pybabel-po'])
      expect(checkPack(pack(check({ analyzer, options: undefined })), 'user').reasons).toEqual([`check lint: "analyzer" must be one of ${analyzers}`])
    expect(checkPack(pack(check({ cost: 'batch' })), 'user').reasons).toEqual(['check lint: "cost" must be one of edit, turn, demand'])
  })

  test('a regex-lines check needs a pattern that compiles, and runs on each write', async () => {
    const check = (fields: object) => ({ id: 'raw-button', label: 'Raw <button>', on: ['src/**/*.tsx'], analyzer: 'regex-lines', cost: 'edit', class: 'advise', ...fields })
    const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
    expect(checkPack(pack(check({ options: { pattern: '<button\\b', message: 'use <Button>' } })), 'user').reasons).toEqual([])
    expect(checkPack(pack(check({})), 'user').reasons).toEqual(['check raw-button: needs "options.pattern", the regex each line is tested against'])
    const broken = checkPack(pack(check({ options: { pattern: '<button(' } })), 'user').reasons
    expect(broken.length === 1 && broken[0]!.startsWith('check raw-button: "options.pattern" doesn\'t compile: ')).toBe(true)
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

  test('a tscn check runs once a turn ends, inside the mod: no command fields, no options', async () => {
    const check = (fields: object) => ({ id: 'scenes', label: 'Scene connections', on: ['**/*.tscn', '**/*.cs'], analyzer: 'tscn-connections', cost: 'turn', class: 'advise', ...fields })
    const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
    expect(checkPack(pack(check({})), 'user').reasons).toEqual([])
    expect(checkPack(pack(check({ analyzer: 'tscn-nodepaths' })), 'user').reasons).toEqual([])
    expect(checkPack(pack(check({ cost: 'edit' })), 'user').reasons).toEqual([
      'check scenes: a tscn-connections check compares scenes and scripts once a turn ends, so its cost must be "turn"',
    ])
    expect(checkPack(pack(check({ bin: ['godot'], timeoutMs: 1000 })), 'user').reasons).toEqual([
      'check scenes: a tscn-connections check compares files inside the mod, so it takes no "bin"',
      'check scenes: a tscn-connections check compares files inside the mod, so it takes no "timeoutMs"',
    ])
    expect(checkPack(pack(check({ options: { depth: 2 } })), 'user').reasons).toEqual(['check scenes: "options" has "depth"; a tscn-connections check takes no options'])
  })
})

describe('command checks: sarif and problem-matcher', () => {
  const pack = (c: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [c] })
  const reasons = (c: object) => checkPack(pack(c), 'user').reasons
  const sarif = (fields: object) =>
    ({ id: 'ruff', label: 'ruff', on: ['**/*.py'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['ruff', 'check', '--output-format', 'sarif', '{files}'], ...fields })
  // The pack reference's gcc pattern (skills/write-pack/reference.md).
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
    const unclosed = reasons(matcher({ options: { pattern: '(' } }))
    expect(unclosed.length === 1 && /^check gcc: "options\.pattern" doesn't compile: ./.test(unclosed[0]!)).toBe(true)
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
    expect(reasons(matcher({ options: { pattern: '(?<file>a):(?<line>1) (?<message>.*)'.padEnd(301, 'x') } }))).toEqual(['check gcc: "options.pattern" is over 300 characters; shorten it'])
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

  test('without trust a sarif check is left out; a reused id keeps the built-in\'s fields', async () => {
    const own: ResolvedPack = { id: 'own', processes: [], environments: [], checks: [sarif({}) as never], budgets: [], noise: [] }
    expect(runnableChecks(own, false)).toEqual([])
    expect(runnableChecks(own, true).map(c => c.id)).toEqual(['ruff'])
    // A user pack check with the built-in's id merges field by field, so node-vite's suppressions stay on it: an
    // ESLint SARIF check takes its own id (the pack reference says so).
    const reused = resolvePack(withUser())
    expect(reused.pack.checks.find(c => c.id === 'eslint')?.suppressions).toBe('eslint-suppressions.json')
  })
})

describe('every regex a pack holds', () => {
  // A pack with one of each regex field, every one set to `pattern` unless `over` says otherwise.
  const everyRegex = (pattern: string, over: Record<string, unknown> = {}) => ({
    schema: 1,
    id: 'acme-shop',
    version: '1',
    match: { remote: ['github.com/acme/*'] },
    processes: [{ id: 'web', label: 'web', kind: 'dev', match: pattern, envFrom: { argRegex: `(${pattern})`, envFile: '.env.{mode}' } }],
    environments: [
      { id: 'staging', label: 'staging', tone: 'shared', argRegex: pattern,
        approvals: [{ id: 'writes', tool: 'Bash', label: 'writes', scope: 'once', commandRegex: pattern, inputRegex: pattern }] },
    ],
    checks: [{ id: 'ban', label: 'ban', on: ['src/**'], analyzer: 'regex-lines', cost: 'edit', class: 'advise', options: { pattern } }],
    budgets: [
      { id: 'size', label: 'size', unit: 'bytes', direction: 'max', limit: 10, cost: 'cheap',
        sources: [
          { kind: 'command', argv: ['node', 'report.mjs'], parse: `(${pattern})` },
          { kind: 'ci-log', job: 'checks', step: 'size', parse: `(${pattern})` },
          { kind: 'file-lines', path: 'log.txt', parse: `(${pattern})`, stat: 'max' },
        ] },
    ],
    noise: [{ id: 'gen', glob: 'gen/**', kind: 'generated', normalize: [pattern] }],
    plans: { globs: ['.local/*.md'], checkpoint: pattern, done: [pattern], prRef: `(${pattern})` },
    ...over,
  })
  const reasons = (pack: object) => checkPack(pack, 'user').reasons

  test('a pack with a plain pattern in every regex field is valid', async () => {
    expect(reasons(everyRegex('worker'))).toEqual([])
  })

  test('a pattern that does not compile is refused in every field, naming the entry, the field and the engine message', async () => {
    const fields = [
      'process web: "match"',
      'process web: "envFrom.argRegex"',
      'environment staging: "argRegex"',
      'approval writes: "commandRegex"',
      'approval writes: "inputRegex"',
      'check ban: "options.pattern"',
      'budget size: "sources[0].parse"',
      'budget size: "sources[1].parse"',
      'budget size: "sources[2].parse"',
      'noise gen: "normalize[0]"',
      'plans: "checkpoint"',
      'plans: "done[0]"',
      'plans: "prRef"',
    ]
    const got = reasons(everyRegex('a[b'))
    expect(got.map(r => r.slice(0, r.indexOf(' doesn\'t compile: ')))).toEqual(fields)
    expect(got.every(r => / doesn't compile: .+/.test(r))).toBe(true)
  })

  test('a control character is refused, as a JSON "\\b" is a backspace; a tab is a tab', async () => {
    const backspace = reasons(everyRegex('worker', { processes: [{ id: 'web', label: 'web', kind: 'dev', match: '\u0008worker\u0008' }] }))
    expect(backspace).toEqual(['process web: "match" holds a control character (U+0008); in JSONC write a word boundary as "\\\\b" and every backslash twice'])
    expect(reasons(everyRegex('worker', { processes: [{ id: 'web', label: 'web', kind: 'dev', match: 'name\tpid' }] }))).toEqual([])
  })

  test('the guards against a slow regex hold in every field: length, a repeated repeat, too many wildcards', async () => {
    const one = (match: string) => reasons(everyRegex('worker', { processes: [{ id: 'web', label: 'web', kind: 'dev', match }] }))
    expect(one('a'.repeat(301))).toEqual(['process web: "match" is over 300 characters; shorten it'])
    expect(one('(\\w+\\s?)+$')).toEqual([
      'process web: "match" repeats a group that itself repeats or branches, like (\\w+)+ or (a|b)+, which can hang on a long line; drop the outer repeat',
    ])
    expect(one('.*a.*b.+c')).toEqual(['process web: "match" has more than two unbounded wildcards (.* or .+); anchor the fields instead'])
  })

  test('a field whose reader takes a group needs one, and the reason shows one', async () => {
    const got = reasons(everyRegex('worker', {
      processes: [{ id: 'web', label: 'web', kind: 'dev', match: 'vite', envFrom: { argRegex: '--mode \\S+', envFile: '.env.{mode}' } }],
      budgets: [{ id: 'size', label: 'size', unit: 'bytes', direction: 'max', limit: 10, cost: 'cheap', sources: [{ kind: 'command', argv: ['node', 'r.mjs'], parse: 'brotli: [0-9.]+ KB' }] }],
      plans: { globs: ['.local/*.md'], prRef: '#\\d+' },
    }))
    expect(got).toEqual([
      'process web: "envFrom.argRegex" needs a group around the value it reads, e.g. "--mode[= ](\\\\S+)"',
      'budget size: "sources[0].parse" needs a group around the value it reads, e.g. "brotli: ([0-9.]+) KB"',
      'plans: "prRef" needs a group around the value it reads, e.g. "#(\\\\d+)"',
    ])
  })

  test('process and environment patterns also run in .NET on Windows, so what .NET can not read is refused there only', async () => {
    const dotnet = (match: string) => reasons(everyRegex('worker', { processes: [{ id: 'web', label: 'web', kind: 'dev', match }] }))
    const at = 'process web: "match" also runs in .NET on Windows, '
    expect(dotnet('worker\\_js')).toEqual([at + 'which has no "\\_"; drop the backslash'])
    expect(dotnet('a\\qb')).toEqual([at + 'which has no "\\q"; drop the backslash'])
    expect(dotnet('x[]')).toEqual([at + 'which reads [] as the start of a class; write (?!) for "never matches"'])
    expect(dotnet('a[^]b')).toEqual([at + 'which reads [^] as the start of a class; write [\\s\\S] for "any character"'])
    expect(dotnet('\\x4')).toEqual([at + 'which reads "\\x" only as \\x41, \\u0041, \\p{L}, \\cA or \\k<name>; write it so, or drop the backslash'])
    expect(dotnet('(a)\\2')).toEqual([at + 'which has no group 2 for "\\2"; write the digit as [2]'])
    // What both engines read the same way passes, inside a class too.
    expect(dotnet('\\bnode\\s+[\\w.-]+\\.js\\b(a)\\1\\x41\\u0041\\p{L}[^\\]]')).toEqual([])
    // A design ban runs only in the mod, so JS's reading is all that matters there.
    expect(reasons(everyRegex('worker', { checks: [{ id: 'ban', label: 'ban', on: ['src/**'], analyzer: 'regex-lines', cost: 'edit', class: 'advise', options: { pattern: 'a\\qb[]' } }] }))).toEqual([])
  })

  test("the built-ins and the plan reader's own defaults pass the same rules", async () => {
    expect(reasons(everyRegex('worker', { plans: { globs: ['.local/*.md'], checkpoint: DEFAULT_CHECKPOINT, done: DEFAULT_DONE, prRef: DEFAULT_PR_REF } }))).toEqual([])
    for (const pack of BUILTINS) expect(checkPack(pack, 'built-in').reasons).toEqual([])
  })

  test('a parse error says how to fix the commonest slip: a regex backslash written once', async () => {
    const parsed = parseJsonc('{ "pattern": "\\d+" }')
    expect(parsed.error?.endsWith(PARSE_HINT)).toBe(true)
    expect(PARSE_HINT).toBe('; in JSONC write every regex backslash twice ("\\\\d", "\\\\b") and check commas and quotes')
  })
})

describe('the shape of each entry', () => {
  // Every field of every type set once, each source kind, every analyzer's options: a pack that must stay valid, so a
  // field the validator forgot to list shows up here as a refusal.
  const FULL = {
    schema: 1,
    id: 'acme-shop',
    version: '1',
    match: { remote: ['github.com/acme/*'] },
    extends: ['node-vite'],
    processes: [
      { id: 'web', label: 'web', match: '\\bweb\\b', kind: 'dev', heavy: true, envFrom: { argRegex: '--mode[= ](\\S+)', envFile: '.env.{mode}', envKey: 'API_URL' }, ramWarnMb: 2048 },
    ],
    environments: [
      { id: 'staging', label: 'staging', tone: 'shared', hostPatterns: ['*.staging.example.test'], argRegex: '--mode[= ]staging', readOnly: true,
        approvals: [
          { id: 'writes', tool: 'Bash', commandRegex: 'migrate', inputRegex: 'drop', label: 'writes', mode: 'log', scope: 'session' },
          { id: 'migration-files', tool: 'Edit', pathGlob: 'db/**', label: 'migration files', scope: 'once' },
        ] },
    ],
    checks: [
      { id: 'size', label: 'File length', on: ['src/**/*.ts'], analyzer: 'size-lines', cost: 'edit', class: 'ci', ignore: ['**/*.test.ts'], suppressions: 'eslint-suppressions.json', rules: ['max-lines'], options: { max: 500 } },
      { id: 'ban', label: 'Raw <button>', on: ['src/**/*.tsx'], analyzer: 'regex-lines', cost: 'edit', class: 'advise', options: { pattern: '<button\\b', message: 'use <Button>' } },
      { id: 'i18n', label: 'Translation keys', on: ['src/i18n/*.json'], analyzer: 'i18n-keysets', cost: 'turn', class: 'ci', options: { languages: ['da', 'en'] } },
      { id: 'lint', label: 'ESLint', on: ['src/**/*.ts'], analyzer: 'eslint-json', cost: 'turn', class: 'ci', timeoutMs: 60_000, bin: ['node', 'node_modules/eslint/bin/eslint.js'] },
      { id: 'ruff', label: 'ruff', on: ['**/*.py'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['ruff', 'check', '--output-format', 'sarif', '{files}'] },
      { id: 'gcc', label: 'gcc', on: ['**/*.c'], analyzer: 'problem-matcher', cost: 'turn', class: 'ci', bin: ['gcc', '{files}'],
        options: { pattern: '^(?<file>[^:]+):(?<line>\\d+): (?<message>.*)$', severity: 'warn' } },
    ],
    budgets: [
      { id: 'start', label: 'Start-up bundle', unit: 'bytes', direction: 'max', cost: 'cheap',
        limit: { relative: 1.05, baseline: { kind: 'json', path: 'baseline.json', pointer: '/start' } },
        sources: [
          { kind: 'command', argv: ['node', 'report.mjs'], parse: 'start: ([0-9.]+) KB', scale: 1024, freshAfter: 'dist/index.html', build: ['npm', 'run', 'build'] },
          { kind: 'ci-log', job: 'checks', step: 'Bundle budget', parse: 'start: ([0-9.]+) KB', scale: 1024 },
          { kind: 'json', path: 'report.json', pointer: '/start' },
          { kind: 'telemetry', metric: 'fps', stat: 'min' },
          { kind: 'dir-size', path: 'dist' },
          { kind: 'file-lines', path: 'perf.log', parse: 'frame (\\d+) ms', stat: 'p95' },
        ] },
    ],
    noise: [{ id: 'gen', glob: 'gen/**', kind: 'editor-rewrite', normalize: ['uid="[^"]*"'] }],
    plans: { globs: ['.local/*.md'], archiveDir: '.local/archive', checkpoint: 'CP\\d+', done: ['merged as #\\d+'], prRef: '#(\\d+)', results: { glob: 'perf/*.json', index: 'perf/index.json' } },
    disable: ['playwright'],
  }
  const reasons = (pack: object, layer: 'user' | 'built-in' = 'user') => checkPack(pack, layer).reasons
  const withEntry = (section: string, entry: object) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, [section]: [entry] })

  test('a pack that sets every field of every type is valid', async () => {
    expect(reasons(FULL)).toEqual([])
  })

  test('each type needs its own required fields, and says what each is for', async () => {
    expect(reasons(withEntry('checks', { id: 'lint', label: 'lint', on: ['src/**'], analyzer: 'eslint-json', cost: 'turn' }))).toEqual([
      'check lint needs "class": "ci" when the repo\'s CI fails on it, else "advise"',
    ])
    expect(reasons(withEntry('processes', { id: 'web', match: 'web' }))).toEqual([
      'process web needs "label", the name the pane shows',
      'process web needs "kind" (one of dev, test, worker, db, editor, game, build, batch)',
    ])
    expect(reasons(withEntry('environments', { id: 'staging', label: 'staging' }))).toEqual(['environment staging needs "tone" (one of local, shared, prod)'])
    // Noise has no label: its glob names it.
    expect(reasons(withEntry('noise', { id: 'gen', glob: 'gen/**', kind: 'generated' }))).toEqual([])
    expect(reasons(withEntry('noise', { id: 'gen', glob: 'gen/**' }))).toEqual(['noise gen needs "kind" (one of generated, editor-rewrite)'])
  })

  test('each value is of its kind: a string, a list of strings, a number above 0, true or false, one of a list', async () => {
    expect(reasons(withEntry('environments', { id: 'staging', label: 'staging', tone: 'production', hostPatterns: '*.staging.example.test', readOnly: 'yes' }))).toEqual([
      'environment staging: "tone" must be one of local, shared, prod',
      'environment staging: "hostPatterns" must be a list of strings',
      'environment staging: "readOnly" must be true or false',
    ])
    expect(reasons(withEntry('processes', { id: 'web', label: 'web', match: 'web', kind: 'dev', ramWarnMb: -1 }))).toEqual(['process web: "ramWarnMb" must be a number above 0'])
  })

  test('a key a type does not take is refused, nested ones too, with the keys it takes', async () => {
    expect(reasons(withEntry('processes', { id: 'web', label: 'web', match: 'web', kind: 'dev', envFrom: { argRegx: '(x)' } }))).toEqual([
      'process web: "envFrom" has "argRegx"; it takes argRegex, envFile, envKey',
    ])
    expect(reasons(withEntry('checks', { id: 'ban', label: 'ban', on: ['src/**'], analyzer: 'regex-lines', cost: 'edit', class: 'advise', options: { patern: 'x' } }))).toEqual([
      'check ban: needs "options.pattern", the regex each line is tested against',
      'check ban: "options" has "patern"; a regex-lines check takes pattern, message',
    ])
    expect(reasons(withEntry('checks', { id: 'lint', label: 'lint', on: ['src/**'], analyzer: 'eslint-json', cost: 'turn', class: 'ci', options: { fix: 1 } }))).toEqual([
      'check lint: "options" has "fix"; an eslint-json check takes no options',
    ])
    const [unknown] = reasons(withEntry('noise', { id: 'gen', glob: 'gen/**', kind: 'generated', normalise: [] }))
    expect(unknown).toBe('noise gen has "normalise"; it takes id, glob, kind, normalize')
  })

  test('a size-lines check needs its limit, or it checks nothing', async () => {
    const size = (options: object) => withEntry('checks', { id: 'size', label: 'size', on: ['src/**'], analyzer: 'size-lines', cost: 'edit', class: 'ci', options })
    const needsMax = 'check size: needs "options.max", a whole number of lines (e.g. 500)'
    for (const options of [{}, { max: '500' }, { max: 0 }, { max: 1.5 }]) expect(reasons(size(options))).toEqual([needsMax])
    expect(reasons(size({ max: 500 }))).toEqual([])
  })

  test('a budget: a limit, and at least one source of a known kind with that kind\'s fields', async () => {
    const budget = (fields: object) =>
      withEntry('budgets', { id: 'size', label: 'size', unit: 'bytes', direction: 'max', limit: 10, cost: 'cheap', sources: [{ kind: 'dir-size', path: 'dist' }], ...fields })
    expect(reasons(budget({ sources: [] }))).toEqual([
      'budget size: "sources" needs at least one source, where its value is read, e.g. [{ "kind": "json", "path": "<file>", "pointer": "/size" }]',
    ])
    expect(reasons(budget({ sources: [{ kind: 'http' }] }))).toEqual(['budget size: "sources[0].kind" must be one of json, command, ci-log, telemetry, dir-size, file-lines'])
    expect(reasons(budget({ sources: [{ kind: 'json', path: 'a.json', pointer: 'start' }] }))).toEqual([
      'budget size: "sources[0].pointer" must start with "/", a JSON pointer such as "/start/brotli"',
    ])
    // Each kind takes its own stats.
    expect(reasons(budget({ sources: [{ kind: 'telemetry', metric: 'fps', stat: 'count' }] }))).toEqual(['budget size: "sources[0].stat" must be one of p95, min, max, last'])
    expect(reasons(budget({ sources: [{ kind: 'file-lines', path: 'a.log', parse: '(\\d+)', stat: 'last' }] }))).toEqual(['budget size: "sources[0].stat" must be one of p95, max, count'])
    expect(reasons(budget({ sources: [{ kind: 'command', argv: [], parse: '(\\d+)' }] }))).toEqual([
      'budget size: "sources[0].argv" needs the program to run first, the command as a list, e.g. ["node", "tools/report.mjs"]',
    ])
    expect(reasons(budget({ limit: { relative: 1.05 } }))).toEqual([
      'budget size needs "limit.baseline", the source of the value the limit is a share of, e.g. { "kind": "json", "path": "<baseline>.json", "pointer": "/size" }',
    ])
    expect(reasons(budget({ limit: -1 }))).toEqual(['budget size: "limit" must be a number above 0 or { "relative": 1.05, "baseline": <a source> }'])
  })

  test('plans name their files; without globs a pack is refused instead of breaking the merge', async () => {
    const plans = (p: unknown) => ({ schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, plans: p })
    const needsGlobs = '"plans" needs "globs", the plan files as globs, e.g. [".local/*.md"]'
    expect(reasons(plans({ archiveDir: '.local/archive' }))).toEqual([needsGlobs])
    expect(reasons(plans({ globs: [] }))).toEqual([needsGlobs])
    expect(reasons(plans({ globs: ['.local/*.md'], results: { index: 'x.json' } }))).toEqual(['"plans" needs "results.glob" (a string)'])
    const text = JSON.stringify(plans({ archiveDir: '.local/archive' }))
    const resolved = resolvePack(input({ userPacks: [{ path: 'shop.pack.jsonc', text }] }))
    expect(resolved.report.layers.find(l => l.source === 'shop.pack.jsonc')).toMatchObject({ state: 'refused', reasons: [needsGlobs] })
  })

  test('a user pack names the remotes it is for; a built-in the marker files that pick it', async () => {
    const user = (match: unknown) => ({ schema: 1, id: 'acme-shop', version: '1', match })
    const needsRemote = 'needs "match.remote", globs over host/owner/repo such as ["github.com/<owner>/<repo>"]'
    expect(reasons({ schema: 1, id: 'acme-shop', version: '1' })).toEqual([needsRemote])
    expect(reasons(user({ remote: [] }))).toEqual([needsRemote])
    expect(reasons(user({ remotes: ['github.com/acme/*'] }))).toEqual(['"match" has "remotes"; it takes remote', needsRemote])
    const builtin = (detect: unknown) => ({ schema: 1, id: 'stack', version: '1', detect })
    expect(reasons({ schema: 1, id: 'stack', version: '1' }, 'built-in')).toEqual([
      'needs "detect", the marker files that pick it, e.g. [{ "file": "package.json", "contains": "\\"vite\\"", "weight": 2, "required": true }]',
    ])
    expect(reasons(builtin([{ file: 'README.md', weight: 1 }]), 'built-in')).toEqual(['"detect" needs one rule with "required": true, so the built-in applies only where its stack is'])
    expect(reasons(builtin([{ file: '../outside.txt', weight: 0, required: true }]), 'built-in')).toEqual([
      'detect rule 1: "weight" must be a number above 0',
      'detect rule 1: "file" must be a path inside the repo, such as "package.json"',
    ])
    expect(reasons({ ...FULL, extends: ['rails'] })).toEqual([`extends "rails", which isn't a built-in (the built-ins: ${BUILTINS.map(b => b.id).join(', ')})`])
  })

  test('an entry that extends a built-in\'s entry names only what it changes, and keeps that entry\'s label', async () => {
    const partial = { schema: 1, id: 'acme-shop', version: '1', match: { remote: ['github.com/acme/*'] }, checks: [{ id: 'eslint', on: ['src/**/*.ts'] }] }
    expect(reasons({ ...partial, extends: ['node-vite'] })).toEqual([])
    const resolved = resolvePack(input({ userPacks: [{ path: 'shop.pack.jsonc', text: JSON.stringify({ ...partial, extends: ['node-vite'] }) }] }))
    expect(entry(resolved, 'checks', 'eslint')).toMatchObject({ label: 'ESLint', layer: 'built-in', changedBy: ['user'] })
    expect(resolved.pack.checks.find(c => c.id === 'eslint')).toMatchObject({ analyzer: 'eslint-json', on: ['src/**/*.ts'] })
    // Without extends there is nothing to build on: the entry needs its own fields, and the reason says how to build on it.
    expect(reasons(partial)).toEqual([
      'check eslint needs "label", the name the pane shows',
      'check eslint needs "analyzer" (one of regex-lines, size-lines, i18n-keysets, eslint-json, sarif, problem-matcher, tscn-connections, tscn-nodepaths)',
      'check eslint needs "cost" (one of edit, turn, demand)',
      'check eslint needs "class": "ci" when the repo\'s CI fails on it, else "advise"',
      'check eslint is also in node-vite; to change only some of its fields, add "extends": ["node-vite"]',
    ])
  })
})

describe('the two layers', () => {
  test('(1) a user pack matched by its remote extends node-vite, changes a check and switches one off', async () => {
    const r = withUser()
    const resolved = resolvePack(r)
    expect(row(resolved, 'built-in')).toMatchObject({ source: 'node-vite', state: 'loaded', note: 'extended by acme-shop' })
    expect(row(resolved, 'user')).toMatchObject({ state: 'loaded', note: 'matched git@github.com:Acme/Shop.git' })
    expect(resolved.pack.id).toBe('acme-shop')
    expect(resolved.pack.checks.find(c => c.id === 'eslint')).toMatchObject({ label: 'ESLint (shop rules)', on: ['src/**/*.ts'], bin: ['node', 'node_modules/eslint/bin/eslint.js'] })
    expect(entry(resolved, 'checks', 'eslint')).toMatchObject({ layer: 'built-in', changedBy: ['user'] })
    expect(entry(resolved, 'budgets', 'bundle')).toMatchObject({ layer: 'user', changedBy: [] })
    expect(resolved.report.layers.map(l => l.layer)).toEqual(['built-in', 'user'])
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

  test('a host matching two tones takes the stricter', async () => {
    const prod = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] }, "extends": ["node-vite"],
      "environments": [{ "id": "staging", "label": "staging", "tone": "shared", "hostPatterns": ["*.staging.example.test"] },
        { "id": "prod", "label": "prod", "tone": "prod", "hostPatterns": ["*.example.test"] }] }`
    const resolved = resolvePack(input({ userPacks: [{ path: 'shop.pack.jsonc', text: prod }] }))
    expect(hostTone(resolved.pack, 'api.staging.example.test')).toBe('prod')
    expect(hostTone(resolved.pack, 'localhost')).toBe('local')
    expect(hostTone(resolved.pack, 'elsewhere.test')).toBeNull()
  })

  test('(8) without trust, no check that runs the repo’s tools: only the mod’s own', async () => {
    const own = `{ "schema": 1, "id": "own", "version": "1", "match": { "remote": ["github.com/acme/*"] },
      "checks": [{ "id": "size", "label": "file size", "on": ["src/**"], "analyzer": "size-lines", "cost": "edit", "class": "advise", "options": { "max": 500 } }] }`
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

  test('Godot scenes are compared inside the mod too, so those checks need no trust', async () => {
    const scenes = `{ "schema": 1, "id": "own", "version": "1", "match": { "remote": ["github.com/acme/*"] },
      "checks": [{ "id": "links", "label": "Scene connections", "on": ["**/*.tscn", "**/*.cs"], "analyzer": "tscn-connections", "cost": "turn", "class": "advise" },
        { "id": "paths", "label": "Scene node paths", "on": ["**/*.tscn", "**/*.cs"], "analyzer": "tscn-nodepaths", "cost": "turn", "class": "advise" }] }`
    const resolved = resolvePack(input({ userPacks: [{ path: 'own.pack.jsonc', text: scenes }] }))
    // Beside the detected built-in's ESLint, which does need trust.
    expect(resolved.pack.checks.map(c => c.id)).toEqual(['eslint', 'links', 'paths'])
    expect([entry(resolved, 'checks', 'links')?.needsTrust, entry(resolved, 'checks', 'paths')?.needsTrust]).toEqual([false, false])
  })

  test('a yes holds until it is withdrawn, also one stored by an older version with a config hash', async () => {
    expect(trustOf(false, { at: 5 })).toEqual({ isTrusted: true, by: 'you', at: 5 })
    expect(isStoredTrust({ at: 5 })).toBe(true)
    expect(isStoredTrust({ hash: 'of-files-no-longer-read', at: 5 })).toBe(true)
    expect(isStoredTrust({ hash: 'x' })).toBe(false)
    expect(trustOf(false, { hash: 'of-files-no-longer-read', at: 5 } as never)).toEqual({ isTrusted: true, by: 'you', at: 5 })
    expect(trustOf(false, null)).toEqual({ isTrusted: false, by: '', at: 0 })
    expect(trustOf(true, null)).toEqual({ isTrusted: true, by: 'user pack', at: 0 })
  })

  test('(9) a broken file adds nothing and says why; the rest still resolves', async () => {
    const resolved = resolvePack(input({ userPacks: [{ path: 'broken.pack.jsonc', text: '{ "schema": ' }, { path: 'bad.pack.jsonc', text: '{ "schema": 2 }' }] }))
    expect(resolved.report.layers.find(l => l.source === 'broken.pack.jsonc')).toMatchObject({ state: 'broken' })
    expect(resolved.report.layers.find(l => l.source === 'bad.pack.jsonc')).toMatchObject({
      state: 'refused',
      reasons: [
        'needs "schema": 1',
        'needs an "id", a short name such as "acme-shop"',
        'needs a "version", a string such as "1"',
        'needs "match.remote", globs over host/owner/repo such as ["github.com/<owner>/<repo>"]',
      ],
    })
    expect(resolved.pack.id).toBe('node-vite')
  })
})

describe('approval rules', () => {
  // A user pack (or, made into a built-in, a built-in) with one environment of the given tone and these rules.
  const withRules = (tone: string, approvals: object[], over: Record<string, unknown> = {}) => ({
    schema: 1,
    id: 'acme-shop',
    version: '1',
    match: { remote: ['github.com/acme/*'] },
    environments: [{ id: 'target', label: 'target', tone, approvals }],
    ...over,
  })
  const asBuiltin = (pack: Record<string, unknown>) => {
    const { match: _match, ...rest } = pack
    return { ...rest, detect: [{ file: 'package.json', weight: 1, required: true }] }
  }
  const rule = (over: Record<string, unknown>) => ({ id: 'r', tool: 'Bash', commandRegex: '^npm run x', label: 'r', scope: 'once', ...over })
  const reasonsOf = (pack: object, layer: 'built-in' | 'user' = 'user') => checkPack(pack, layer).reasons

  test('a tool that matches every call needs a field that narrows it; a tool-only MCP rule is fine', async () => {
    expect(reasonsOf(withRules('shared', [rule({ tool: '*', commandRegex: undefined })]))).toEqual([
      'approval r: "tool": "*" matches every tool call; add a "commandRegex", "inputRegex" or "pathGlob" that narrows it',
    ])
    expect(reasonsOf(withRules('shared', [rule({ tool: '**', commandRegex: undefined })]))[0]).toContain('matches every tool call')
    expect(reasonsOf(withRules('shared', [rule({ tool: '*' })]))).toEqual([])
    expect(reasonsOf(withRules('prod', [{ id: 'deploy', tool: 'mcp__*__trigger_deploy', label: 'deploy', scope: 'once' }]))).toEqual([])
  })

  test("a permission rule as the tool, and a field the tool can't have, are refused with what to write instead", async () => {
    expect(reasonsOf(withRules('shared', [rule({ tool: 'Bash(npm run *)' })]))).toEqual([
      'approval r: "tool" is a tool name or glob such as "Bash" or "mcp__*__execute_sql", not a permission rule; put the command in "commandRegex"',
    ])
    expect(reasonsOf(withRules('shared', [rule({ tool: 'mcp__*__execute_sql' })]))).toEqual([
      `approval r: "commandRegex" reads a shell command, but "tool": "mcp__*__execute_sql" isn't a shell tool (Bash, PowerShell, Monitor)`,
    ])
    expect(reasonsOf(withRules('shared', [rule({ commandRegex: undefined, pathGlob: 'db/**' })]))).toEqual([
      `approval r: "pathGlob" reads a file path, but "tool": "Bash" isn't Edit, Write or NotebookEdit`,
    ])
    expect(reasonsOf(withRules('shared', [rule({ tool: 'PowerShell' }), rule({ id: 'files', tool: 'Write', commandRegex: undefined, pathGlob: 'db/**' })]))).toEqual([])
  })

  test('only your own pack loosens a shared or prod rule; a built-in asks every time', async () => {
    const session = rule({ scope: 'session' })
    const log = rule({ mode: 'log' })
    expect(reasonsOf(asBuiltin(withRules('prod', [log])), 'built-in')).toEqual([`approval r: a built-in's prod rule asks; "mode": "log" comes only from a user pack`])
    expect(reasonsOf(asBuiltin(withRules('shared', [session])), 'built-in')).toEqual([
      `approval r: a built-in's shared rule asks every time; "scope": "session" comes only from a user pack`,
    ])
    expect(reasonsOf(asBuiltin(withRules('local', [session])), 'built-in')).toEqual([])
    expect(reasonsOf(asBuiltin(withRules('shared', [log])), 'built-in')).toEqual([])
    expect(reasonsOf(withRules('prod', [log, { ...session, id: 's' }]))).toEqual([])
  })

  test("an approval id may not be another entry's, nor one the pack switches off", async () => {
    expect(reasonsOf(withRules('shared', [rule({ id: 'target' })]))).toEqual([
      'approval target: the id is also an environment id in this pack or its built-in; "disable" would switch off both',
    ])
    expect(reasonsOf(withRules('shared', [rule({ id: 'eslint' })], { extends: ['node-vite'] }))[0]).toContain('the id is also a check id')
    expect(reasonsOf(withRules('shared', [rule({})], { disable: ['r'] }))).toEqual([
      'approval r: "disable" names this id, which switches the rule off; give the rule another id or leave it out',
    ])
  })

  // Rows as Debug › Pack gets them, from the merge of a built-in and a user pack.
  const BASE = {
    schema: 1 as const,
    id: 'base',
    version: '1',
    environments: [
      { id: 'staging', label: 'staging', tone: 'shared' as const, approvals: [{ id: 'x', tool: 'Bash', commandRegex: 'a', label: 'x', scope: 'once' as const }] },
      { id: 'prod', label: 'production', tone: 'prod' as const, approvals: [{ id: 'x', tool: 'Bash', commandRegex: 'a', label: 'x', scope: 'once' as const }] },
    ],
  }
  const rowsOf = (user: object) => {
    const { pack, entries } = mergeLayers([
      { layer: 'built-in', pack: BASE },
      { layer: 'user', pack: { schema: 1, id: 'mine', version: '1', ...user } },
    ])
    return entryRows(pack, entries).filter(e => e.section === 'approvals')
  }

  test('the same id in two environments is two rows, and one disable switches both off', async () => {
    expect(rowsOf({}).map(r => [r.env, r.id, r.removedBy ?? '', r.approval?.envLabel])).toEqual([
      ['staging', 'x', '', 'staging'],
      ['prod', 'x', '', 'production'],
    ])
    expect(rowsOf({ disable: ['x'] }).map(r => [r.env, r.removedBy, r.approval])).toEqual([
      ['staging', 'user', undefined],
      ['prod', 'user', undefined],
    ])
  })

  test('a switched-off environment takes its rules with it; a prod rule that logs or asks once a session is loosened', async () => {
    expect(rowsOf({ disable: ['prod'] }).map(r => [r.env, r.removedBy ?? ''])).toEqual([
      ['staging', ''],
      ['prod', 'user'],
    ])
    const loosened = rowsOf({ environments: [{ id: 'prod', approvals: [{ id: 'x', tool: 'Bash', commandRegex: 'a', label: 'x', scope: 'once', mode: 'log' }] }] })
    expect(loosened.map(r => [r.env, r.approval?.mode, r.approval?.isLoosened, r.layer, r.changedBy])).toEqual([
      ['staging', 'ask', false, 'built-in', []],
      ['prod', 'log', true, 'built-in', ['user']],
    ])
    const session = rowsOf({ environments: [{ id: 'staging', approvals: [{ id: 'x', tool: 'Bash', commandRegex: 'a', label: 'x', scope: 'session' }] }] })
    expect(session.map(r => r.approval?.isLoosened)).toEqual([false, false])
  })
})
