import type { Color } from 'claude-code'

import type { BaseCi, CheckBucket, CiActiveState, CiCheck, CiSnapshot, Commit, DiffPreview, FileChange, GitSnapshot, PullRequest } from '../types'
import { ACTIONS } from './areas'
import { CI_TEXTS } from './ci/investigate'
import { ago, duration, lastSegment, since } from './format'
import { groupChanges } from './parse'
import { ACCENT, Empty, Line, Section, checkGlyph } from './ui'
import type { Kit } from './ui'

const FILES_SHOWN = 12
const COMMITS_SHOWN = 5
const BAR_MAX = 24
const BASE_CHECKS_SHOWN = 6
const STASHES_SHOWN = 3
const ORDER: CheckBucket[] = ['fail', 'pending', 'cancel', 'pass', 'skipping']

// What the Git tab's controls do; the hooks module makes them.
export type GitNav = {
  showAll: boolean
  toggleAll: () => void
  diff: DiffPreview | null
  openDiff: (file: FileChange) => void
  fetch: () => void
  openDiffPane: () => void
  // Active CI mode: this repo's mode and latest investigation, and the switch.
  ciActive: CiActiveState
  toggleCiMode: () => void
}

// `isPaused`: the session has been idle a while, so git is not polled until something happens or `r` is pressed.
export const GitView = (
  k: Kit,
  git: GitSnapshot | null,
  ci: CiSnapshot | null,
  now: number,
  width: number,
  isPaused: boolean,
  nav: GitNav,
): JSX.Element => {
  const { Box, Text } = k
  if (!git) return Empty(k, isPaused ? 'Paused while idle · press r' : 'Reading the repository…')
  if (git.error) return Empty(k, git.error)
  return (
    <Box flexDirection="column">
      {Branch(k, git, now, isPaused, nav)}
      {git.operation && (
        <Text color="warning" wrap="truncate-end">
          {`  ⚠ ${git.operation} in progress` + (groupChanges(git.files).conflicts.length ? ': resolve the conflicts below' : '')}
        </Text>
      )}
      {Ci(k, ci, now, width, nav)}
      {ci?.base && Base(k, ci.base, now)}
      {Changes(k, git.files, nav)}
      {git.unpushed.length > 0 && Section(k, 'Unpushed', String(git.unpushed.length))}
      {git.unpushed.map(c => CommitRow(k, c))}
      {git.incoming.length > 0 && Section(k, 'Incoming', String(git.incoming.length))}
      {git.incoming.map(c => CommitRow(k, c))}
      {Section(k, 'Recent')}
      {git.commits.slice(0, COMMITS_SHOWN).map(c => CommitRow(k, c))}
      {git.branches.length > 0 && Section(k, 'Branches', String(git.branches.length))}
      {git.branches.map(b => Line(k, { char: '⎇', color: 'inactive' }, b.name, [b.track, b.age].filter(Boolean).join(' · ')))}
      {git.stashes > 0 && Section(k, 'Stashes', String(git.stashes))}
      {git.stashList.slice(0, STASHES_SHOWN).map(s => Line(k, { char: '≡', color: 'inactive' }, s))}
      {git.worktrees.length > 1 && Section(k, 'Worktrees', String(git.worktrees.length))}
      {git.worktrees.length > 1 &&
        git.worktrees.map(w =>
          Line(
            k,
            w.branch === git.branch ? { char: '●', color: ACCENT } : { char: '·', color: 'inactive' },
            lastSegment(w.path),
            w.branch,
          ),
        )}
    </Box>
  )
}

const Branch = (k: Kit, git: GitSnapshot, now: number, isPaused: boolean, nav: GitNav): JSX.Element => {
  const { Box, Button, Text } = k
  const added = git.files.reduce((n, f) => n + f.added, 0)
  const removed = git.files.reduce((n, f) => n + f.removed, 0)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={1}>
          <Text color={ACCENT} weight="semibold" wrap="truncate-end">
            {'⎇ ' + git.branch}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {git.upstream ? '→ ' + git.upstream : 'no upstream'}
          </Text>
        </Box>
        <Text color={git.ahead ? 'warning' : 'inactive'}>{'↑' + git.ahead}</Text>
        <Text color={git.behind ? 'warning' : 'inactive'}>{'↓' + git.behind}</Text>
      </Box>
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{git.files.length ? git.files.length + ' changed' : 'clean'}</Text>
        {added > 0 && <Text color="diffAdded">{'+' + added}</Text>}
        {removed > 0 && <Text color="diffRemoved">{'−' + removed}</Text>}
        <Box flexGrow={1} />
        <Text color={isPaused ? 'warning' : 'inactive'} dimColor={!isPaused}>
          {(isPaused ? 'paused · r · ' : 'synced ') + duration(now - git.at)}
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{git.fetchedAt ? 'fetched ' + ago(now - git.fetchedAt) : 'never fetched'}</Text>
        <Box flexGrow={1} />
        <Button key="git-fetch" plain hotkey={ACTIONS.code.fetch} onPress={nav.fetch}>
          <Text color={ACCENT} dimColor>
            fetch
          </Text>
        </Button>
      </Box>
    </Box>
  )
}

const REVIEW_LOOK: Record<string, { text: string; color: Color }> = {
  APPROVED: { text: 'approved', color: 'success' },
  CHANGES_REQUESTED: { text: 'changes requested', color: 'error' },
  REVIEW_REQUIRED: { text: 'review required', color: 'warning' },
}
const MERGE_LOOK: Record<string, { text: string; color: Color }> = {
  CLEAN: { text: 'mergeable', color: 'success' },
  HAS_HOOKS: { text: 'mergeable', color: 'success' },
  DIRTY: { text: 'conflicts', color: 'error' },
  BLOCKED: { text: 'blocked', color: 'warning' },
  BEHIND: { text: 'behind base', color: 'warning' },
  UNSTABLE: { text: 'checks failing', color: 'warning' },
  DRAFT: { text: 'draft', color: 'inactive' },
}

// The PR's state at a glance: review, whether it can merge, and its size.
const PrFacts = (k: Kit, pr: PullRequest): JSX.Element => {
  const { Box, Text } = k
  const review = REVIEW_LOOK[pr.review]
  const merge = MERGE_LOOK[pr.mergeState]
  return (
    <Box flexDirection="row" columnGap={1} marginLeft={2} flexWrap="wrap">
      {review && <Text color={review.color}>{review.text}</Text>}
      {merge && <Text color={merge.color}>{(review ? '· ' : '') + merge.text}</Text>}
      <Text color="diffAdded">{'+' + pr.additions}</Text>
      <Text color="diffRemoved">{'−' + pr.deletions}</Text>
      <Text dimColor>{`${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}`}</Text>
    </Box>
  )
}

const Ci = (k: Kit, ci: CiSnapshot | null, now: number, width: number, nav: GitNav): JSX.Element => {
  const { Box, Link } = k
  if (!ci) return <Box flexDirection="column">{Section(k, 'CI')}{CiMode(k, nav)}{Empty(k, 'Asking GitHub…')}</Box>
  const pr = ci.pr && ci.pr.state === 'OPEN' ? ci.pr : null
  const title = pr ? `CI · PR #${pr.number} → ${pr.base}${pr.isDraft ? ' · draft' : ''}` : 'CI · this commit'
  const sorted = [...ci.checks].sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket))
  return (
    <Box flexDirection="column">
      {Section(k, title, Elapsed(k, ci.checks, now))}
      {CiMode(k, nav)}
      {pr && <Link href={pr.url} label={'  ' + pr.title} />}
      {pr && PrFacts(k, pr)}
      {ci.error && Empty(k, ci.error)}
      {!ci.error && ci.checks.length === 0 && Empty(k, pr ? 'No checks reported yet.' : 'No runs for this branch.')}
      {ci.checks.length > 0 && Tally(k, ci.checks, Math.min(BAR_MAX, Math.max(8, width - 22)))}
      {sorted.map(c => Check(k, c, now))}
    </Box>
  )
}

// What a failed check leads to here (a toast, or Claude looking into it read-only), with `i` to switch, and how the
// latest investigation went.
const CiMode = (k: Kit, nav: GitNav): JSX.Element => {
  const { Box, Button, Text } = k
  const { mode, run } = nav.ciActive
  const isActive = mode === 'active'
  const head = run?.head.slice(0, 7) ?? ''
  const state =
    run?.state === 'investigating'
      ? Line(k, { char: '◐', color: ACCENT }, CI_TEXTS.viewInvestigating(head))
      : run?.state === 'waiting'
        ? Line(k, { char: '◐', color: 'warning' }, CI_TEXTS.viewWaiting)
        : run?.state === 'sent'
          ? Line(k, { char: '✓', color: 'success' }, CI_TEXTS.viewSent)
          : run?.state === 'failed'
            ? Line(k, { char: '✗', color: 'error' }, CI_TEXTS.viewFailed(run.why))
            : null
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {'  ' + (isActive ? CI_TEXTS.viewActive : CI_TEXTS.viewPassive)}
          </Text>
        </Box>
        <Button key="ci-mode" plain hotkey={ACTIONS.code.ciMode} onPress={nav.toggleCiMode}>
          <Text dimColor>{`${ACTIONS.code.ciMode} ${isActive ? 'passive' : 'active'}`}</Text>
        </Button>
      </Box>
      {state}
    </Box>
  )
}

// How long the checks have run, or ran: from the first start to now, or to the last finish.
const Elapsed = (k: Kit, checks: CiCheck[], now: number): JSX.Element | false => {
  const { Text } = k
  const isRunning = checks.some(c => c.bucket === 'pending')
  const starts = checks.map(c => Date.parse(c.startedAt)).filter(t => t > 0)
  const ends = checks.map(c => Date.parse(c.completedAt)).filter(t => t > 0)
  const first = starts.length ? Math.min(...starts) : 0
  const elapsed = first ? (isRunning ? now - first : Math.max(first, ...ends) - first) : 0
  return elapsed > 0 && <Text color={isRunning ? ACCENT : 'inactive'}>{(isRunning ? '● ' : '') + duration(elapsed)}</Text>
}

// The newest runs on the branch this one merges into: where a merge's own CI and deploy run.
const Base = (k: Kit, base: BaseCi, now: number): JSX.Element => {
  const { Box } = k
  const sorted = [...base.checks].sort((a, b) => ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket))
  return (
    <Box flexDirection="column">
      {Section(k, 'CI · ' + base.branch, Elapsed(k, base.checks, now))}
      {base.error && Empty(k, base.error)}
      {!base.error && base.checks.length === 0 && Empty(k, 'No runs yet.')}
      {sorted.slice(0, BASE_CHECKS_SHOWN).map(c => Check(k, c, now))}
    </Box>
  )
}

// The checks as one bar in their colors, then the counts.
const Tally = (k: Kit, checks: CiCheck[], width: number): JSX.Element => {
  const { Box, Text } = k
  const count = (b: CheckBucket) => checks.filter(c => c.bucket === b).length
  const parts: { bucket: CheckBucket; color: Color }[] = [
    { bucket: 'pass', color: 'success' },
    { bucket: 'fail', color: 'error' },
    { bucket: 'pending', color: ACCENT },
    { bucket: 'cancel', color: 'warning' },
    { bucket: 'skipping', color: 'inactive' },
  ]
  let used = 0
  const cells = parts.map((p, i) => {
    const n = i === parts.length - 1 ? width - used : Math.round((count(p.bucket) / checks.length) * width)
    used += n
    return { ...p, n }
  })
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box flexDirection="row">
        {cells.map(c => c.n > 0 && <Text color={c.color}>{(c.bucket === 'skipping' ? '░' : '█').repeat(c.n)}</Text>)}
      </Box>
      <Text color="success">{count('pass') + '✓'}</Text>
      {count('fail') > 0 && <Text color="error">{count('fail') + '✗'}</Text>}
      {count('pending') > 0 && <Text color={ACCENT}>{count('pending') + '●'}</Text>}
    </Box>
  )
}

// A check on one line; a failed one links to its run, where the log is.
const Check = (k: Kit, c: CiCheck, now: number): JSX.Element => {
  const { Link } = k
  const ms = c.completedAt ? Date.parse(c.completedAt) - Date.parse(c.startedAt) : since(now, c.startedAt)
  const label = c.workflow && c.workflow !== c.name ? `${c.workflow} / ${c.name}` : c.name
  const left = c.bucket === 'fail' && c.link ? <Link href={c.link} label={label} /> : label
  return Line(k, checkGlyph(c.bucket, now), left, c.bucket === 'skipping' ? 'skipped' : duration(ms))
}

const CODE_COLORS: Record<string, Color> = { M: 'warning', A: 'success', '?': 'success', D: 'error', R: 'suggestion', U: 'error' }

// Every change, grouped the way git does: conflicts, staged, unstaged, untracked. Compact unless `f` shows all;
// pressing a file shows its diff under it.
const Changes = (k: Kit, files: FileChange[], nav: GitNav): JSX.Element => {
  const { Box, Button, Text } = k
  if (files.length === 0) return <Box />
  const groups = groupChanges(files)
  let room = nav.showAll ? Number.MAX_SAFE_INTEGER : FILES_SHOWN
  const take = (list: FileChange[]) => {
    const shown = list.slice(0, Math.max(0, room))
    room -= shown.length
    return shown
  }
  const sections = [
    { title: 'Conflicts', list: groups.conflicts, color: 'error' as Color },
    { title: 'Staged', list: groups.staged, color: 'success' as Color },
    { title: 'Unstaged', list: groups.unstaged, color: 'warning' as Color },
    { title: 'Untracked', list: groups.untracked, color: 'inactive' as Color },
  ]
    .filter(s => s.list.length)
    .map(s => ({ ...s, shown: take(s.list) }))
  const hidden = files.length - sections.reduce((n, s) => n + s.shown.length, 0)
  const note = (
    <Box flexDirection="row" columnGap={1}>
      <Button key="git-all" plain hotkey={ACTIONS.code.allFiles} onPress={nav.toggleAll}>
        <Text dimColor>{nav.showAll ? 'fewer' : 'all'}</Text>
      </Button>
      <Button key="git-diffpane" plain hotkey={ACTIONS.code.diffPane} onPress={nav.openDiffPane}>
        <Text dimColor>/diff</Text>
      </Button>
    </Box>
  )
  return (
    <Box flexDirection="column">
      {Section(k, `Changes · ${files.length}`, note)}
      {sections.map(s => (
        <Box flexDirection="column">
          {s.shown.length > 0 && <Text color={s.color} dimColor>{`  ${s.title} · ${s.list.length}`}</Text>}
          {s.shown.map(f => FileRow(k, f, s.title, nav))}
        </Box>
      ))}
      {hidden > 0 && Empty(k, `and ${hidden} more · f shows all`)}
    </Box>
  )
}

const FileRow = (k: Kit, f: FileChange, group: string, nav: GitNav): JSX.Element => {
  const { Box, Button, Code, Text } = k
  const code = f.code.trim() || f.code
  const isOpen = nav.diff?.path === f.path
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} marginLeft={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={`file-${group}-${f.path}`} plain onPress={() => nav.openDiff(f)}>
            <Text color={CODE_COLORS[code[0] ?? ''] ?? 'text'}>{(isOpen ? '▾' : '▸') + ' ' + code.padEnd(2) + ' '}</Text>
            <Text color={isOpen ? ACCENT : 'text'} wrap="truncate-start">
              {f.path}
            </Text>
          </Button>
        </Box>
        {f.added > 0 && <Text color="diffAdded">{'+' + f.added}</Text>}
        {f.removed > 0 && <Text color="diffRemoved">{'−' + f.removed}</Text>}
      </Box>
      {isOpen && nav.diff && (
        <Box marginLeft={2} marginY={1}>
          {nav.diff.isLoading ? <Text dimColor>Loading the diff…</Text> : <Code source={nav.diff.text || '(no changes)'} format="diff" path={f.path} />}
        </Box>
      )}
    </Box>
  )
}

const CommitRow = (k: Kit, c: Commit): JSX.Element => {
  const { Box, Text } = k
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={ACCENT} dimColor>
        {c.sha}
      </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{c.subject}</Text>
      </Box>
      <Text dimColor>{c.age}</Text>
    </Box>
  )
}
