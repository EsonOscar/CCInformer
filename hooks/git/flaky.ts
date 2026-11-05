import type { CiSnapshot } from '../../types'
import { parseJson } from '../parse'

// Likely-flaky checks, as plain logic: which jobs lately failed in one attempt of a run and passed in a later attempt
// of the same run, so a failed PR check of such a job is marked in the CI row, the toasts and the hand-off. A mark is
// display only: nothing that decides a ping, a hand-off or a claim reads it.

// How far back reruns count, and how many rerun runs are read.
export const FLAKY_DAYS = 7
export const FLAKY_RUNS_READ = 10

// A run that was rerun: its id, the commit it ran on, and its link (where its repo and host are read from).
export type Rerun = { id: string; head: string; url: string }
// `workflow/job` → each rerun run the job flaked in.
export type FlakyIndex = Record<string, { id: string; head: string }[]>

const DAY_MS = 86_400_000
const FAILED = ['failure', 'timed_out']

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// `gh run list --json databaseId,attempt,headSha,createdAt,url`: the runs rerun at least once, created within `days`
// of `now`, newest first, at most `max`.
export const rerunRuns = (text: string, now: number, days = FLAKY_DAYS, max = FLAKY_RUNS_READ): Rerun[] => {
  const list = parseJson(text)
  if (!Array.isArray(list)) return []
  return (list as Record<string, unknown>[])
    .filter(r => Number(r.attempt) > 1 && Date.parse(str(r.createdAt)) >= now - days * DAY_MS)
    .sort((a, b) => Date.parse(str(b.createdAt)) - Date.parse(str(a.createdAt)))
    .slice(0, max)
    .map(r => ({ id: String(r.databaseId ?? ''), head: str(r.headSha), url: str(r.url) }))
}

// `gh api …/runs/<id>/jobs?filter=all` (every attempt's jobs): `workflow/name` of each job that ended in failure or a
// timeout in one attempt and in success in a later one.
export const flakedJobs = (text: string): string[] => {
  const jobs = (parseJson(text) as { jobs?: unknown } | undefined)?.jobs
  if (!Array.isArray(jobs)) return []
  const byKey = new Map<string, { attempt: number; conclusion: string }[]>()
  for (const j of jobs as Record<string, unknown>[]) {
    const key = `${str(j.workflow_name)}/${str(j.name)}`
    byKey.set(key, [...(byKey.get(key) ?? []), { attempt: Number(j.run_attempt) || 0, conclusion: str(j.conclusion) }])
  }
  return [...byKey]
    .filter(([, tries]) => tries.some(f => FAILED.includes(f.conclusion) && tries.some(p => p.conclusion === 'success' && p.attempt > f.attempt)))
    .map(([key]) => key)
}

// The index with one run's flaked jobs added.
export const addRun = (index: FlakyIndex, run: Rerun, keys: string[]): FlakyIndex => {
  const next = { ...index }
  for (const key of keys) {
    const runs = next[key] ?? []
    if (!runs.some(r => r.id === run.id)) next[key] = [...runs, { id: run.id, head: run.head }]
  }
  return next
}

// The snapshot with each failed PR check's `flaky`: the distinct runs in the index for its job whose commit isn't this
// snapshot's, set only when above 0. Unmarked checks stay the same objects, and with nothing marked (or a branch's
// runs, which aren't jobs) the snapshot itself comes back, so `marked !== ci` says whether anything changed.
export const markFlaky = (ci: CiSnapshot, index: FlakyIndex): CiSnapshot => {
  if (ci.source !== 'pr') return ci
  let isChanged = false
  const checks = ci.checks.map(c => {
    if (c.bucket !== 'fail') return c
    const runs = new Set((index[`${c.workflow}/${c.name}`] ?? []).filter(r => r.head !== ci.head).map(r => r.id))
    if (!runs.size || c.flaky === runs.size) return c
    isChanged = true
    return { ...c, flaky: runs.size }
  })
  return isChanged ? { ...ci, checks } : ci
}
