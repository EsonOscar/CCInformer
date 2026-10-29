import type { Finding } from '../../types'
import type { CheckSpec } from '../packs/types'
import { matchesGlob, repoPath } from './glob'
import { isScript, scriptSource } from './source'
import { suppress } from './suppressions'
import type { Suppressions } from './suppressions'

// A size check warns from this share of its limit up.
export const NEAR_SHARE = 0.9
// The most findings one message to the model lists; the rest are counted.
const MAX_LISTED = 30
// ESLint, when a check names no command of its own: run with node, never through the npm shims.
export const ESLINT_BIN = ['node', 'node_modules/eslint/bin/eslint.js']

// Whether a check looks at a file: one of its globs takes it and none of its ignores does.
export const covers = (check: CheckSpec, file: string): boolean => matchesGlob(check.on, file) && !matchesGlob(check.ignore ?? [], file)

// The ESLint rules an inline check reports for the files it covers, so the turn's ESLint run leaves them out.
export const ownedRules = (check: CheckSpec): string[] => (check.analyzer === 'size-lines' ? [check.rules?.[0] ?? 'max-lines'] : [])

// Lines as ESLint's max-lines counts them with no options: every line, without the empty one after a final newline.
export const countLines = (text: string): number => {
  const lines = text.split(/\r\n|\r|\n/)
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

const finding = (check: CheckSpec, f: Omit<Finding, 'id' | 'check' | 'class'>): Finding => ({
  ...f,
  id: [check.id, f.file, f.rule, f.line, f.message].join('|'),
  check: check.id,
  class: check.class,
})

const unusedFinding = (check: CheckSpec, file: string, rule: string, count: number): Finding =>
  finding(check, {
    file,
    line: 0,
    rule,
    severity: 'error',
    message: `unused suppression (${count}): prune it before pushing (eslint --prune-suppressions)`,
    ciWouldFail: check.class === 'ci',
  })

// A size-lines check on a file's text: over its limit is an error, unless the suppressions let the file through,
// when it is information only ("don't grow it"); near the limit is information too. `options.max` is the limit,
// and the check's first rule (max-lines by default) is the one its suppressions are filed under.
export const sizeFindings = (check: CheckSpec, file: string, text: string, suppressions: Suppressions): Finding[] => {
  const max = Number(check.options?.max)
  if (!(max > 0)) return []
  const rule = check.rules?.[0] ?? 'max-lines'
  const lines = countLines(text)
  const isOver = lines > max
  const { suppressed, unused } = suppress(suppressions[file], { [rule]: isOver ? 1 : 0 }, [rule])
  const out: Finding[] = unused.map(u => unusedFinding(check, file, u.rule, u.count))
  if (isOver && suppressed.includes(rule))
    out.push(finding(check, { file, line: 0, rule, severity: 'info', message: `${lines} lines, over the limit of ${max} but suppressed: don't grow it`, ciWouldFail: false }))
  else if (isOver)
    out.push(finding(check, { file, line: 0, rule, severity: 'error', message: `${lines} lines, over the limit of ${max}`, ciWouldFail: check.class === 'ci' }))
  else if (lines >= Math.ceil(max * NEAR_SHARE))
    out.push(finding(check, { file, line: 0, rule, severity: 'info', message: `${lines} lines, near the limit of ${max}`, ciWouldFail: false }))
  return out
}

// A regex-lines check on a file's text: each line matching `options.pattern` is a finding, an error CI fails on for a
// `ci` check and a warning (a project rule) for an `advise` one. Its rule is the ESLint rule it stands for (`rules[0]`),
// else its own id. When the repo's suppressions for that rule let the file's matches through, they are information
// only ("don't add more"). Its count is only part of the rule's, so it never calls a suppression unused. JS and TS
// files are read without their comments, and a match in a template string goes on the line ESLint reports it on.
export const regexFindings = (check: CheckSpec, file: string, text: string, suppressions: Suppressions): Finding[] => {
  const pattern = typeof check.options?.pattern === 'string' ? check.options.pattern : ''
  if (!pattern) return []
  const rule = check.rules?.[0] ?? check.id
  const message = typeof check.options?.message === 'string' && check.options.message ? check.options.message : `matches /${pattern}/`
  const lines = isScript(file) ? scriptLines(new RegExp(pattern, 'g'), text) : plainLines(new RegExp(pattern), text)
  const isSuppressed = !!check.rules?.[0] && lines.length > 0 && suppress(suppressions[file], { [rule]: lines.length }, [rule]).suppressed.includes(rule)
  return lines.map(line =>
    isSuppressed
      ? finding(check, { file, line, rule, severity: 'info', message: `${message} (suppressed: don't add more)`, ciWouldFail: false })
      : finding(check, { file, line, rule, severity: check.class === 'ci' ? 'error' : 'warn', message, ciWouldFail: check.class === 'ci' }),
  )
}

// The lines with a match, in order.
const plainLines = (re: RegExp, text: string): number[] =>
  text.split(/\r\n|\r|\n/).flatMap((line, i) => (re.test(line) ? [i + 1] : []))

// The lines a script's matches are reported on, each once, in order: every match in the comment-free text, on the line
// `scriptSource` places it.
const scriptLines = (re: RegExp, text: string): number[] => {
  const { code, lineOf } = scriptSource(text)
  const lines = new Set<number>()
  let offset = 0
  for (const line of code.split('\n')) {
    re.lastIndex = 0
    for (let m = re.exec(line); m; m = re.exec(line)) {
      lines.add(lineOf[offset + m.index] ?? 1)
      if (m[0] === '') re.lastIndex += 1
    }
    offset += line.length + 1
  }
  return [...lines].sort((a, b) => a - b)
}

// A turn check's findings without the ones an inline check already reports: same file, line and rule, where the inline
// one says no less (it would fail CI, or the turn's wouldn't). A turn finding that would fail CI is never dropped for
// an inline one that doesn't.
export const withoutInline = (turn: Finding[], inline: Finding[]): Finding[] =>
  turn.filter(t => !inline.some(i => i.file === t.file && i.line === t.line && i.rule === t.rule && (i.ciWouldFail || !t.ciWouldFail)))

type EslintMessage = { ruleId: string | null; severity: number; message: string; line?: number }
type EslintResult = { filePath: string; messages: EslintMessage[] }

// What ESLint's JSON says about each file it ran on, with the repo's suppressions applied as ESLint applies them (it
// ran with an empty suppressions file, so its output is raw). `owned` gives a file's rules that an inline check
// reports instead, which are left out here. `files` are the files it checked; `error` is set when the output can't
// be read.
export const eslintFindings = (
  check: CheckSpec,
  stdout: string,
  root: string,
  suppressions: Suppressions,
  owned: (file: string) => string[],
): { findings: Finding[]; files: string[]; error: string } => {
  let results: EslintResult[]
  try {
    results = JSON.parse(stdout) as EslintResult[]
    if (!Array.isArray(results)) throw new Error()
  } catch {
    return { findings: [], files: [], error: "ESLint's output could not be read" }
  }
  const findings: Finding[] = []
  const files: string[] = []
  for (const result of results) {
    const file = repoPath(root, result.filePath)
    if (!file) continue
    files.push(file)
    const skip = owned(file)
    const messages = result.messages.filter(m => !m.ruleId || !skip.includes(m.ruleId))
    const counts: Record<string, number> = {}
    for (const m of messages) if (m.ruleId) counts[m.ruleId] = (counts[m.ruleId] ?? 0) + 1
    const evaluated = Object.keys(suppressions[file] ?? {}).filter(r => !skip.includes(r))
    const { suppressed, unused } = suppress(suppressions[file], counts, evaluated)
    for (const m of messages) {
      if (m.ruleId && suppressed.includes(m.ruleId)) continue
      // A message with no rule is a file ESLint couldn't parse.
      const severity = m.severity === 2 || !m.ruleId ? 'error' : 'warn'
      findings.push(finding(check, { file, line: m.line ?? 0, rule: m.ruleId ?? 'parse', severity, message: m.message, ciWouldFail: check.class === 'ci' && severity === 'error' }))
    }
    for (const u of unused) findings.push(unusedFinding(check, file, u.rule, u.count))
  }
  return { findings, files, error: '' }
}

// The findings the model is told about: those that would fail CI, and the project's own rules.
export const isTold = (f: Finding): boolean => f.ciWouldFail || (f.class === 'advise' && f.severity !== 'info')

// The note the model reads after a write, or with the next prompt for a turn's checks.
export const noteFor = (findings: Finding[], when: 'edit' | 'turn'): string => {
  const told = findings.filter(isTold)
  if (!told.length) return ''
  const head =
    when === 'edit'
      ? 'CCInformer: the repo\'s checks found this in the file just written. "CI will fail" means its CI enforces the rule; fix it before pushing.'
      : 'CCInformer: the repo\'s checks, run on the files changed in the last turn, found this. "CI will fail" means its CI enforces the rule; fix it before pushing.'
  const lines = told.slice(0, MAX_LISTED).map(f => `- ${f.file}${f.line ? ':' + f.line : ''} ${f.rule}: ${f.message} [${f.ciWouldFail ? 'CI will fail' : 'project rule'}]`)
  const more = told.length > MAX_LISTED ? [`- and ${told.length - MAX_LISTED} more (CCInformer's Code › Rules lists them all)`] : []
  return [head, ...lines, ...more].join('\n')
}
