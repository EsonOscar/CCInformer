import type { EngineInterface } from 'claude-code'

import type { CiActiveState, CiSnapshot, DiffPreview, FileChange, GitSnapshot } from '../../types'
import { collectCi, collectDiff, collectFlaky, collectGit, collectNoise, newNoiseCache } from '../collect'
import type { Exec } from '../collect'
import { createSolo } from '../core/lanes'
import type { May } from '../core/permissions'
import type { NoiseRule } from '../packs/types'
import { markFlaky } from './flaky'
import type { FlakyIndex } from './flaky'
import { rewriteCandidates } from './noise'
import { ciOutcome, earlyFailureText, newFailures } from '../insight'
import { previewDiff, previewNewFile } from '../parse'
import { gitFolderFacts } from '../read-git'
import { readText } from '../read-records'

// Which commits' CI has been pinged about, in the store every session shares, and how many are kept.
const STORE_CI_PINGED = 'ciPinged'
const CI_PINGS_KEPT = 20
// How long the repo's likely-flaky jobs are kept before they are read again.
const FLAKY_TTL_MS = 30 * 60_000

// What git and CI take from the session: the light lane, and the snapshots, the open diff and Code's selection as the
// state holds them (the atoms live in the hooks module, so they're read and written through these).
export type GitDeps = {
  exec: Exec
  git: () => Promise<GitSnapshot | null>
  saveGit: (git: GitSnapshot) => Promise<unknown>
  ci: () => Promise<CiSnapshot | null>
  saveCi: (ci: CiSnapshot) => Promise<unknown>
  diff: () => Promise<DiffPreview | null>
  saveDiff: (diff: DiffPreview | null) => Promise<unknown>
  clearSelection: () => Promise<unknown>
  // The resolved pack's noise rules ([] with none).
  noise: () => Promise<NoiseRule[]>
  // A check failed: early, while others still run (in any session polling the repo), or when the commit's checks
  // finished (in the session that pinged for it). Active CI mode decides what follows.
  onCiFailed?: (ci: CiSnapshot) => Promise<void>
  // The repo's CI mode as last read: passive mode toasts a check that fails while others run.
  mode: () => CiActiveState['mode']
  may: May
}

export type Git = {
  // The branch, its files and the rest of Code › Git; CI too when the branch or head moved.
  refreshGit: () => Promise<void>
  // The branch's PR checks or the commit's runs.
  refreshCi: () => Promise<void>
  // A file's diff for the preview: against HEAD, or an untracked file's first lines as added.
  loadDiff: (file: FileChange, root: string) => Promise<void>
}

// Code › Git: git and CI read through the light lane, each poll alone (one that comes due while its last run is busy
// is skipped), and a ping when a commit's checks finish.
export function createGit($: EngineInterface, deps: GitDeps): Git {
  const solo = createSolo()
  const noiseCache = newNoiseCache()
  // The repo's likely-flaky jobs, read at most once per FLAKY_TTL_MS (a failed read too, so an outage isn't retried
  // on every poll).
  let flaky: { at: number; index: FlakyIndex } | null = null

  // Tells the person once when this commit's checks finish; one session pings for all of them.
  const pingCi = async (prev: CiSnapshot | null, ci: CiSnapshot) => {
    const outcome = ciOutcome(prev, ci)
    if (!outcome) return
    const pinged = await $.store.get(STORE_CI_PINGED)
    const list = Array.isArray(pinged) ? (pinged as string[]) : []
    if (list.includes(ci.head)) return
    await $.store.set(STORE_CI_PINGED, [...list, ci.head].slice(-CI_PINGS_KEPT))
    if (deps.may('notify.ciToast')) $.ui.toast((outcome.isOk ? '✓ ' : '✗ ') + outcome.text)
    if (deps.may('notify.ciOs')) await $.ui.notify(outcome.text, { title: outcome.isOk ? 'CI passed' : 'CI failed' })
    // Not awaited: what follows a failure (fetching logs, an agent) must never hold up the CI poll.
    if (!outcome.isOk) void deps.onCiFailed?.(ci).catch(() => undefined)
  }
  const refreshCi = () =>
    solo('ci', async () => {
      const git = await deps.git()
      if (!git || git.error) return
      const prev = await deps.ci()
      const now = await $.clock.now()
      const collected = await collectCi(deps.exec, git.branch, git.head, now)
      // A failed PR check is marked when its job lately flaked elsewhere. The repo's reruns are read only when one
      // fails and the index is missing or old; the row turns red first, marked from the old index if there is one.
      const hasFailed = collected.source === 'pr' && collected.checks.some(c => c.bucket === 'fail')
      if (hasFailed && (!flaky || now - flaky.at > FLAKY_TTL_MS)) {
        await deps.saveCi(markFlaky(collected, flaky?.index ?? {}))
        flaky = { at: now, index: await collectFlaky(deps.exec, now) }
      }
      const ci = flaky ? markFlaky(collected, flaky.index) : collected
      await deps.saveCi(ci)
      await pingCi(prev, ci)
      // A check that failed while others still run is told at once: a toast in passive mode, a look in active mode.
      const fresh = newFailures(prev, ci)
      if (fresh.length) {
        if (deps.mode() !== 'active' && deps.may('notify.ciToast')) $.ui.toast('✗ ' + earlyFailureText(ci, fresh))
        void deps.onCiFailed?.(ci).catch(() => undefined)
      }
    })
  const loadDiff = async (file: FileChange, root: string) => {
    const text = file.code === '??' ? previewNewFile(await readText($, `${root}/${file.path}`)) : previewDiff(await collectDiff(deps.exec, file.path))
    const shown = await deps.diff()
    if (shown?.path === file.path) await deps.saveDiff({ path: file.path, text, isLoading: false })
  }
  const refreshGit = () =>
    solo('git', async () => {
      const before = await deps.git()
      const collected = await collectGit(deps.exec, await $.clock.now())
      // The pack's noise: generated files and editor rewrites are marked, so the view can fold them.
      const rules = collected.error ? [] : await deps.noise()
      const stamps: Record<string, string> = {}
      for (const path of rewriteCandidates(collected.files, rules)) {
        const stat = await $.fs.stat(`${collected.root}/${path}`).catch(() => null)
        stamps[path] = stat ? `${stat.mtimeMs}:${stat.size}` : ''
      }
      const files = await collectNoise(deps.exec, collected.files, rules, collected.head, stamps, noiseCache)
      const marked = { ...collected, files }
      const git = marked.gitDir ? { ...marked, ...(await gitFolderFacts($, marked.gitDir)) } : marked
      await deps.saveGit(git)
      // An open diff follows its file, and closes once the file is no longer changed (committed, reverted).
      const diff = await deps.diff()
      const changed = diff && !diff.isLoading ? git.files.find(f => f.path === diff.path) : undefined
      if (diff && !diff.isLoading && !changed) {
        await deps.saveDiff(null)
        await deps.clearSelection()
      }
      if (changed) void loadDiff(changed, git.root)
      if (!before || before.branch !== git.branch || before.head !== git.head) await refreshCi()
    })

  return { refreshGit, refreshCi, loadDiff }
}
