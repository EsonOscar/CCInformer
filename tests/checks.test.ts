import { describe, expect, test } from 'claude-code/testing'

import { countLines, covers, eslintFindings, noteFor, ownedRules, regexFindings, sizeFindings, toolFindings, withoutInline } from '../hooks/checks/findings'
import { matchesGlob, repoPath, toRepoFile } from '../hooks/checks/glob'
import { MAX_LINE_CHARS, TOO_MANY_LINES, matcherResults } from '../hooks/checks/matcher'
import { sarifResults } from '../hooks/checks/sarif'
import { NO_SARIF_FILE, SARIF_FILE_TOO_BIG, TRUNCATED, hash8, isQuietSkip, outputFile, readRun, takesFiles, toolArgv } from '../hooks/checks/tools'
import { parseSuppressions, suppress } from '../hooks/checks/suppressions'
import type { CheckSpec } from '../hooks/packs/types'

const SIZE: CheckSpec = {
  id: 'max-lines',
  label: 'File length',
  on: ['src/**/*.{ts,tsx}'],
  ignore: ['**/*.test.ts'],
  analyzer: 'size-lines',
  cost: 'edit',
  class: 'ci',
  rules: ['max-lines'],
  options: { max: 10 },
  suppressions: 'eslint-suppressions.json',
}
const ESLINT: CheckSpec = { id: 'eslint', label: 'ESLint', on: ['**/*.{ts,tsx}'], analyzer: 'eslint-json', cost: 'turn', class: 'ci' }
const lines = (n: number) => Array.from({ length: n }, (_, i) => `const a${i} = ${i}`).join('\n') + '\n'
const message = (ruleId: string | null, line: number, severity = 2) => ({ ruleId, severity, message: `${ruleId ?? 'Parsing error'} at ${line}`, line })

describe('globs and paths', () => {
  test('** spans folders, * stays in one, {a,b} is either', async () => {
    expect(matchesGlob(['src/**/*.{ts,tsx}'], 'src/a.ts')).toBe(true)
    expect(matchesGlob(['src/**/*.{ts,tsx}'], 'src/ui/deep/b.tsx')).toBe(true)
    expect(matchesGlob(['src/**/*.{ts,tsx}'], 'src/ui/b.js')).toBe(false)
    expect(matchesGlob(['src/*.ts'], 'src/ui/a.ts')).toBe(false)
    expect(matchesGlob(['**/*.test.ts'], 'a.test.ts')).toBe(true)
    expect(covers(SIZE, 'src/a.test.ts')).toBe(false)
    expect(covers(SIZE, 'src/a.ts')).toBe(true)
  })

  test("a file's path from the repo's top folder; Windows paths compare without case", async () => {
    expect(repoPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(repoPath('C:/Users/me/Repo', 'c:\\users\\me\\repo\\src\\a.ts')).toBe('src/a.ts')
    expect(repoPath('/repo', '/other/src/a.ts')).toBe('')
    expect(repoPath('/repo', '/repository/a.ts')).toBe('')
  })

  test("a tool's path: relative ones join the root, dots resolve, one that climbs out lands outside", async () => {
    expect(toRepoFile('/repo', 'src/a.c')).toBe('src/a.c')
    expect(toRepoFile('/repo', './src/./a.c')).toBe('src/a.c')
    expect(toRepoFile('/repo', 'src/../src/a.c')).toBe('src/a.c')
    expect(toRepoFile('/repo', '../repo/src/a.c')).toBe('src/a.c')
    expect(toRepoFile('/repo', '../other/a.c')).toBe('')
    expect(toRepoFile('/repo', '/repo/src/../../etc/passwd')).toBe('')
    expect(toRepoFile('/repo', '/repo/src/a.c')).toBe('src/a.c')
    expect(toRepoFile('C:\\work\\demo', 'c:/WORK/demo/src\\App.cs')).toBe('src/App.cs')
    expect(toRepoFile('C:/work/demo', 'src\\App.cs')).toBe('src/App.cs')
    expect(toRepoFile('C:/work/demo', 'D:/work/demo/src/App.cs')).toBe('')
  })
})

describe("ESLint's suppressions", () => {
  test('no more violations than the count suppresses all of them; more reports all of them', async () => {
    const file = { 'max-lines-per-function': { count: 2 } }
    expect(suppress(file, { 'max-lines-per-function': 2 })).toEqual({ suppressed: ['max-lines-per-function'], unused: [] })
    expect(suppress(file, { 'max-lines-per-function': 3 })).toEqual({ suppressed: [], unused: [] })
  })

  test('a count above the violations, or a rule with none left, is unused', async () => {
    const file = { 'no-explicit-any': { count: 3 }, 'max-lines': { count: 1 } }
    expect(suppress(file, { 'no-explicit-any': 1 })).toEqual({
      suppressed: ['no-explicit-any'],
      unused: [
        { rule: 'no-explicit-any', count: 2 },
        { rule: 'max-lines', count: 1 },
      ],
    })
    // Limited to the rules a check evaluated.
    expect(suppress(file, {}, ['max-lines'])).toEqual({ suppressed: [], unused: [{ rule: 'max-lines', count: 1 }] })
  })

  test('a missing or broken file suppresses nothing', async () => {
    expect(parseSuppressions('')).toEqual({})
    expect(parseSuppressions('{ nope')).toEqual({})
    expect(parseSuppressions('{"src/a.ts":{"max-lines":{"count":1}}}')).toEqual({ 'src/a.ts': { 'max-lines': { count: 1 } } })
  })
})

describe('size-lines', () => {
  test('lines are counted as ESLint counts them: the empty line after a final newline is not one', async () => {
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\r\nb\r\n\r\n')).toBe(3)
    expect(countLines('')).toBe(1)
  })

  test('over the limit is an error CI fails on; near it is information', async () => {
    const [over] = sizeFindings(SIZE, 'src/a.ts', lines(11), {})
    expect(over).toMatchObject({ severity: 'error', ciWouldFail: true, rule: 'max-lines', message: '11 lines, over the limit of 10' })
    const [near] = sizeFindings(SIZE, 'src/a.ts', lines(9), {})
    expect(near).toMatchObject({ severity: 'info', ciWouldFail: false, message: '9 lines, near the limit of 10' })
    expect(sizeFindings(SIZE, 'src/a.ts', lines(8), {})).toEqual([])
  })

  test('a suppressed over-limit file is information only; one back under its limit leaves an unused suppression', async () => {
    const suppressions = { 'src/a.ts': { 'max-lines': { count: 1 } } }
    const [suppressed] = sizeFindings(SIZE, 'src/a.ts', lines(14), suppressions)
    expect(suppressed).toMatchObject({ severity: 'info', ciWouldFail: false, message: expect.stringMatching(/suppressed: don't grow it/) })
    expect(sizeFindings(SIZE, 'src/a.ts', lines(5), suppressions)).toEqual([
      expect.objectContaining({ rule: 'max-lines', severity: 'error', ciWouldFail: true, message: expect.stringMatching(/unused suppression \(1\)/) }),
    ])
  })
})

describe("ESLint's JSON", () => {
  test("the repo's suppressions are applied as ESLint applies them, and an unused one would fail CI", async () => {
    const out = JSON.stringify([
      { filePath: 'C:\\Repo\\src\\a.ts', messages: [message('no-explicit-any', 3), message('no-explicit-any', 9), message('no-console', 4, 1)] },
      { filePath: 'C:\\Repo\\src\\b.ts', messages: [message('no-explicit-any', 1), message('no-explicit-any', 2)] },
      { filePath: 'C:\\Repo\\src\\c.ts', messages: [] },
    ])
    const suppressions = {
      'src/a.ts': { 'no-explicit-any': { count: 2 } },
      'src/b.ts': { 'no-explicit-any': { count: 1 } },
      'src/c.ts': { 'react-hooks/exhaustive-deps': { count: 1 } },
    }
    const { findings, files, error } = eslintFindings(ESLINT, out, 'C:/Repo', suppressions, () => [])
    expect(error).toBe('')
    expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(findings.map(f => [f.file, f.line, f.rule, f.severity, f.ciWouldFail])).toEqual([
      // a: two any, two suppressed; the warning stays and doesn't fail CI.
      ['src/a.ts', 4, 'no-console', 'warn', false],
      // b: two any against a count of one, so both are reported.
      ['src/b.ts', 1, 'no-explicit-any', 'error', true],
      ['src/b.ts', 2, 'no-explicit-any', 'error', true],
      // c: nothing left to suppress.
      ['src/c.ts', 0, 'react-hooks/exhaustive-deps', 'error', true],
    ])
  })

  test("rules an inline check owns are left out, a file it couldn't parse is an error, and broken output says so", async () => {
    const out = JSON.stringify([{ filePath: '/repo/src/a.ts', messages: [message('max-lines', 1), message(null, 7)] }])
    const { findings } = eslintFindings(ESLINT, out, '/repo', { 'src/a.ts': { 'max-lines': { count: 1 } } }, () => ownedRules(SIZE))
    expect(findings.map(f => [f.rule, f.line, f.ciWouldFail])).toEqual([['parse', 7, true]])
    expect(eslintFindings(ESLINT, 'Oops', '/repo', {}, () => []).error).toBe("ESLint's output could not be read")
  })

  test('module-boundaries rules are findings like any other: CI errors told to the model, suppressible', async () => {
    const out = JSON.stringify([
      { filePath: '/repo/src/modules/orders/page.tsx', messages: [message('module-boundaries/no-internal-import', 3), message('module-boundaries/no-cross-module-import', 8)] },
      { filePath: '/repo/src/modules/users/view.tsx', messages: [message('module-boundaries/no-internal-import', 5)] },
      { filePath: '/repo/src/modules/users/list.tsx', messages: [] },
    ])
    const suppressions = {
      'src/modules/users/view.tsx': { 'module-boundaries/no-internal-import': { count: 1 } },
      'src/modules/users/list.tsx': { 'module-boundaries/no-cross-module-import': { count: 1 } },
    }
    const { findings } = eslintFindings(ESLINT, out, '/repo', suppressions, () => [])
    expect(findings.map(f => [f.file, f.line, f.rule, f.severity, f.ciWouldFail])).toEqual([
      ['src/modules/orders/page.tsx', 3, 'module-boundaries/no-internal-import', 'error', true],
      ['src/modules/orders/page.tsx', 8, 'module-boundaries/no-cross-module-import', 'error', true],
      // view.tsx: its one violation is suppressed. list.tsx: a suppression with nothing left to suppress.
      ['src/modules/users/list.tsx', 0, 'module-boundaries/no-cross-module-import', 'error', true],
    ])
    const note = noteFor(findings, 'turn')
    expect(note).toContain('- src/modules/orders/page.tsx:3 module-boundaries/no-internal-import: module-boundaries/no-internal-import at 3 [CI will fail]')
    expect(note).toContain('- src/modules/orders/page.tsx:8 module-boundaries/no-cross-module-import: module-boundaries/no-cross-module-import at 8 [CI will fail]')
  })
})

describe('tool findings', () => {
  const RUFF: CheckSpec = { id: 'ruff', label: 'ruff', on: ['**/*.py'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['ruff', 'check', '--output-format', 'sarif', '{files}'] }
  const raw = (file: string, line: number, rule: string, severity: 'error' | 'warn' | 'info' = 'error', column = 1, message = `${rule} at ${line}`) => ({ file, line, column, rule, severity, message })

  test('the same finding twice on one line counts twice for ESLint (two any in one signature), but a repeated result counts once', async () => {
    const out = JSON.stringify([{ filePath: '/repo/src/a.ts', messages: [{ ...message('no-explicit-any', 3), column: 10 }, { ...message('no-explicit-any', 3), column: 20 }] }])
    const { findings } = eslintFindings(ESLINT, out, '/repo', { 'src/a.ts': { 'no-explicit-any': { count: 2 } } }, () => [])
    expect(findings).toEqual([])
    const twice = toolFindings(RUFF, [raw('src/a.py', 3, 'E501'), raw('src/a.py', 3, 'E501')], ['src/a.py'], '/repo', { 'src/a.py': { E501: { count: 2 } } }, () => [], 'warn')
    expect(twice.findings.map(f => [f.rule, f.severity, f.message, f.ciWouldFail])).toEqual([['E501', 'warn', 'unused suppression (1): prune it before pushing', false]])
  })

  test("findings land on the run's files, matched without case on Windows and saved under the run's spelling; the rest are counted", async () => {
    const raws = [raw('src/App.cs', 30, 'CS0103'), raw('src/Other.cs', 2, 'CA1822', 'warn'), raw('', 0, 'MSB1009')]
    const { findings, elsewhere } = toolFindings(RUFF, raws, ['SRC/app.cs'], 'C:\\work\\demo', {}, () => [], 'warn')
    expect(findings.map(f => [f.file, f.line, f.rule, f.ciWouldFail])).toEqual([['SRC/app.cs', 30, 'CS0103', true]])
    expect(elsewhere).toBe(2)
    const posix = toolFindings(RUFF, raws, ['SRC/app.cs'], '/work/demo', {}, () => [], 'warn')
    expect(posix).toEqual({ findings: [], elsewhere: 3 })
  })

  test("suppressions are evaluated only for files the tool reported on: a raw, or an artifact it listed", async () => {
    const suppressions = { 'src/a.py': { E501: { count: 1 } }, 'src/b.py': { E501: { count: 1 } }, 'src/c.py': { E501: { count: 1 } } }
    const { findings } = toolFindings(RUFF, [raw('src/a.py', 1, 'E501')], ['src/a.py', 'src/b.py', 'src/c.py'], '/repo', suppressions, () => [], 'warn', ['src/b.py'])
    // a: its one violation suppressed; b: listed and clean, so its suppression is unused; c: never looked at.
    expect(findings.map(f => [f.file, f.severity, f.ciWouldFail])).toEqual([['src/b.py', 'warn', false]])
  })
})

describe('SARIF', () => {
  const RUFF: CheckSpec = { id: 'ruff', label: 'ruff', on: ['**/*.py'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['ruff', 'check', '--output-format', 'sarif', '{files}'] }
  const ROOT = '/work/demo'
  const uri = (file: string) => `file://${ROOT}/${file}`
  const at = (file: string, line: number, column: number, index?: number) => ({
    physicalLocation: { artifactLocation: { uri: uri(file), ...(index === undefined ? {} : { index }) }, region: { startLine: line, startColumn: column } },
  })
  // What ESLint's SARIF formatter writes for the same run as the JSON below (checked against the formatter 3.1.0
  // on ESLint 9.39: the parse error is a notification, an inline-disabled message a result with an inSource entry).
  const ESLINT_SARIF = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'ESLint', rules: [{ id: 'no-unused-vars' }, { id: 'no-console' }, { id: 'eqeqeq' }] } },
        artifacts: ['src/a.ts', 'src/b.ts', 'src/broken.ts', 'src/clean.ts'].map(f => ({ location: { uri: uri(f) } })),
        results: [
          { ruleId: 'no-unused-vars', ruleIndex: 0, level: 'error', message: { text: "'total' is assigned a value but never used." }, locations: [at('src/a.ts', 1, 7, 0)], suppressions: [] },
          { ruleId: 'no-console', ruleIndex: 1, level: 'warning', message: { text: 'Unexpected console statement.' }, locations: [at('src/a.ts', 8, 1, 0)], suppressions: [] },
          { ruleId: 'no-console', ruleIndex: 1, level: 'warning', message: { text: 'Unexpected console statement.' }, locations: [at('src/a.ts', 10, 1, 0)], suppressions: [{ kind: 'inSource', justification: '' }] },
          { ruleId: 'eqeqeq', ruleIndex: 2, level: 'error', message: { text: "Expected '===' and instead saw '=='." }, locations: [at('src/b.ts', 1, 27, 1)] },
        ],
        invocations: [{ toolConfigurationNotifications: [{ level: 'error', message: { text: 'Parsing error: Unexpected token =' }, locations: [at('src/broken.ts', 1, 7, 2)], descriptor: { id: 'ESL0999' } }], executionSuccessful: false }],
      },
    ],
  }
  const ESLINT_JSON = [
    { filePath: `${ROOT}/src/a.ts`, messages: [{ ruleId: 'no-unused-vars', severity: 2, message: "'total' is assigned a value but never used.", line: 1, column: 7 }, { ruleId: 'no-console', severity: 1, message: 'Unexpected console statement.', line: 8, column: 1 }] },
    { filePath: `${ROOT}/src/b.ts`, messages: [{ ruleId: 'eqeqeq', severity: 2, message: "Expected '===' and instead saw '=='.", line: 1, column: 27 }] },
    { filePath: `${ROOT}/src/broken.ts`, messages: [{ ruleId: null, severity: 2, message: 'Parsing error: Unexpected token =', line: 1, column: 7, fatal: true }] },
    { filePath: `${ROOT}/src/clean.ts`, messages: [] },
  ]
  const FILES = ['src/a.ts', 'src/b.ts', 'src/broken.ts', 'src/clean.ts']
  const SUPPRESSIONS = { 'src/a.ts': { 'no-unused-vars': { count: 1 } }, 'src/b.ts': { eqeqeq: { count: 2 } }, 'src/clean.ts': { 'no-console': { count: 1 } } }
  const shape = (f: { file: string; line: number; rule: string; severity: string; message: string; ciWouldFail: boolean }) => [f.file, f.line, f.rule, f.severity, f.message.replace(' (eslint --prune-suppressions)', ''), f.ciWouldFail]

  test("ESLint's SARIF gives the findings its JSON gives: the parse error from the notifications, the inline-disabled result left out, the same suppressions applied", async () => {
    const { raws, reported, error } = sarifResults(RUFF, JSON.stringify(ESLINT_SARIF), ROOT)
    expect(error).toBe('')
    expect(reported).toEqual(FILES)
    const viaSarif = toolFindings(ESLINT, raws, FILES, ROOT, SUPPRESSIONS, () => [], 'warn', reported).findings
    const viaJson = eslintFindings(ESLINT, JSON.stringify(ESLINT_JSON), ROOT, SUPPRESSIONS, () => []).findings
    const unused = (f: { line: number; message: string }) => f.line === 0 && f.message.startsWith('unused suppression')
    expect(viaSarif.filter(f => !unused(f)).map(shape)).toEqual(viaJson.filter(f => !unused(f)).map(shape))
    expect(viaSarif.filter(f => !unused(f)).map(shape)).toEqual([
      ['src/a.ts', 8, 'no-console', 'warn', 'Unexpected console statement.', false],
      ['src/broken.ts', 1, 'parse', 'error', 'Parsing error: Unexpected token =', true],
    ])
    // The unused ones name the same files and counts; only ESLint's own can fail CI.
    expect(viaSarif.filter(unused).map(f => [f.file, f.rule, f.message, f.severity, f.ciWouldFail])).toEqual([
      ['src/b.ts', 'eqeqeq', 'unused suppression (1): prune it before pushing', 'warn', false],
      ['src/clean.ts', 'no-console', 'unused suppression (1): prune it before pushing', 'warn', false],
    ])
    expect(viaJson.filter(unused).map(f => [f.file, f.rule, f.severity, f.ciWouldFail])).toEqual([
      ['src/b.ts', 'eqeqeq', 'error', true],
      ['src/clean.ts', 'no-console', 'error', true],
    ])
  })

  test('a dotnet build log: absolute Windows uris, a folder in another case than the written path, warnings and errors', async () => {
    // As Roslyn writes it with -p:ErrorLog=<file>%2Cversion=2.1 (checked on dotnet 10): file:///C:/ uris, no artifacts, no base ids.
    const log = {
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'Microsoft (R) Visual C# Compiler', rules: [{ id: 'CA1822', defaultConfiguration: { level: 'note' } }, { id: 'CS0103' }] } },
        results: [
          { ruleId: 'CS0103', ruleIndex: 1, level: 'error', message: { text: "The name 'conect' does not exist in the current context" }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/Demo/src/Demo.App/Program.cs' }, region: { startLine: 30, startColumn: 9 } } }] },
          { ruleId: 'CA1822', ruleIndex: 0, level: 'warning', message: { text: "Member 'Total' does not access instance data and can be marked as static" }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/demo/src/Demo.App/Billing/Invoice.cs' }, region: { startLine: 12, startColumn: 24 } } }], properties: { warningLevel: 1 } },
          { ruleId: 'CA1515', level: 'warning', message: { text: 'Types can be made internal' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/demo/src/Demo.App/Program.cs' }, region: { startLine: 2, startColumn: 14 } } }], suppressions: [{ kind: 'inSource' }] },
          { ruleId: 'CA2000', level: 'warning', message: { text: 'Dispose it' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/demo/src/Demo.App/Program.cs' }, region: { startLine: 3 } } }], suppressions: [{ kind: 'external', status: 'rejected' }] },
          { ruleIndex: 0, message: { text: 'level from the rule: note' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/demo/src/Demo.App/Program.cs' }, region: { startLine: 4 } } }] },
          { ruleId: 'CS8019', level: 'none', message: { text: 'Unnecessary using' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/demo/src/Demo.App/Program.cs' }, region: { startLine: 1 } } }] },
          { ruleId: 'MSB1009', level: 'error', message: { text: 'Project file does not exist' } },
          { ruleId: 'CS0103', level: 'error', kind: 'pass', message: { text: 'passed' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///C:/work/demo/src/Demo.App/Program.cs' }, region: { startLine: 31 } } }] },
        ],
      }],
    }
    const { raws, reported, error } = sarifResults(RUFF, JSON.stringify(log), 'C:\\work\\demo')
    expect(error).toBe('')
    expect(reported).toEqual([])
    expect(raws.map(r => [r.file, r.line, r.column, r.rule, r.severity])).toEqual([
      ['src/Demo.App/Program.cs', 30, 9, 'CS0103', 'error'],
      ['src/Demo.App/Billing/Invoice.cs', 12, 24, 'CA1822', 'warn'],
      ['src/Demo.App/Program.cs', 3, 0, 'CA2000', 'warn'],
      ['src/Demo.App/Program.cs', 4, 0, 'CA1822', 'info'],
      ['', 0, 0, 'MSB1009', 'error'],
    ])
    const { findings, elsewhere } = toolFindings(RUFF, raws, ['src/demo.app/program.cs'], 'C:\\work\\demo', {}, () => [], 'warn')
    expect(findings.map(f => [f.file, f.line, f.rule, f.severity, f.ciWouldFail])).toEqual([
      ['src/demo.app/program.cs', 30, 'CS0103', 'error', true],
      ['src/demo.app/program.cs', 3, 'CA2000', 'warn', false],
      ['src/demo.app/program.cs', 4, 'CA1822', 'info', false],
    ])
    expect(elsewhere).toBe(2)
  })

  test('uris: relative ones under a base id, percent-encoding, another machine, another scheme, an encoded climb, pathmap, several runs', async () => {
    const result = (uri: string, line: number, extra: object = {}) => ({ ruleId: 'R1', level: 'error', message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri, ...extra }, region: { startLine: line } } }] })
    const run = (results: object[], extra: object = {}) => ({ tool: { driver: { name: 't' } }, results, ...extra })
    const log = {
      version: '2.1.0',
      runs: [
        run([result('src/My%20App/a.py', 1, { uriBaseId: '%SRCROOT%' }), result('src/b.py', 2, { uriBaseId: '%SRCROOT%' })], { originalUriBaseIds: { '%SRCROOT%': { uri: 'file:///work/demo/' } } }),
        run([result('file://build-server/share/src/c.py', 3), result('https://example.test/src/d.py', 4), result('file:///work/demo/src/%2F..%2F..%2Fetc/passwd', 5), result('/_/src/e.py', 6), result('src/b.py', 2)]),
        run([result('', 7)], { artifacts: [{ location: { uri: 'src/f.py', uriBaseId: '%SRCROOT%' } }], originalUriBaseIds: { '%SRCROOT%': { uri: 'file:///work/demo' } } }),
      ],
    }
    const { raws, reported } = sarifResults(RUFF, JSON.stringify(log), '/work/demo')
    expect(raws.map(r => [r.file, r.line])).toEqual([['src/My App/a.py', 1], ['src/b.py', 2], ['', 3], ['', 4], ['', 5], ['', 6], ['src/b.py', 2], ['', 7]])
    expect(reported).toEqual(['src/f.py'])
    // The repeated result counts once; the rest is elsewhere.
    const { findings, elsewhere } = toolFindings(RUFF, raws, ['src/My App/a.py', 'src/b.py'], '/work/demo', {}, () => [], 'warn')
    expect(findings.map(f => [f.file, f.line])).toEqual([['src/My App/a.py', 1], ['src/b.py', 2]])
    expect(elsewhere).toBe(5)
  })

  test('what is not SARIF 2.1.0 is refused: a 1.0 log, no runs, not JSON; a message by id and a rule by id read', async () => {
    const refused = "its output isn't SARIF 2.1.0"
    expect(sarifResults(RUFF, JSON.stringify({ version: '1.0.0', runs: [{ results: [{ ruleId: 'CS0103', level: 'error' }] }] }), ROOT).error).toBe(refused)
    expect(sarifResults(RUFF, JSON.stringify({ version: '2.1.0' }), ROOT).error).toBe(refused)
    expect(sarifResults(RUFF, '', ROOT).error).toBe(refused)
    expect(sarifResults(RUFF, 'Build FAILED.', ROOT).error).toBe(refused)
    const log = { version: '2.1.0', runs: [{ results: [{ rule: { id: 'by-rule' }, message: { id: 'default' }, locations: [at('src/a.py', 9, 1)] }, { message: { text: 'no rule at all' } }] }] }
    expect(sarifResults(RUFF, JSON.stringify(log), ROOT).raws.map(r => [r.file, r.rule, r.severity, r.message])).toEqual([
      ['src/a.py', 'by-rule', 'warn', 'default'],
      ['', 'ruff', 'warn', 'no rule at all'],
    ])
  })
})

describe('problem-matcher', () => {
  // The README's gcc pattern.
  const GCC =
    '^(?<file>(?:[A-Za-z]:)?[^:]+):(?<line>\\d+):(?:(?<column>\\d+):)?\\s+(?:fatal\\s+)?(?<severity>error|warning|note):\\s+(?<message>.*?)(?:\\s+\\[(?<code>-W[^\\]]+)\\])?$'
  const gcc = (fields: Partial<CheckSpec> = {}): CheckSpec =>
    ({ id: 'gcc', label: 'gcc', on: ['**/*.c'], analyzer: 'problem-matcher', cost: 'turn', class: 'ci', bin: ['gcc', '-fsyntax-only', '{files}'], options: { pattern: GCC }, ...fields })
  const GCC_OUT = [
    "src/net/socket.c: In function 'open_socket':",
    "src/net/socket.c:42:13: warning: unused variable 'flags' [-Wunused-variable]",
    '   42 |         int flags = 0;',
    '      |             ^~~~~',
    "src/net/socket.c:57:5: error: implicit declaration of function 'conect'; did you mean 'connect'? [-Wimplicit-function-declaration]",
    "include/net/socket.h:9:5: note: 'connect' declared here",
    '',
  ].join('\n')

  test("gcc's stderr: one raw per diagnostic line, the code as the rule, the note on a header counted elsewhere", async () => {
    const { raws, error } = matcherResults(gcc(), GCC_OUT, '/work/demo')
    expect(error).toBe('')
    expect(raws.map(r => [r.file, r.line, r.column, r.severity, r.rule, r.message])).toEqual([
      ['src/net/socket.c', 42, 13, 'warn', '-Wunused-variable', "unused variable 'flags'"],
      ['src/net/socket.c', 57, 5, 'error', '-Wimplicit-function-declaration', "implicit declaration of function 'conect'; did you mean 'connect'?"],
      ['include/net/socket.h', 9, 5, 'info', 'gcc', "'connect' declared here"],
    ])
    const { findings, elsewhere } = toolFindings(gcc(), raws, ['src/net/socket.c'], '/work/demo', {}, () => [], 'warn')
    expect(findings.map(f => [f.file, f.line, f.rule, f.severity, f.ciWouldFail])).toEqual([
      ['src/net/socket.c', 42, '-Wunused-variable', 'warn', false],
      ['src/net/socket.c', 57, '-Wimplicit-function-declaration', 'error', true],
    ])
    expect(elsewhere).toBe(1)
  })

  test('ANSI colours are stripped, a drive letter matches, and a repeated msbuild line counts once', async () => {
    const coloured = '\x1b[1msrc/a.c:1:1: \x1b[31merror\x1b[0m: boom\n'
    expect(matcherResults(gcc(), coloured, '/work/demo').raws.map(r => [r.file, r.severity, r.message])).toEqual([['src/a.c', 'error', 'boom']])
    expect(matcherResults(gcc(), 'C:/work/demo/src/a.c:3:1: error: boom\n', 'C:/work/demo').raws.map(r => [r.file, r.line])).toEqual([['src/a.c', 3]])
    const MSBUILD = '^(?<file>(?:[A-Za-z]:)?[^(]+)\\((?<line>\\d+),(?<column>\\d+)\\): (?<severity>error|warning) (?<code>[A-Z]+\\d+): (?<message>.*?)(?: \\[[^\\]]*\\])?$'
    const line = "C:\\work\\demo\\src\\App\\Program.cs(30,9): error CS0103: The name 'conect' does not exist in the current context [C:\\work\\demo\\src\\App\\App.csproj]"
    const msbuild = gcc({ id: 'dotnet', options: { pattern: MSBUILD } })
    const { raws } = matcherResults(msbuild, [line, 'Build FAILED.', line, ''].join('\n'), 'C:\\work\\demo')
    expect(raws.map(r => [r.file, r.line, r.column, r.rule, r.message])).toEqual([
      ['src/App/Program.cs', 30, 9, 'CS0103', "The name 'conect' does not exist in the current context"],
      ['src/App/Program.cs', 30, 9, 'CS0103', "The name 'conect' does not exist in the current context"],
    ])
    expect(toolFindings(msbuild, raws, ['src/App/Program.cs'], 'C:\\work\\demo', {}, () => [], 'warn').findings.length).toBe(1)
  })

  test('the severity: known words as whole words without case, else options.severity, else error; the rule from rules[0] when there is no code', async () => {
    const SIMPLE = '^(?<file>[^:]+):(?<line>\\d+): (?:(?<severity>\\w+(?: error)?): )?(?<message>.*)$'
    const out = ['src/a.c:1: fatal error: one', 'src/a.c:2: WARNING: two', 'src/a.c:3: remark: three', 'src/a.c:4: four', 'src/a.c:5: hint: five'].join('\n')
    const check = gcc({ options: { pattern: SIMPLE, severity: 'warn' }, rules: ['tidy'] })
    expect(matcherResults(check, out, '/work/demo').raws.map(r => [r.line, r.severity, r.rule, r.message])).toEqual([
      [1, 'error', 'tidy', 'one'],
      [2, 'warn', 'tidy', 'two'],
      [3, 'warn', 'tidy', 'three'],
      [4, 'warn', 'tidy', 'four'],
      [5, 'info', 'tidy', 'five'],
    ])
    expect(matcherResults(gcc({ options: { pattern: SIMPLE } }), 'src/a.c:3: remark: three', '/work/demo').raws.map(r => [r.severity, r.rule])).toEqual([['error', 'gcc']])
  })

  test('a long line is tested on its first characters, and too many lines are an error rather than a partial result', async () => {
    const long = 'src/a.c:1:1: error: ' + 'x'.repeat(MAX_LINE_CHARS + 1000)
    const { raws } = matcherResults(gcc(), long, '/work/demo')
    expect(raws.map(r => [r.file, r.line, r.severity, r.message.length])).toEqual([['src/a.c', 1, 'error', MAX_LINE_CHARS - 'src/a.c:1:1: error: '.length]])
    const many = (n: number) => Array.from({ length: n }, (_, i) => `src/a.c:${i + 1}:1: warning: w`).join('\n') + '\n'
    expect(matcherResults(gcc(), many(20_000), '/work/demo').raws.length).toBe(20_000)
    expect(matcherResults(gcc(), many(20_001), '/work/demo')).toEqual({ raws: [], error: TOO_MANY_LINES })
  })
})

describe('tool runs', () => {
  const ran = (over: Partial<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }> = {}) =>
    ({ exitCode: 0, stdout: '', stderr: '', ...over })
  const RUFF: CheckSpec = { id: 'ruff', label: 'ruff', on: ['**/*.py'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['ruff', 'check', '--output-format', 'sarif', '{files}'] }
  const DOTNET: CheckSpec = { id: 'dotnet', label: 'dotnet build', on: ['**/*.cs'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['dotnet', 'build', '-p:ErrorLog={output}%2Cversion=2.1'] }
  const GCC: CheckSpec = {
    id: 'gcc', label: 'gcc', on: ['**/*.c'], analyzer: 'problem-matcher', cost: 'turn', class: 'ci', bin: ['gcc', '-fsyntax-only', '{files}'],
    options: { pattern: '^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<severity>error|warning|note): (?<message>.*)$' },
  }
  const sarif = (results: object[]) => JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 't' } }, results }] })
  const result = (file: string, level: string) => ({ ruleId: 'R', level, message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/' + file }, region: { startLine: 1 } } }] })
  const read = (check: CheckSpec, r: ReturnType<typeof ran>, output: { text: string | null; error: string } | null = null) =>
    readRun(check, r, output, '/repo', ['src/a.py', 'src/a.cs', 'src/a.c'], {}, () => [])
  const brief = (r: ReturnType<typeof readRun>) => [r.error, r.findings.map(f => [f.file, f.rule, f.severity]), r.elsewhere]

  test('the command: ESLint gets its flags and files appended, {files} is replaced in place, {output} inside an item; without {files} it is one run', async () => {
    expect(toolArgv(ESLINT, ['src/a.ts'], '', '/cfg/empty.json')).toEqual(['node', 'node_modules/eslint/bin/eslint.js', '--format', 'json', '--no-warn-ignored', '--suppressions-location', '/cfg/empty.json', 'src/a.ts'])
    expect(toolArgv(RUFF, ['src/a.py', 'src/b.py'], '', '/cfg/empty.json')).toEqual(['ruff', 'check', '--output-format', 'sarif', 'src/a.py', 'src/b.py'])
    expect(toolArgv(DOTNET, [], '/cfg/output/dotnet-abc.sarif', '/cfg/empty.json')).toEqual(['dotnet', 'build', '-p:ErrorLog=/cfg/output/dotnet-abc.sarif%2Cversion=2.1'])
    expect([takesFiles(ESLINT), takesFiles(RUFF), takesFiles(DOTNET)]).toEqual([true, true, false])
    expect([isQuietSkip(['node', 'node_modules/eslint/bin/eslint.js']), isQuietSkip(['node', '--max-old-space-size=4096', 'x.js']), isQuietSkip(['node', '{files}']), isQuietSkip(['gcc', 'src/a.c'])]).toEqual([true, false, false, false])
  })

  test('the output file: one per check, repo and session, the id sanitised so it stays in the folder', async () => {
    const a = outputFile('/cfg/output', { ...DOTNET, id: '../x' }, '/repo', 's1')
    expect(a).toMatch(/^\/cfg\/output\/___x-[0-9a-f]{8}\.sarif$/)
    expect(outputFile('/cfg/output', DOTNET, '/repo', 's1')).not.toBe(outputFile('/cfg/output', DOTNET, '/repo', 's2'))
    expect(outputFile('/cfg/output', DOTNET, '/repo', 's1')).not.toBe(outputFile('/cfg/output', DOTNET, '/other', 's1'))
    expect(hash8('')).toBe('811c9dc5')
  })

  test('a run the lane refused, or output the host cut, is an error with nothing saved, whatever the analyzer', async () => {
    for (const check of [ESLINT, RUFF, GCC]) expect(read(check, ran({ exitCode: -1, stderr: 'timed out after 120 s\n' }))).toEqual({ findings: [], elsewhere: 0, error: 'timed out after 120 s' })
    expect(read(ESLINT, ran({ stdout: '[]', isStdoutTruncated: true })).error).toBe(TRUNCATED)
    expect(read(RUFF, ran({ stdout: sarif([]), isStdoutTruncated: true })).error).toBe(TRUNCATED)
    expect(read(GCC, ran({ stderr: 'x', isStderrTruncated: true })).error).toBe(TRUNCATED)
  })

  test("ESLint's rule is unchanged: 0 or 1 is parsed, anything else is its first stderr line", async () => {
    expect(brief(read(ESLINT, ran({ exitCode: 1, stdout: JSON.stringify([{ filePath: '/repo/src/a.py', messages: [message('no-var', 1)] }]) })))).toEqual(['', [['src/a.py', 'no-var', 'error']], 0])
    expect(read(ESLINT, ran({ exitCode: 2, stderr: '\nOops\n' })).error).toBe('Oops')
    expect(read(ESLINT, ran({ exitCode: 1, stdout: 'not json' })).error).toBe("ESLint's output could not be read")
  })

  test('sarif on stdout: parsed at any exit code; a non-zero exit needs an error among the results, else the cause is reported', async () => {
    expect(brief(read(RUFF, ran({ exitCode: 1, stdout: sarif([result('src/a.py', 'error'), result('src/b.py', 'error')]) })))).toEqual(['', [['src/a.py', 'R', 'error']], 1])
    expect(brief(read(RUFF, ran({ exitCode: 0, stdout: sarif([]) })))).toEqual(['', [], 0])
    expect(read(RUFF, ran({ exitCode: 1, stdout: sarif([result('src/a.py', 'warning')]), stderr: 'ruff: too many warnings' })).error).toBe('ruff: too many warnings')
    expect(read(RUFF, ran({ exitCode: 1, stdout: sarif([]) })).error).toBe('it exited with 1')
    expect(read(RUFF, ran({ exitCode: 0, stdout: '' })).error).toBe("its output isn't SARIF 2.1.0")
    expect(read(RUFF, ran({ exitCode: 2, stdout: 'error: no such option --output-format' })).error).toBe('error: no such option --output-format')
    expect(read(RUFF, ran({ exitCode: 2, stdout: 'usage: ruff', stderr: '' })).error).toBe("its output isn't SARIF 2.1.0")
  })

  test('sarif from a file: an unreadable, empty or 1.0 file after exit 0 says so; after a failure the cause comes first', async () => {
    const log = { text: sarif([result('src/a.cs', 'error')]), error: '' }
    expect(brief(read(DOTNET, ran({ exitCode: 1 }), log))).toEqual(['', [['src/a.cs', 'R', 'error']], 0])
    expect(read(DOTNET, ran({ exitCode: 0 }), { text: '', error: '' }).error).toBe(NO_SARIF_FILE)
    expect(read(DOTNET, ran({ exitCode: 0 }), { text: null, error: '' }).error).toBe(NO_SARIF_FILE)
    expect(read(DOTNET, ran({ exitCode: 0 }), { text: JSON.stringify({ version: '1.0.0', runs: [] }), error: '' }).error).toBe(NO_SARIF_FILE)
    expect(read(DOTNET, ran({ exitCode: 1, stdout: 'MSBUILD : error MSB1009: Project file does not exist.' }), { text: '', error: '' }).error).toBe('MSBUILD : error MSB1009: Project file does not exist.')
    expect(read(DOTNET, ran({ exitCode: 1, stdout: 'Build FAILED.' }), { text: '', error: '' }).error).toBe('it exited with 1')
    expect(read(DOTNET, ran({ exitCode: 0 }), { text: null, error: SARIF_FILE_TOO_BIG }).error).toBe(SARIF_FILE_TOO_BIG)
  })

  test('problem-matcher: stdout and stderr together; a non-zero exit needs an error among the lines; the line cap is an error', async () => {
    expect(brief(read(GCC, ran({ exitCode: 1, stderr: 'src/a.c:1:1: error: boom\nsrc/b.c:2:2: warning: w\n' })))).toEqual(['', [['src/a.c', 'gcc', 'error']], 1])
    expect(brief(read(GCC, ran({ exitCode: 0, stdout: 'src/a.c:1:1: note: n\n' })))).toEqual(['', [['src/a.c', 'gcc', 'info']], 0])
    expect(read(GCC, ran({ exitCode: 1, stderr: "gcc: error: unrecognized command-line option '-fno-such'" })).error).toBe("gcc: error: unrecognized command-line option '-fno-such'")
    expect(read(GCC, ran({ exitCode: 1, stderr: 'src/a.c:1:1: warning: w' })).error).toBe('src/a.c:1:1: warning: w')
    expect(read(GCC, ran({ exitCode: 0 }))).toEqual({ findings: [], elsewhere: 0, error: '' })
    expect(read(GCC, ran({ exitCode: 1, stdout: Array.from({ length: 20_001 }, () => 'src/a.c:1:1: error: e').join('\n') })).error).toBe(TOO_MANY_LINES)
  })
})

test('the note for the model lists what fails CI and the project rules, never information', async () => {
  const [over] = sizeFindings(SIZE, 'src/a.ts', lines(11), {})
  const [near] = sizeFindings(SIZE, 'src/b.ts', lines(9), {})
  const advise = { ...over!, id: 'x', class: 'advise' as const, ciWouldFail: false, file: 'src/c.ts', rule: 'design', message: 'use <Button>' }
  const note = noteFor([over!, near!, advise], 'edit')
  expect(note).toMatch(/^CCInformer: /)
  expect(note).toContain('- src/a.ts max-lines: 11 lines, over the limit of 10 [CI will fail]')
  expect(note).toContain('- src/c.ts design: use <Button> [project rule]')
  expect(note).not.toContain('src/b.ts')
  expect(noteFor([near!], 'turn')).toBe('')
})

describe('regex-lines', () => {
  const RAW_BUTTON: CheckSpec = {
    id: 'raw-button',
    label: 'Raw <button>',
    on: ['src/**/*.tsx'],
    ignore: ['src/ui/**'],
    analyzer: 'regex-lines',
    cost: 'edit',
    class: 'advise',
    options: { pattern: '<button\\b', message: 'use <Button> from the design system' },
  }
  const RAW_INPUT: CheckSpec = {
    ...RAW_BUTTON,
    id: 'raw-input',
    label: 'Raw <input>',
    class: 'ci',
    rules: ['no-restricted-syntax'],
    options: { pattern: '<input\\b' },
    suppressions: 'eslint-suppressions.json',
  }
  const PAGE = ['<div>', '  <button onClick={go}>Go</button>', '  <input value={v} />', '  <Button>ok</Button>', '  <button type="submit" />'].join('\n')

  test('each matching line is a finding: a project rule for advise, an error CI fails on for ci', async () => {
    expect(regexFindings(RAW_BUTTON, 'src/page.tsx', PAGE, {}).map(f => [f.line, f.rule, f.severity, f.ciWouldFail, f.message])).toEqual([
      [2, 'raw-button', 'warn', false, 'use <Button> from the design system'],
      [5, 'raw-button', 'warn', false, 'use <Button> from the design system'],
    ])
    // A ci check files its findings under the ESLint rule it stands for; with no message, it names its pattern.
    expect(regexFindings(RAW_INPUT, 'src/page.tsx', PAGE, {}).map(f => [f.line, f.rule, f.severity, f.ciWouldFail, f.message])).toEqual([
      [3, 'no-restricted-syntax', 'error', true, 'matches /<input\\b/'],
    ])
    // An ignored file isn't covered; no pattern finds nothing.
    expect(covers(RAW_BUTTON, 'src/ui/button.tsx')).toBe(false)
    expect(regexFindings({ ...RAW_BUTTON, options: {} }, 'src/page.tsx', PAGE, {})).toEqual([])
    const note = noteFor([...regexFindings(RAW_BUTTON, 'src/page.tsx', PAGE, {}), ...regexFindings(RAW_INPUT, 'src/page.tsx', PAGE, {})], 'edit')
    expect(note).toContain('- src/page.tsx:2 raw-button: use <Button> from the design system [project rule]')
    expect(note).toContain('- src/page.tsx:3 no-restricted-syntax: matches /<input\\b/ [CI will fail]')
  })

  test('a long line is tested on its first characters, in a script and in any other file', async () => {
    const minified = 'x'.repeat(MAX_LINE_CHARS) + '<button>'
    const early = '<button>' + 'x'.repeat(MAX_LINE_CHARS)
    for (const file of ['src/app.min.js', 'src/page.html']) {
      const check = { ...RAW_BUTTON, on: ['src/**'] }
      expect(regexFindings(check, file, [minified, early].join('\n'), {}).map(f => f.line)).toEqual([2])
    }
  })

  test("the repo's suppressions for the rule it stands for: matches it covers read as information", async () => {
    const covered = regexFindings(RAW_INPUT, 'src/page.tsx', PAGE, { 'src/page.tsx': { 'no-restricted-syntax': { count: 2 } } })
    expect(covered.map(f => [f.severity, f.ciWouldFail, f.message])).toEqual([['info', false, "matches /<input\\b/ (suppressed: don't add more)"]])
    // Two matches against a count of one: both are reported, as ESLint would.
    const over = regexFindings(RAW_INPUT, 'src/b.tsx', PAGE + '\n<input />', { 'src/b.tsx': { 'no-restricted-syntax': { count: 1 } } })
    expect(over.map(f => [f.line, f.severity])).toEqual([
      [3, 'error'],
      [6, 'error'],
    ])
    // A check with no rule of its own ignores suppressions.
    expect(regexFindings(RAW_BUTTON, 'src/page.tsx', PAGE, { 'src/page.tsx': { 'raw-button': { count: 5 } } })[0]?.severity).toBe('warn')
  })

  test("JS and TS are read as ESLint's selectors see them: comments and regexes left out, template strings placed where ESLint reports them", async () => {
    const probe = [
      '// A comment naming bg-gray-100 and <button> is not code.',
      '/* A block comment: text-gray-500,',
      '   rounded-[4px] */',
      "export const link = 'https://example.com/path' + ' bg-red-500'",
      "const re = /'bg-blue-500'/",
      'export function Probe({ on }: { on: boolean }) {',
      '  const cls = `p-2',
      '    bg-slate-200',
      "    ${on ? 'x' : 'y'} mt-1",
      '    rounded-[2px]`',
      '  return (',
      '    <div className={cls}>',
      '      {/* <button> in a JSX comment: text-gray-400 */}',
      '      <span className="text-zinc-700" />',
      '    </div>',
      '  )',
      '}',
    ].join('\n')
    const lines = (pattern: string, file: string) => regexFindings({ ...RAW_BUTTON, options: { pattern } }, file, probe, {}).map(f => f.line)
    // What ESLint itself reports for this file (no-restricted-syntax on string literals and template elements): the
    // string after a URL (4), the template string from its backtick (7) and from the `}` closing its `${...}` (9), and
    // the JSX attribute (14). Nothing in a comment or a regex literal.
    expect(lines('(bg|text)-(gray|red|blue|slate|zinc)-[0-9]', 'src/probe.tsx')).toEqual([4, 7, 14])
    expect(lines('rounded-\\[', 'src/probe.tsx')).toEqual([9])
    expect(lines('<button\\b', 'src/probe.tsx')).toEqual([])
    // Any other file is matched line by line as it is.
    expect(lines('(bg|text)-(gray|red|blue|slate|zinc)-[0-9]', 'notes.md')).toEqual([1, 2, 4, 5, 8, 13, 14])
  })

  test("a turn finding an inline one already reports is dropped, but never a CI failure the inline one doesn't report", async () => {
    const inline = regexFindings(RAW_INPUT, 'src/page.tsx', PAGE, {})
    const turn = eslintFindings(
      ESLINT,
      JSON.stringify([{ filePath: '/repo/src/page.tsx', messages: [message('no-restricted-syntax', 3), message('no-restricted-syntax', 9), message('no-console', 3)] }]),
      '/repo',
      {},
      () => [],
    ).findings
    // Line 3's no-restricted-syntax is the inline one's; line 9 (another selector) and no-console stay.
    expect(withoutInline(turn, inline).map(f => [f.line, f.rule])).toEqual([
      [9, 'no-restricted-syntax'],
      [3, 'no-console'],
    ])
    // Inline reads suppressed (a partial count) while ESLint's full count fails CI: ESLint's error stays.
    const suppressed = regexFindings(RAW_INPUT, 'src/page.tsx', PAGE, { 'src/page.tsx': { 'no-restricted-syntax': { count: 1 } } })
    expect(withoutInline(turn, suppressed).map(f => [f.line, f.rule])).toEqual([
      [3, 'no-restricted-syntax'],
      [9, 'no-restricted-syntax'],
      [3, 'no-console'],
    ])
  })
})
