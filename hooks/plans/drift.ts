import type { PlanCheckpoint, PlanFile } from '../../types'

// Where a plan and GitHub disagree. The board keeps the status the plan gives; this only says what to warn about.

// A PR in one of these states stays there, so its answer is kept for the session.
const FINAL = new Set(['MERGED', 'CLOSED'])
const isOpen = (c: PlanCheckpoint) => c.status === 'open' || c.status === 'partly'

// The PRs worth asking GitHub about: those named on a checkpoint that still reads open, whose state isn't final yet;
// with `isRecheck` off (the board's poll), only those not asked about before.
export const prsToAsk = (plans: PlanFile[], known: Map<number, string>, isRecheck = true): number[] =>
  [...new Set(plans.flatMap(p => p.checkpoints.filter(isOpen).flatMap(c => c.prs)))]
    .filter(n => (isRecheck ? !FINAL.has(known.get(n) ?? '') : !known.has(n)))
    .sort((a, b) => a - b)

// The checkpoint's PRs that merged while its line still reads open; none for a done or dropped one.
export const mergedPrs = (c: PlanCheckpoint, merged: ReadonlySet<number>): number[] => (isOpen(c) ? c.prs.filter(n => merged.has(n)) : [])

// Every merged PR on a checkpoint that still reads open, with where it is: what Work's badge and the toast are about.
export const mergedWarnings = (plans: PlanFile[], merged: ReadonlySet<number>): { pr: number; id: string; path: string }[] =>
  plans.flatMap(p => p.checkpoints.flatMap(c => mergedPrs(c, merged).map(pr => ({ pr, id: c.id, path: p.path }))))

// The toast for PRs this session saw turn from open to merged while a checkpoint naming them still reads open; null
// when none did. A PR already merged when first asked about raises only the badge.
export const mergedToast = (plans: PlanFile[], before: ReadonlyMap<number, string>, after: ReadonlyMap<number, string>): string | null => {
  const turned = new Set([...after].filter(([n, state]) => state === 'MERGED' && before.get(n) === 'OPEN').map(([n]) => n))
  const warned = mergedWarnings(plans, turned).filter((w, i, all) => all.findIndex(o => o.pr === w.pr) === i)
  if (!warned.length) return null
  const [first] = warned
  return warned.length === 1
    ? `PR #${first!.pr} merged, but ${first!.id} in ${first!.path.split('/').pop()} still reads open`
    : `${warned.length} PRs merged while their checkpoints still read open: see Work › Plans`
}

// Every checkpoint done or dropped: the plan is ready to archive.
export const isFinished = (plan: PlanFile): boolean => plan.checkpoints.length > 0 && plan.checkpoints.every(c => !isOpen(c))

// The state `gh pr view --json state` printed ('OPEN', 'MERGED', 'CLOSED'), or null when it printed something else.
export const prState = (stdout: string): string | null => {
  try {
    const state: unknown = (JSON.parse(stdout) as { state?: unknown }).state
    return typeof state === 'string' && state ? state : null
  } catch {
    return null
  }
}
