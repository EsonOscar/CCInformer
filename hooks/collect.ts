import type { BaseCi, CiSnapshot, GitSnapshot } from '../types'
import { firstLine } from './format'
import {
  parseBranches, parseChecks, parseLog, parseNumstat, parsePr, parseRuns, parseStashes, parseStatus, parseWorktrees, withNumstat,
} from './parse'

export type Ran = { exitCode: number; stdout: string; stderr: string }
// Runs one command; the hooks module makes it from $.process.run.
export type Exec = (argv: string[]) => Promise<Ran>

const COMMITS_SHOWN = 6
const LISTED_COMMITS = 10
const BRANCHES_LISTED = 6
const RUNS_LISTED = 12

// A command that can't start (gh not installed, say) reads as a failed run, never a thrown hook.
const run = async (exec: Exec, argv: string[]): Promise<Ran> => {
  try {
    return await exec(argv)
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err) }
  }
}

const reason = (r: Ran, fallback: string): string => firstLine(r.stderr.trim()) || fallback

const LOG_FORMAT = '--format=%h%x1f%s%x1f%cr'

// What the Git tab shows, all of it read-only. `operation` and `fetchedAt` come from files in the git folder,
// which the hooks module reads.
export const collectGit = async (exec: Exec, now: number): Promise<GitSnapshot> => {
  const [status, numstat, log, unpushed, incoming, branches, worktrees, stash, gitDir] = await Promise.all([
    run(exec, ['git', 'status', '--porcelain=v2', '--branch']),
    run(exec, ['git', 'diff', '--numstat', 'HEAD']),
    run(exec, ['git', 'log', `-${COMMITS_SHOWN}`, LOG_FORMAT]),
    run(exec, ['git', 'log', `-${LISTED_COMMITS}`, LOG_FORMAT, '@{u}..HEAD']),
    run(exec, ['git', 'log', `-${LISTED_COMMITS}`, LOG_FORMAT, 'HEAD..@{u}']),
    run(exec, [
      'git', 'for-each-ref', '--sort=-committerdate', `--count=${BRANCHES_LISTED + 1}`,
      '--format=%(refname:short)%1f%(committerdate:relative)%1f%(upstream:track)', 'refs/heads',
    ]),
    run(exec, ['git', 'worktree', 'list', '--porcelain']),
    run(exec, ['git', 'stash', 'list', '--format=%gd%x1f%s']),
    run(exec, ['git', 'rev-parse', '--absolute-git-dir', '--show-toplevel']),
  ])
  const parsed = parseStatus(status.stdout)
  const stashList = parseStashes(stash.stdout)
  // With no upstream the two range logs fail; that reads as nothing to push or pull.
  const listed = (r: Ran) => (r.exitCode === 0 ? parseLog(r.stdout) : [])
  return {
    ...parsed,
    files: withNumstat(parsed.files, parseNumstat(numstat.stdout)),
    commits: parseLog(log.stdout),
    unpushed: listed(unpushed),
    incoming: listed(incoming),
    branches: parseBranches(branches.stdout, parsed.branch).slice(0, BRANCHES_LISTED),
    worktrees: parseWorktrees(worktrees.stdout),
    stashes: stashList.length,
    stashList,
    gitDir: gitDir.stdout.split('\n')[0]?.trim() ?? '',
    root: gitDir.stdout.split('\n')[1]?.trim() ?? '',
    operation: '',
    fetchedAt: 0,
    at: now,
    error: status.exitCode === 0 ? '' : reason(status, 'not a git repository'),
  }
}

// One file's diff against HEAD (staged and unstaged together), for the Git tab's preview. The path is git's, from
// the repository's top, which `:/` says whatever folder the session is in.
export const collectDiff = async (exec: Exec, path: string): Promise<string> => {
  const diff = await run(exec, ['git', 'diff', '--no-color', '--no-ext-diff', 'HEAD', '--', ':/' + path])
  return diff.exitCode === 0 ? diff.stdout : reason(diff, 'git could not diff the file')
}

// The open PR's checks for this branch; with no open PR, the Actions runs for the checked-out commit.
export const collectCi = async (exec: Exec, branch: string, head: string, now: number): Promise<CiSnapshot> => {
  // gh answers with the branch's newest PR, open or merged: its base is where the merge's own CI runs.
  const view = await run(exec, [
    'gh', 'pr', 'view', '--json',
    'number,title,url,baseRefName,isDraft,reviewDecision,state,mergeStateStatus,additions,deletions,changedFiles',
  ])
  const pr = view.exitCode === 0 ? parsePr(view.stdout) : null
  const base = pr && pr.base && pr.base !== branch ? await collectBase(exec, pr.base) : null
  if (pr && pr.state === 'OPEN') {
    const checks = await run(exec, ['gh', 'pr', 'checks', '--json', 'name,workflow,bucket,startedAt,completedAt,link'])
    // gh exits non-zero while checks fail or are pending, and still prints them.
    return { branch, head, pr, checks: parseChecks(checks.stdout), source: 'pr', base, at: now, error: '' }
  }
  const runs = await listRuns(exec, branch)
  return {
    branch,
    head,
    pr,
    checks: runs.exitCode === 0 ? parseRuns(runs.stdout, head) : [],
    source: 'runs',
    base,
    at: now,
    error: runs.exitCode === 0 ? '' : reason(runs, 'gh could not list runs'),
  }
}

const listRuns = (exec: Exec, branch: string) =>
  run(exec, [
    'gh', 'run', 'list', '--branch', branch, '--limit', String(RUNS_LISTED),
    '--json', 'workflowName,displayTitle,status,conclusion,createdAt,updatedAt,headSha,url',
  ])

// The newest commit's runs on the base branch.
const collectBase = async (exec: Exec, branch: string): Promise<BaseCi> => {
  const runs = await listRuns(exec, branch)
  return {
    branch,
    checks: runs.exitCode === 0 ? parseRuns(runs.stdout, '') : [],
    error: runs.exitCode === 0 ? '' : reason(runs, 'gh could not list runs'),
  }
}
