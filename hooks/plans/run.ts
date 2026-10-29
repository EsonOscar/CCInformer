import type { EngineInterface } from 'claude-code'

import type { PackReport, PlanFile, PlansState } from '../../types'
import { matchesGlob } from '../checks/glob'
import type { Lane } from '../core/lanes'
import type { PlanSpec, ResolvedPack } from '../packs/types'
import { readText } from '../read-records'
import { mergedToast, prState, prsToAsk } from './drift'
import { parsePlan } from './parse'

// How deep a `**` glob looks for plan files.
const MAX_DEPTH = 6
// Where the plan-feature skill saves the plan it builds from: read in every repo, beside what the pack names, with
// its archive folder left out.
export const PLANS_GLOB = '.local/plans/*.md'
const PLANS_ARCHIVE = '.local/plans/archive'
// What a PR reads as when gh couldn't say: known, so the poll doesn't ask again, but not final.
const UNKNOWN = 'UNKNOWN'

// What the plans take from the session: the light lane (for gh), its pack and the report it came with, where their
// state goes (the atom lives in the hooks module), and how to tell the person a PR merged under an open checkpoint.
export type PlanDeps = {
  light: Lane
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  save: (state: PlansState) => Promise<unknown>
  notify: (text: string) => void
}

export type Plans = {
  // Read the pack's plan files again (a file whose modified time hasn't changed keeps its last parse), then ask GitHub
  // about the PRs their open checkpoints name. `isRecheck: false` (the poll) asks only about PRs not asked about yet.
  refresh: (o?: { isRecheck?: boolean }) => Promise<void>
}

// The checkpoint board's data: every plan in `.local/plans/` and every file the pack's plan globs match (outside the
// archive folders), each parsed for the checkpoints it defines. Files that define none aren't listed. A PR's state is
// kept once it is merged or closed, as it stays that way; an open one, or one gh couldn't read, is asked about again on
// the next refresh that rechecks.
export function createPlans($: EngineInterface, deps: PlanDeps): Plans {
  const parsed = new Map<string, { mtime: number; plan: PlanFile }>()
  const prs = new Map<number, string>()
  let isBusy = false
  const merged = () => [...prs].filter(([, state]) => state === 'MERGED').map(([n]) => n)

  // A PR's state, from gh in the repo root; a failed call (gh missing, not a PR, offline) reads as unknown.
  const askPr = async (root: string, n: number) => {
    const ran = await deps.light(['gh', 'pr', 'view', String(n), '--json', 'state'], undefined, root).catch(() => null)
    prs.set(n, (ran?.exitCode === 0 ? prState(ran.stdout) : null) ?? UNKNOWN)
  }

  // The files under `dir` (repo-relative), `depth` folders down.
  const listFiles = async (root: string, dir: string, depth: number): Promise<string[]> => {
    const entries = await $.fs.list(dir ? `${root}/${dir}` : root).catch(() => [])
    const out: string[] = []
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name
      if (e.kind === 'file') out.push(path)
      else if (e.kind === 'dir' && depth > 0) out.push(...(await listFiles(root, path, depth - 1)))
    }
    return out
  }
  // The files a glob matches: listed from its last folder without a wildcard, one level down unless it holds `**`.
  const filesOf = async (root: string, glob: string): Promise<string[]> => {
    const parts = glob.split('/')
    const wild = parts.findIndex(p => /[*?{]/.test(p))
    if (wild < 0) return (await $.fs.exists(`${root}/${glob}`)) ? [glob] : []
    const dir = parts.slice(0, wild).join('/')
    const depth = glob.includes('**') ? MAX_DEPTH : parts.length - wild - 1
    return (await listFiles(root, dir, depth)).filter(f => matchesGlob([glob], f))
  }

  const readPlan = async (root: string, path: string, spec: Pick<PlanSpec, 'checkpoint' | 'done' | 'prRef'>): Promise<PlanFile | null> => {
    const stat = await $.fs.stat(`${root}/${path}`).catch(() => null)
    if (!stat) return null
    const cached = parsed.get(path)
    if (cached && cached.mtime === stat.mtimeMs) return cached.plan
    const { title, checkpoints } = parsePlan(await readText($, `${root}/${path}`), spec)
    const plan = { path, title, checkpoints }
    parsed.set(path, { mtime: stat.mtimeMs, plan })
    return plan
  }

  const refresh = async (isRecheck: boolean) => {
    const pack = await deps.pack()
    const root = deps.report()?.root ?? ''
    const spec = pack?.plans
    const at = await $.clock.now()
    if (!root) return void (await deps.save({ plans: [], merged: [], at, error: '' }))
    const globs = [...new Set([PLANS_GLOB, ...(spec?.globs ?? [])])]
    const archives = [PLANS_ARCHIVE, spec?.archiveDir ?? ''].filter(Boolean).map(a => a.replace(/\/+$/, '') + '/')
    const paths = new Set<string>()
    for (const glob of globs) for (const f of await filesOf(root, glob)) if (!archives.some(a => f.startsWith(a))) paths.add(f)
    const plans: PlanFile[] = []
    for (const path of [...paths].sort()) {
      const plan = await readPlan(root, path, spec ?? {})
      if (plan?.checkpoints.length) plans.push(plan)
    }
    // The board first, with what is known; GitHub's answers follow, so the board never waits on gh.
    await deps.save({ plans, merged: merged(), at, error: '' })
    const ask = prsToAsk(plans, prs, isRecheck)
    if (!ask.length) return
    const before = new Map(prs)
    await Promise.all(ask.map(n => askPr(root, n)))
    await deps.save({ plans, merged: merged(), at, error: '' })
    const toast = mergedToast(plans, before, prs)
    if (toast) deps.notify(toast)
  }

  return {
    // A refresh that comes while one runs is skipped.
    refresh: async o => {
      if (isBusy) return
      isBusy = true
      try {
        await refresh(o?.isRecheck ?? true)
      } finally {
        isBusy = false
      }
    },
  }
}
