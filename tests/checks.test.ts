import { describe, expect, test } from 'claude-code/testing'

import { countLines, covers, eslintFindings, noteFor, ownedRules, regexFindings, sizeFindings, withoutInline } from '../hooks/checks/findings'
import { matchesGlob, repoPath } from '../hooks/checks/glob'
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
