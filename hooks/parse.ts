import type { Branch, CheckBucket, CiCheck, Commit, FileChange, PullRequest, Worktree } from '../types'

// Plain functions over command output, so the tests can feed them text.

export type StatusParse = { branch: string; upstream: string; head: string; ahead: number; behind: number; files: FileChange[] }

// `git status --porcelain=v2 --branch`
export const parseStatus = (text: string): StatusParse => {
  const out: StatusParse = { branch: '', upstream: '', head: '', ahead: 0, behind: 0, files: [] }
  for (const line of text.split('\n')) {
    const parts = line.split(' ')
    if (line.startsWith('# branch.oid ')) out.head = parts[2] ?? ''
    else if (line.startsWith('# branch.head ')) out.branch = parts[2] ?? ''
    else if (line.startsWith('# branch.upstream ')) out.upstream = parts[2] ?? ''
    else if (line.startsWith('# branch.ab ')) {
      out.ahead = Math.abs(Number(parts[2]) || 0)
      out.behind = Math.abs(Number(parts[3]) || 0)
    } else if (parts[0] === '1') out.files.push(change(parts[1] ?? '', parts.slice(8).join(' ')))
    else if (parts[0] === '2') out.files.push(change(parts[1] ?? '', parts.slice(9).join(' ').split('\t')[0] ?? ''))
    else if (parts[0] === 'u') out.files.push(change('UU', parts.slice(10).join(' ')))
    else if (parts[0] === '?') out.files.push(change('??', parts.slice(1).join(' ')))
  }
  return out
}

const change = (xy: string, path: string): FileChange => ({ path, code: xy.replace(/\./g, ' '), added: 0, removed: 0 })

// `git diff --numstat HEAD`: added and removed lines per path ('-' for a binary file).
export const parseNumstat = (text: string): Map<string, { added: number; removed: number }> => {
  const out = new Map<string, { added: number; removed: number }>()
  for (const line of text.split('\n')) {
    const [added, removed, ...path] = line.split('\t')
    if (path.length) out.set(path.join('\t'), { added: Number(added) || 0, removed: Number(removed) || 0 })
  }
  return out
}

export const withNumstat = (files: FileChange[], stats: Map<string, { added: number; removed: number }>): FileChange[] =>
  files.map(f => ({ ...f, ...(stats.get(f.path) ?? {}) }))

// `git log --format=%h%x1f%s%x1f%cr`
export const parseLog = (text: string): Commit[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha = '', subject = '', age = ''] = line.split('\x1f')
      return { sha, subject, age: shortAge(age) }
    })

// "3 hours ago" → "3h"
export const shortAge = (age: string): string => {
  const m = /^(\d+) (second|minute|hour|day|week|month|year)s? ago$/.exec(age.trim())
  const units: Record<string, string> = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }
  return m ? (m[1] ?? '') + (units[m[2] ?? ''] ?? '') : age
}

// `git worktree list --porcelain`
export const parseWorktrees = (text: string): Worktree[] =>
  text
    .split(/\n\s*\n/)
    .map(block => {
      const lines = block.split('\n')
      const path = lines.find(l => l.startsWith('worktree '))?.slice(9) ?? ''
      const ref = lines.find(l => l.startsWith('branch '))?.slice(7) ?? ''
      return { path, branch: ref ? ref.replace('refs/heads/', '') : '(detached)' }
    })
    .filter(w => w.path)

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const count = (v: unknown): number => (typeof v === 'number' ? v : 0)

// `gh pr view --json number,title,url,baseRefName,isDraft,reviewDecision,state,mergeStateStatus,additions,deletions,changedFiles`
export const parsePr = (text: string): PullRequest | null => {
  const pr = parseJson(text) as Record<string, unknown> | undefined
  if (!pr || typeof pr.number !== 'number') return null
  return {
    number: pr.number,
    title: str(pr.title),
    url: str(pr.url),
    base: str(pr.baseRefName),
    isDraft: pr.isDraft === true,
    state: str(pr.state),
    review: str(pr.reviewDecision),
    mergeState: str(pr.mergeStateStatus),
    additions: count(pr.additions),
    deletions: count(pr.deletions),
    changedFiles: count(pr.changedFiles),
  }
}

// `git for-each-ref --format=%(refname:short)%x1f%(committerdate:relative)%x1f%(upstream:track) refs/heads`,
// newest first: the branches besides the current one.
export const parseBranches = (text: string, current: string): Branch[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name = '', age = '', track = ''] = line.split('\x1f')
      return { name, age: shortAge(age), track: track.replace(/^\[|\]$/g, '').replace('ahead ', '↑').replace('behind ', '↓') }
    })
    .filter(b => b.name && b.name !== current)

// `git stash list --format=%gd%x1f%s`
export const parseStashes = (text: string): string[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\x1f')[1] ?? line)

export type ChangeGroups = { conflicts: FileChange[]; staged: FileChange[]; unstaged: FileChange[]; untracked: FileChange[] }

// The changes as git groups them: conflicts first, then staged, unstaged (a file staged and changed again is in
// both), and untracked.
export const groupChanges = (files: FileChange[]): ChangeGroups => {
  const isConflict = (f: FileChange) => f.code.includes('U') || f.code === 'AA' || f.code === 'DD'
  const tracked = files.filter(f => f.code !== '??' && !isConflict(f))
  return {
    conflicts: files.filter(isConflict),
    staged: tracked.filter(f => f.code[0] !== ' '),
    unstaged: tracked.filter(f => f.code[1] !== undefined && f.code[1] !== ' '),
    untracked: files.filter(f => f.code === '??'),
  }
}

// What git is in the middle of, from the marker files in the git folder.
export const OPERATION_MARKERS: { file: string; name: string }[] = [
  { file: 'rebase-merge', name: 'rebase' },
  { file: 'rebase-apply', name: 'rebase' },
  { file: 'MERGE_HEAD', name: 'merge' },
  { file: 'CHERRY_PICK_HEAD', name: 'cherry-pick' },
  { file: 'REVERT_HEAD', name: 'revert' },
  { file: 'BISECT_LOG', name: 'bisect' },
]

// The diff preview's text: a file's diff against HEAD, or an untracked file's first lines shown as added.
const DIFF_LINES = 80
export const previewDiff = (diff: string): string => {
  const lines = diff.split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  const body = start >= 0 ? lines.slice(start) : lines
  return body.length > DIFF_LINES ? [...body.slice(0, DIFF_LINES), `… ${body.length - DIFF_LINES} more lines`].join('\n') : body.join('\n')
}
export const previewNewFile = (text: string): string => {
  const lines = text.split('\n')
  const shown = lines.slice(0, DIFF_LINES)
  return [`@@ -0,0 +1,${lines.length} @@`, ...shown.map(l => '+' + l)].join('\n')
}

const BUCKETS: CheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel']

// `gh pr checks --json name,workflow,bucket,startedAt,completedAt,link`
export const parseChecks = (text: string): CiCheck[] => {
  const list = parseJson(text)
  if (!Array.isArray(list)) return []
  return list.map((c: Record<string, unknown>) => ({
    name: str(c.name),
    workflow: str(c.workflow),
    bucket: BUCKETS.includes(c.bucket as CheckBucket) ? (c.bucket as CheckBucket) : 'pending',
    startedAt: str(c.startedAt),
    completedAt: str(c.completedAt),
    link: str(c.link),
  }))
}

const CONCLUSIONS: Record<string, CheckBucket> = {
  success: 'pass',
  failure: 'fail',
  timed_out: 'fail',
  startup_failure: 'fail',
  cancelled: 'cancel',
  skipped: 'skipping',
  neutral: 'skipping',
}

// `gh run list --json workflowName,displayTitle,status,conclusion,createdAt,updatedAt,headSha,url`:
// the runs for the checked-out commit, or for the newest commit that has runs.
export const parseRuns = (text: string, head: string): CiCheck[] => {
  const list = parseJson(text)
  if (!Array.isArray(list) || list.length === 0) return []
  const sha = list.some((r: Record<string, unknown>) => r.headSha === head) ? head : str(list[0].headSha)
  return list
    .filter((r: Record<string, unknown>) => r.headSha === sha)
    .map((r: Record<string, unknown>) => {
      const isDone = r.status === 'completed'
      return {
        name: str(r.workflowName) || str(r.displayTitle),
        workflow: str(r.workflowName),
        bucket: isDone ? (CONCLUSIONS[str(r.conclusion)] ?? 'fail') : 'pending',
        startedAt: str(r.createdAt),
        completedAt: isDone ? str(r.updatedAt) : '',
        link: str(r.url),
      }
    })
}

// The `meta` of a workflow script: its name and phase titles, read as text (the script is not run).
export const parseWorkflowMeta = (script: string): { name: string; phases: string[] } => {
  const meta = /export const meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? ''
  const name = /\bname:\s*['"`]([^'"`]+)['"`]/.exec(meta)?.[1] ?? 'workflow'
  const phases = [...meta.matchAll(/\btitle:\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1] ?? '').filter(Boolean)
  return { name, phases }
}

const MIN_SHARED_PREFIX = 4

// Which phase an agent's label belongs to: `scout:git` → Scout, `critic:fit` → Critique.
export const phaseOf = (label: string, phases: string[]): string => {
  const head = (label.split(':')[0] ?? '').trim().toLowerCase()
  if (!head) return ''
  const shared = (a: string, b: string) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i
  }
  return (
    phases.find(p => {
      const title = p.toLowerCase()
      return title.startsWith(head) || head.startsWith(title) || shared(title, head) >= MIN_SHARED_PREFIX
    }) ?? ''
  )
}
