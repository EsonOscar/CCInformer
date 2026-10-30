import type { EngineInterface } from 'claude-code'

import type { PackReport, PlanFile, PlansState } from '../../types'
import type { Lane } from '../core/lanes'
import type { May } from '../core/permissions'
import type { Platform } from '../env/procs'
import type { PlanSpec, ResolvedPack } from '../packs/types'
import { filesOf as globFiles } from '../read-files'
import { readText } from '../read-records'
import { archiveDirFor, archivePath, archiveQuestion, baseOf, isReminderDue, moveOwnLinks, reminderText, removeCommand, rewriteRefs } from './archive'
import { isFinished, mergedToast, prState, prsToAsk } from './drift'
import { parsePlan } from './parse'

// How deep a `**` glob looks for plan files.
const MAX_DEPTH = 6
// Where the plan-feature skill saves the plan it builds from: read in every repo, beside what the pack names, with
// its archive folder left out.
export const PLANS_GLOB = '.local/plans/*.md'
const PLANS_ARCHIVE = '.local/plans/archive'
// What a PR reads as when gh couldn't say: known, so the poll doesn't ask again, but not final.
const UNKNOWN = 'UNKNOWN'
// When the reminder about finished plans last came, per repo, for every session.
const STORE_REMINDED = 'plansReminded:'
// Where the references to an archived plan are looked for, besides its own folder and the memory notes.
const REFS_GLOB = '.local/**/*.md'
const ARCHIVE = 'Archive'

// What the plans take from the session: the light lane (for gh and removing a file), the platform, its pack and the
// report it came with, this project's memory notes folder, where their state goes (the atom lives in the hooks
// module), and how to tell the person something.
export type PlanDeps = {
  light: Lane
  platform: Platform
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  memoryDir: string
  save: (state: PlansState) => Promise<unknown>
  notify: (text: string) => void
  may: May
}

export type Plans = {
  // Read the pack's plan files again (a file whose modified time hasn't changed keeps its last parse), then ask GitHub
  // about the PRs their open checkpoints name. `isRecheck: false` (the poll) asks only about PRs not asked about yet;
  // `isReminder` lets it remind about finished plans, at most once a day per repo.
  refresh: (o?: { isRecheck?: boolean; isReminder?: boolean }) => Promise<void>
  // Move a plan to its archive folder, after asking, and point the references to it there.
  archive: (path: string) => Promise<void>
}

// The checkpoint board's data: every plan in `.local/plans/` and every file the pack's plan globs match (outside the
// archive folders), each parsed for the checkpoints it defines. Files that define none aren't listed. A PR's state is
// kept once it is merged or closed, as it stays that way; an open one, or one gh couldn't read, is asked about again on
// the next refresh that rechecks.
export function createPlans($: EngineInterface, deps: PlanDeps): Plans {
  const parsed = new Map<string, { mtime: number; plan: PlanFile }>()
  const prs = new Map<number, string>()
  let isBusy = false
  let isArchiving = false
  const merged =() => [...prs].filter(([, state]) => state === 'MERGED').map(([n]) => n)

  // A PR's state, from gh in the repo root; a failed call (gh missing, not a PR, offline) reads as unknown.
  const askPr = async (root: string, n: number) => {
    const ran = await deps.light(['gh', 'pr', 'view', String(n), '--json', 'state'], undefined, root).catch(() => null)
    prs.set(n, (ran?.exitCode === 0 ? prState(ran.stdout) : null) ?? UNKNOWN)
  }

  const filesOf = (root: string, glob: string) => globFiles($, root, glob, MAX_DEPTH)

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

  const refresh = async (isRecheck: boolean, isReminder: boolean) => {
    const pack = await deps.pack()
    const report = deps.report()
    const root = report?.root ?? ''
    const spec = pack?.plans
    const at = await $.clock.now()
    if (!root) return void (await deps.save({ plans: [], merged: [], archiveDir: '', at, error: '' }))
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
    await deps.save({ plans, merged: merged(), archiveDir: spec?.archiveDir ?? '', at, error: '' })
    const finished = plans.filter(isFinished).length
    if (isReminder && finished && report && deps.may('notify.plans')) {
      const last = await $.store.get(STORE_REMINDED + report.repoKey).catch(() => undefined)
      if (isReminderDue(typeof last === 'number' ? last : null, at)) {
        deps.notify(reminderText(finished))
        await $.store.set(STORE_REMINDED + report.repoKey, at)
      }
    }
    const ask = prsToAsk(plans, prs, isRecheck)
    if (!ask.length) return
    const before = new Map(prs)
    await Promise.all(ask.map(n => askPr(root, n)))
    await deps.save({ plans, merged: merged(), archiveDir: spec?.archiveDir ?? '', at, error: '' })
    const toast = mergedToast(plans, before, prs)
    if (toast && deps.may('notify.plans')) deps.notify(toast)
  }

  // The files whose references to `from` would change, with their new text: every Markdown file under `.local/` and
  // in the plan's own folder (links and mentions), and the memory notes (mentions only, as they sit outside the repo).
  const referencesTo = async (root: string, from: string, to: string) => {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
    const repoFiles = new Set([...(await filesOf(root, REFS_GLOB)), ...(await filesOf(root, dir ? `${dir}/*.md` : '*.md'))])
    repoFiles.delete(from)
    const changes: { abs: string; label: string; text: string }[] = []
    for (const f of [...repoFiles].sort()) {
      const text = await readText($, `${root}/${f}`)
      const next = rewriteRefs(text, f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', from, to)
      if (next !== text) changes.push({ abs: `${root}/${f}`, label: f, text: next })
    }
    const notes = (await $.fs.list(deps.memoryDir).catch(() => [])).filter(e => e.kind === 'file' && e.name.endsWith('.md'))
    for (const e of notes.sort((a, b) => a.name.localeCompare(b.name))) {
      const text = await readText($, `${deps.memoryDir}/${e.name}`)
      const next = rewriteRefs(text, null, from, to)
      if (next !== text) changes.push({ abs: `${deps.memoryDir}/${e.name}`, label: 'memory/' + e.name, text: next })
    }
    return changes
  }

  // Asks first, naming every file; then writes the archive copy and reads it back, rewrites the references, and only
  // then removes the original, so a failure never leaves the plan without a copy.
  const archive = async (path: string) => {
    const pack = await deps.pack()
    const root = deps.report()?.root ?? ''
    const dir = archiveDirFor(path, pack?.plans)
    if (!root || !dir) return
    const to = archivePath(path, dir)
    if (await $.fs.exists(`${root}/${to}`)) return deps.notify(`Already in the archive: ${to}`) // asked
    const text = await readText($, `${root}/${path}`)
    const fromDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const moved = rewriteRefs(moveOwnLinks(text, fromDir, dir), dir, path, to)
    const changes = await referencesTo(root, path, to)
    const open = parsed.get(path)?.plan.checkpoints.filter(c => c.status === 'open' || c.status === 'partly').length ?? 0
    const question = archiveQuestion(path, to, changes.map(c => c.label), open)
    const answer = await $.ui.ask(question, { options: [ARCHIVE, 'Cancel'], header: 'Archive plan' }).catch(() => '') // asked
    if (answer !== ARCHIVE) return

    await $.fs.write(`${root}/${to}`, moved) // asked
    if ((await readText($, `${root}/${to}`)) !== moved) return deps.notify(`Archive copy didn't match, nothing removed: ${baseOf(path)}`) // asked
    // A reference that can't be written stops it before the original goes: both copies stay, and the references
    // already moved lead to the archive copy, which exists.
    for (const c of changes) {
      const isWritten = await $.fs.write(c.abs, c.text).then( // asked
        () => true,
        () => false,
      )
      if (!isWritten) return deps.notify(`Couldn't update ${c.label}, so ${path} was kept: the archive copy is in place`) // asked
    }
    await deps.light(removeCommand(deps.platform, `${root}/${path}`), undefined, root).catch(() => null)
    parsed.delete(path)
    if (await $.fs.exists(`${root}/${path}`)) deps.notify(`Archived, but couldn't remove ${path}: remove it by hand`) // asked
    else deps.notify(`Archived ${baseOf(path)}, ${changes.length} ${changes.length === 1 ? 'file' : 'files'} updated`) // asked
  }

  const once = async (job: () => Promise<void>) => {
    if (isBusy) return
    isBusy = true
    try {
      await job()
    } finally {
      isBusy = false
    }
  }

  return {
    // A refresh that comes while one runs is skipped.
    refresh: o => once(() => refresh(o?.isRecheck ?? true, o?.isReminder ?? false)),
    // One archive at a time; it doesn't wait for a refresh (they only read), and the board is read again after it,
    // without asking GitHub.
    archive: async path => {
      if (isArchiving) return
      isArchiving = true
      try {
        await archive(path)
      } finally {
        isArchiving = false
      }
      await once(() => refresh(false, false))
    },
  }
}
