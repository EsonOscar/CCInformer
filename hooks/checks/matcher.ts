import type { CheckSpec } from '../packs/types'
import { MATCHER_SEVERITIES } from '../packs/types'
import type { RawFinding } from './findings'
import { toRepoFile } from './glob'

// A problem matcher, like VS Code's: the check's `options.pattern`, one regex with named groups (file, line,
// message; column, severity, code), tested against each line of a command's output, stdout and stderr together. One
// raw finding per matching line. ANSI colours are stripped first; a line over MAX_LINE_CHARS is tested on its first
// MAX_LINE_CHARS characters (the file:line prefix survives, the message is cut); past MAX_LINES the run is an error,
// as a partial read would save a file as clean. There is no regex timeout in JS: the validator's guards on the
// pattern and these caps are what stands between a pack's pattern and a hung session.
export const MAX_LINE_CHARS = 2000
export const MAX_LINES = 20_000
export const TOO_MANY_LINES = `its output passed ${MAX_LINES} lines; give it fewer files a run`

const ANSI = /\x1b\[[0-9;]*m/g

// The severity words tools write, as whole words, without case; anything else is the check's default.
const WORDS: Record<string, RawFinding['severity']> = {
  error: 'error',
  'fatal error': 'error',
  fatal: 'error',
  warning: 'warn',
  warn: 'warn',
  note: 'info',
  info: 'info',
  information: 'info',
  hint: 'info',
}

export const severityOf = (word: string | undefined, fallback: RawFinding['severity']): RawFinding['severity'] =>
  (word && WORDS[word.trim().toLowerCase()]) || fallback

const defaultSeverity = (check: CheckSpec): RawFinding['severity'] => {
  const s = check.options?.severity
  return typeof s === 'string' && (MATCHER_SEVERITIES as readonly string[]).includes(s) ? (s as RawFinding['severity']) : 'error'
}

const count = (s: string | undefined): number => {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export const matcherResults = (check: CheckSpec, text: string, root: string): { raws: RawFinding[]; error: string } => {
  let regex: RegExp
  try {
    regex = new RegExp(typeof check.options?.pattern === 'string' ? check.options.pattern : '')
  } catch {
    return { raws: [], error: "its pattern doesn't compile" }
  }
  const fallback = defaultSeverity(check)
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines.length > MAX_LINES) return { raws: [], error: TOO_MANY_LINES }
  const raws: RawFinding[] = []
  for (const full of lines) {
    const line = full.replace(ANSI, '').slice(0, MAX_LINE_CHARS)
    const groups = regex.exec(line)?.groups
    if (!groups) continue
    raws.push({
      file: groups.file ? toRepoFile(root, groups.file.trim()) : '',
      line: count(groups.line),
      column: count(groups.column),
      rule: groups.code?.trim() || check.rules?.[0] || check.id,
      severity: severityOf(groups.severity, fallback),
      message: (groups.message ?? '').trim(),
    })
  }
  return { raws, error: '' }
}
