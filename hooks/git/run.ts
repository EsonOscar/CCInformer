import type { EngineInterface } from 'claude-code'

import type { CiSnapshot, DiffPreview, FileChange, GitSnapshot } from '../../types'
import { collectCi, collectDiff, collectGit } from '../collect'
import type { Exec } from '../collect'
import { createSolo } from '../core/lanes'
import { ciOutcome } from '../insight'
import { previewDiff, previewNewFile } from '../parse'
import { gitFolderFacts } from '../read-git'
import { readText } from '../read-records'

// Which commits' CI has been pinged about, in the store every session shares, and how many are kept.
const STORE_CI_PINGED = 'ciPinged'
const CI_PINGS_KEPT = 20

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
  // A commit's checks finished with a failure, in the session that pinged for it (active CI mode decides what follows).
  onCiFailed?: (ci: CiSnapshot) => Promise<void>
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

  // Tells the person once when this commit's checks finish; one session pings for all of them.
  const pingCi = async (prev: CiSnapshot | null, ci: CiSnapshot) => {
    const outcome = ciOutcome(prev, ci)
    if (!outcome) return
    const pinged = await $.store.get(STORE_CI_PINGED)
    const list = Array.isArray(pinged) ? (pinged as string[]) : []
    if (list.includes(ci.head)) return
    await $.store.set(STORE_CI_PINGED, [...list, ci.head].slice(-CI_PINGS_KEPT))
    $.ui.toast((outcome.isOk ? '✓ ' : '✗ ') + outcome.text)
    await $.ui.notify(outcome.text, { title: outcome.isOk ? 'CI passed' : 'CI failed' })
    // Not awaited: what follows a failure (fetching logs, an agent) must never hold up the CI poll.
    if (!outcome.isOk) void deps.onCiFailed?.(ci).catch(() => undefined)
  }
  const refreshCi = () =>
    solo('ci', async () => {
      const git = await deps.git()
      if (!git || git.error) return
      const prev = await deps.ci()
      const ci = await collectCi(deps.exec, git.branch, git.head, await $.clock.now())
      await deps.saveCi(ci)
      await pingCi(prev, ci)
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
      const git = collected.gitDir ? { ...collected, ...(await gitFolderFacts($, collected.gitDir)) } : collected
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
