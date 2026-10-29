import type { EngineInterface } from 'claude-code'

import type { PackReport, PlanFile, PlansState } from '../../types'
import { matchesGlob } from '../checks/glob'
import type { PlanSpec, ResolvedPack } from '../packs/types'
import { readText } from '../read-records'
import { parsePlan } from './parse'

// How deep a `**` glob looks for plan files.
const MAX_DEPTH = 6

// What the plans take from the session: its pack and the report it came with, and where their state goes (the atom
// lives in the hooks module).
export type PlanDeps = {
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  save: (state: PlansState) => Promise<unknown>
}

export type Plans = {
  // Read the pack's plan files again; a file whose modified time hasn't changed keeps its last parse.
  refresh: () => Promise<void>
}

// The checkpoint board's data: every file the pack's plan globs match (outside the archive folder), each parsed for
// the checkpoints it defines. Files that define none aren't listed.
export function createPlans($: EngineInterface, deps: PlanDeps): Plans {
  const parsed = new Map<string, { mtime: number; plan: PlanFile }>()

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

  const readPlan = async (root: string, path: string, spec: PlanSpec): Promise<PlanFile | null> => {
    const stat = await $.fs.stat(`${root}/${path}`).catch(() => null)
    if (!stat) return null
    const cached = parsed.get(path)
    if (cached && cached.mtime === stat.mtimeMs) return cached.plan
    const { title, checkpoints } = parsePlan(await readText($, `${root}/${path}`), spec)
    const plan = { path, title, checkpoints }
    parsed.set(path, { mtime: stat.mtimeMs, plan })
    return plan
  }

  return {
    refresh: async () => {
      const pack = await deps.pack()
      const root = deps.report()?.root ?? ''
      const spec = pack?.plans
      const at = await $.clock.now()
      if (!root || !spec?.globs.length) return void (await deps.save({ plans: [], at, error: '' }))
      const archive = spec.archiveDir ? spec.archiveDir.replace(/\/+$/, '') + '/' : ''
      const paths = new Set<string>()
      for (const glob of spec.globs) for (const f of await filesOf(root, glob)) if (!archive || !f.startsWith(archive)) paths.add(f)
      const plans: PlanFile[] = []
      for (const path of [...paths].sort()) {
        const plan = await readPlan(root, path, spec)
        if (plan?.checkpoints.length) plans.push(plan)
      }
      await deps.save({ plans, at, error: '' })
    },
  }
}
