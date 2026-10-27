export type Tab = 'git' | 'agents' | 'sessions' | 'debug'
export type DebugView = 'tools' | 'requests' | 'context'

export type FileChange = { path: string; code: string; added: number; removed: number }
export type Commit = { sha: string; subject: string; age: string }
export type Worktree = { path: string; branch: string }
// Another local branch: how long since its last commit, and how it stands against its upstream ("↑2, ↓1").
export type Branch = { name: string; age: string; track: string }
export type GitSnapshot = {
  branch: string
  upstream: string
  head: string
  ahead: number
  behind: number
  files: FileChange[]
  commits: Commit[]
  // The commits a push would send, and those waiting on the upstream since the last fetch.
  unpushed: Commit[]
  incoming: Commit[]
  branches: Branch[]
  worktrees: Worktree[]
  stashes: number
  stashList: string[]
  // The git folder (a worktree has its own), what git is in the middle of ('' for nothing), and the last fetch.
  gitDir: string
  // The repository's top folder: the changed files' paths are from here.
  root: string
  operation: string
  fetchedAt: number
  at: number
  error: string
}
// The file the Git tab shows a diff of, and that diff.
export type DiffPreview = { path: string; text: string; isLoading: boolean }

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
export type CiCheck = { name: string; workflow: string; bucket: CheckBucket; startedAt: string; completedAt: string; link: string }
export type PullRequest = {
  number: number
  title: string
  url: string
  base: string
  isDraft: boolean
  state: string
  // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''.
  review: string
  // CLEAN, DIRTY (conflicts), BLOCKED, BEHIND, UNSTABLE, ... as GitHub says.
  mergeState: string
  additions: number
  deletions: number
  changedFiles: number
}
// The newest runs on the branch this one merges into (the PR's base).
export type BaseCi = { branch: string; checks: CiCheck[]; error: string }
export type CiSnapshot = {
  branch: string
  head: string
  pr: PullRequest | null
  checks: CiCheck[]
  source: 'pr' | 'runs'
  base: BaseCi | null
  at: number
  error: string
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'killed'
export type AgentRow = {
  id: string
  description: string
  type: string
  model: string
  status: AgentState
  startedAt: number
  endedAt: number
  toolUseId: string
  runId: string
  // The workflow phase the run's record puts it in; '' while only its label says.
  phase: string
  tools: number
  // Its latest request's context, as the workflow bar counts it.
  tokens: number
  // What it generated over all its requests (thinking, text, tool calls): what its time mostly goes to.
  output: number
}
export type WorkflowRun = {
  // The Workflow call that started it in this session, or `rec:<runId>` for a run read from its record.
  toolUseId: string
  runId: string
  name: string
  phases: string[]
  startedAt: number
  // `running` until the run's record says how it ended (completed, failed, killed).
  status: string
  endedAt: number
  // The record's own total, as the workflow bar shows it; 0 while running.
  totalTokens: number
  // The session that ran it, by the first 8 characters of its id; '' for this one.
  session: string
}

// One agent of a finished run, as the statistics count it.
export type AgentSample = { phase: string; family: string; ms: number; tokens: number; tools: number }
// A finished run's record, boiled down for the Stats view.
export type RunSummary = {
  runId: string
  name: string
  session: string
  startedAt: number
  ms: number
  tokens: number
  status: string
  phases: string[]
  // The phases that had agents: fewer than `phases` for a partial run, such as a re-check.
  phasesRan: string[]
  spans: { title: string; ms: number }[]
  agents: AgentSample[]
}
export type AgentsView = 'runs' | 'stats'

export type ToolOutcome ='running' | 'ok' | 'error' | 'denied'
export type ToolRow = { id: string; tool: string; summary: string; agent: string; startedAt: number; ms: number; outcome: ToolOutcome }
export type StepRow = {
  key: string
  model: string
  effort: string
  agent: string
  startedAt: number
  ms: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  stop: string
  // The session's context window when the request was made.
  window: number
}
export type Compaction = { at: number; trigger: string; before: number; after: number; agent: string }

// What each session running the mod says about itself, through the store all sessions share.
export type SessionBeat = {
  id: string
  cwd: string
  branch: string
  task: string
  isBusy: boolean
  model: string
  contextPercent: number
  startedAt: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    ccinformer: {
      tab: Tab
      debugView: DebugView
      // The workflow phase the Agents tab shows; '' follows the live one.
      phase: string
      // The run the Agents tab shows in full; '' shows the running one.
      run: string
      agentsView: AgentsView
      // The Git tab: whether it lists every changed file, and the diff it shows.
      showAllFiles: boolean
      diff: DiffPreview | null
      // The workflow the Stats view sums up; '' takes the one with the most runs.
      statsName: string
      stats: RunSummary[]
      isOpen: boolean
      // False while the session has been idle a while: git polling pauses.
      isActive: boolean
      now: number
      git: GitSnapshot | null
      ci: CiSnapshot | null
      agents: AgentRow[]
      runs: WorkflowRun[]
      tools: ToolRow[]
      steps: StepRow[]
      compactions: Compaction[]
      sessions: SessionBeat[]
    }
  }
}
