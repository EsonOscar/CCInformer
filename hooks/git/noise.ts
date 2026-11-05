import type { FileChange } from '../../types'
import { matchesGlob } from '../checks/glob'
import type { NoiseRule } from '../packs/types'

// A pack's noise rules, as plain logic: which changed files are generated output or only an editor's rewrite (ids and
// counters it renumbers on save), so Code › Git can fold them and the CI hand-off can leave them out. A rule never
// hides a finding: the checks follow their own globs.

// One file's part of a unified diff: its path, its hunks (their -, + and context lines), the section's own text, and
// whether it arrived whole (a diff the host cut at 4 MiB ends in a partial one). `path` is '' when its header was cut.
export type DiffSection = { path: string; hunks: string[][]; text: string; isComplete: boolean }

// The most rewrite candidates one diff reads; past it, files show as ordinary changes.
export const MAX_REWRITE_FILES = 100

// A path as a diff header writes it: one trailing tab (git adds it after a path with a space) and C-quoting undone.
const headerPath = (raw: string): string => {
  const p = raw.replace(/\t$/, '')
  if (!(p.startsWith('"') && p.endsWith('"'))) return p
  return p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t')
}
const strip = (p: string, prefix: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)

// `diff --git a/X b/X`: the path, when both halves agree (a binary or mode-only section has no ---/+++ lines).
const gitHeaderPath = (line: string): string => {
  const rest = line.slice('diff --git '.length)
  const len = (rest.length - 5) / 2
  if (!Number.isInteger(len) || len < 1) return ''
  const path = rest.slice(2, 2 + len)
  return rest === `a/${path} b/${path}` ? path : ''
}

export const diffSections = (diff: string, isTruncated: boolean): DiffSection[] => {
  const sections: DiffSection[] = []
  const lines = diff.split('\n')
  let current: { lines: string[]; oldPath: string; newPath: string; gitPath: string; hunks: string[][] } | null = null
  const close = () => {
    if (!current) return
    const path = current.newPath && current.newPath !== '/dev/null' ? current.newPath : current.oldPath !== '/dev/null' ? current.oldPath : ''
    sections.push({ path: path || current.gitPath, hunks: current.hunks, text: current.lines.join('\n'), isComplete: true })
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      close()
      current = { lines: [line], oldPath: '', newPath: '', gitPath: gitHeaderPath(line), hunks: [] }
      continue
    }
    if (!current) continue
    current.lines.push(line)
    const hunk = current.hunks[current.hunks.length - 1]
    if (!current.hunks.length && line.startsWith('--- ')) current.oldPath = strip(headerPath(line.slice(4)), 'a/')
    else if (!current.hunks.length && line.startsWith('+++ ')) current.newPath = strip(headerPath(line.slice(4)), 'b/')
    else if (line.startsWith('@@')) current.hunks.push([])
    else if (hunk && /^[-+ ]/.test(line)) hunk.push(line)
  }
  close()
  if (isTruncated && sections.length) sections[sections.length - 1]!.isComplete = false
  return sections
}

// The generated rule a path falls under, if any.
export const generatedRule = (rules: NoiseRule[], path: string): NoiseRule | undefined =>
  rules.find(r => r.kind === 'generated' && matchesGlob([r.glob], path))

// The editor-rewrite rule a path falls under, if any.
export const rewriteRule = (rules: NoiseRule[], path: string): NoiseRule | undefined =>
  rules.find(r => r.kind === 'editor-rewrite' && matchesGlob([r.glob], path))

// A line once the rule's patterns are taken out: runs of spaces and tabs as one, no space before `]` or at either end,
// so `uid="[^"]*"` written without its leading space still leaves `[gd_scene format=3]` as it was.
const normalized = (line: string, patterns: RegExp[]): string =>
  patterns
    .reduce((l, re) => l.replace(re, ''), line.replace(/\r$/, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/ \]/g, ']')
    .trim()

// Whether every hunk's removed and added lines are the same once normalized, in order. A section with no hunks
// (binary, a mode change) is never a rewrite, and neither is a block moved from one hunk to another.
export const isRewriteOnly = (hunks: string[][], normalize: string[]): boolean => {
  if (!hunks.length) return false
  const patterns = normalize.map(n => new RegExp(n, 'g'))
  return hunks.every(hunk => {
    const side = (mark: string) => hunk.filter(l => l.startsWith(mark)).map(l => normalized(l.slice(1), patterns)).filter(Boolean)
    const removed = side('-')
    const added = side('+')
    return removed.length === added.length && removed.every((l, i) => l === added[i])
  })
}

// A conflict is never folded, whatever the rule: it has to be resolved.
const isConflict = (code: string) => code.includes('U') || code === 'AA' || code === 'DD'

// The changed files whose diff decides whether they're only an editor's rewrite: modified (staged, unstaged or
// both), under an editor-rewrite rule and no generated one. Added, deleted, renamed and conflicted files never are.
export const rewriteCandidates = (files: FileChange[], rules: NoiseRule[]): string[] =>
  files
    .filter(f => /^[ M]{2}$/.test(f.code) && f.code !== '  ' && !generatedRule(rules, f.path) && rewriteRule(rules, f.path))
    .map(f => f.path)
    .slice(0, MAX_REWRITE_FILES)

// The changed files with their noise kind: generated by path, an editor rewrite by the verdicts of the diff.
export const markNoise = (files: FileChange[], rules: NoiseRule[], verdicts: Record<string, boolean>): FileChange[] =>
  files.map(f => {
    if (isConflict(f.code)) return f
    if (generatedRule(rules, f.path)) return { ...f, noise: 'generated' }
    return verdicts[f.path] ? { ...f, noise: 'editor-rewrite' } : f
  })

// The verdict for each section of a -U0 diff of the candidates: true only for a whole section under an editor-rewrite
// rule whose hunks are all rewrites.
export const rewriteVerdicts = (diff: string, isTruncated: boolean, rules: NoiseRule[]): Record<string, boolean> => {
  const verdicts: Record<string, boolean> = {}
  for (const s of diffSections(diff, isTruncated)) {
    const rule = s.path ? rewriteRule(rules, s.path) : undefined
    if (s.path) verdicts[s.path] = !!rule && s.isComplete && isRewriteOnly(s.hunks, rule.normalize ?? [])
  }
  return verdicts
}
