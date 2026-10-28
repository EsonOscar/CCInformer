import type { Finding } from '../../types'
import type { CheckSpec } from '../packs/types'
import { matchesGlob, repoPath } from './glob'
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
