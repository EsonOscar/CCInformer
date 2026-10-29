import type { BudgetReading } from '../../types'
import type { BudgetSpec, Source } from '../packs/types'

// The number a JSON pointer (`/start/brotli`) leads to in a file's text, or null.
export const atPointer = (text: string, pointer: string): number | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  for (const part of pointer.split('/').slice(1)) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// A source's number in a command's output or a log: the parse regex's first group, times `scale` (1024 for KB).
export const parseValue = (text: string, parse: string, scale = 1): number | null => {
  let match: RegExpMatchArray | null
  try {
    match = text.match(new RegExp(parse))
  } catch {
    return null
  }
  const n = match?.[1] === undefined ? NaN : parseFloat(match[1])
  return Number.isFinite(n) ? n * scale : null
}

// A budget's limit: a number, or a share of a baseline the pack points at (`relative: 1.05` is 5 % over it). The
// baseline is read by the caller and handed in.
export const limitOf = (spec: BudgetSpec, baseline: number | null): { limit: number | null; baseline: number | null } =>
  typeof spec.limit === 'number' ? { limit: spec.limit, baseline: null } : { limit: baseline === null ? null : baseline * spec.limit.relative, baseline }

// A reading is fresh when the build it measured is newer than both HEAD's commit and Claude's last file write.
export const isFresh = (builtAt: number, headAt: number, lastWriteAt: number): boolean => builtAt >= headAt && builtAt >= lastWriteAt

// What a source gave: a number, and whether it measured what's in the tree now ('' when it did); or why there is none.
export type SourceResult = { kind: Source['kind']; value: number | null; staleWhy: string; error: string; at: number }

// The reading a budget shows: the first fresh one in the pack's order, else the first with a number (marked stale),
// else the first source's reason.
export const pickReading = (spec: BudgetSpec, results: SourceResult[], limit: { limit: number | null; baseline: number | null }): BudgetReading => {
  const chosen = results.find(r => r.value !== null && !r.staleWhy) ?? results.find(r => r.value !== null) ?? results[0]
  const value = chosen && chosen.value !== null ? chosen.value : null
  return {
    id: spec.id,
    label: spec.label,
    unit: spec.unit,
    direction: spec.direction,
    value,
    limit: limit.limit,
    baseline: limit.baseline,
    from: chosen && value !== null ? chosen.kind : '',
    at: chosen && value !== null ? chosen.at : 0,
    staleWhy: chosen && value !== null ? chosen.staleWhy : '',
    error: value !== null ? '' : chosen?.error || 'the pack names no source',
  }
}

// Whether a reading breaks its budget.
export const isOver = (r: BudgetReading): boolean =>
  r.value !== null && r.limit !== null && (r.direction === 'max' ? r.value > r.limit : r.value < r.limit)

const KB = 1024
// A value in its unit, as the pane shows it: bytes as KB with one decimal (as a report prints them).
export const shown = (value: number, unit: BudgetReading['unit']): string =>
  unit === 'bytes' ? `${(value / KB).toFixed(1)} KB` : unit === 'ms' ? `${Math.round(value)} ms` : unit === 'mb' ? `${value.toFixed(0)} MB` : String(Math.round(value))

// How a reading stands against its budget, in words. Against a baseline it reads as the repo's own report does:
// "6.0% over the baseline, past the 5% budget".
export const verdict = (r: BudgetReading): string => {
  if (r.value === null || r.limit === null) return ''
  if (r.baseline !== null && r.baseline > 0) {
    const change = (r.value / r.baseline - 1) * 100
    const budget = (r.limit / r.baseline - 1) * 100
    const word = change >= 0 ? 'over' : 'under'
    return `${Math.abs(change).toFixed(1)}% ${word} the baseline, ${isOver(r) ? 'past' : 'within'} the ${Math.abs(budget).toFixed(0)}% budget`
  }
  const share = Math.round((r.value / r.limit) * 100)
  return isOver(r) ? `over the limit of ${shown(r.limit, r.unit)} (${share}%)` : `${share}% of ${shown(r.limit, r.unit)}`
}
