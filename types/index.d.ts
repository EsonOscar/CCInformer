// The pane's five areas, switched with 1-5; an area with nothing built yet isn't drawn.
export type Area = 'now' | 'code' | 'work' | 'timeline' | 'debug'
export type DebugView = 'tools' | 'requests' | 'context' | 'pack'

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
export type WorkView = 'runs' | 'stats'

// A process this session started (a Bash call, foreground or background) that the pack places in an
// environment. Only a short label is kept, never the command line or an env file's values.
export type EnvTone = 'local' | 'shared' | 'prod'
export type EnvTask = {
  // The background task's id once the call returns one; the call's tool_use_id until then.
  id: string
  toolUseId: string
  // The script or process it ran, e.g. `npm run dev:staging`.
  label: string
  envId: string
  envLabel: string
  tone: EnvTone
  isHeavy: boolean
  startedAt: number
}

// Now's views: what runs and where it points, and the other sessions.
export type NowView = 'env' | 'sessions'
// A process on this machine that a pack matcher knows, started by Claude or not. Only these fields are kept: never
// its command line.
export type MachineProcess = {
  matcherId: string
  label: string
  kind: string
  pid: number
  ramMb: number
  // The matcher's own warning level, 0 when it has none.
  ramWarnMb: number
  envLabel: string
  tone: EnvTone | ''
}
export type ProcessList = { list: MachineProcess[]; at: number; ms: number; error: string }
export type MemoryReading = { freeMb: number; totalMb: number; at: number; isLow: boolean }

// The pack this repo resolved to, as Debug › Pack shows it: each layer's file and how it went, every value with the
// layer that set it, and whether the repo's own tools may run.
export type PackLayer = 'built-in' | 'user' | 'repo' | 'local'
export type PackLayerRow = {
  layer: PackLayer
  source: string
  state: 'loaded' | 'absent' | 'refused' | 'broken' | 'skipped'
  note: string
  reasons: string[]
}
export type PackEntryRow = {
  section: string
  id: string
  label: string
  layer: PackLayer
  changedBy: PackLayer[]
  removedBy?: PackLayer
  needsTrust: boolean
}
export type PackTrust = { isTrusted: boolean; by: 'user pack' | 'you' | ''; at: number; isStale: boolean }
export type PackReport = {
  id: string
  root: string
  remote: string
  repoKey: string
  // SHA-256 of the repo's config files: a yes to trust holds for these exact files.
  hash: string
  layers: PackLayerRow[]
  entries: PackEntryRow[]
  trust: PackTrust
  at: number
}

// Code's views: git and CI, what the pack's checks found, and its budgets.
export type CodeView = 'git' | 'rules' | 'budgets'
// A budget's latest reading: the value (null when no source gave one), its limit (and the baseline a relative limit
// is a share of), which source it came from and when. `staleWhy` says why it doesn't measure what's in the tree now
// ('' when it does); `error` why there's no value.
export type BudgetReading = {
  id: string
  label: string
  unit: 'bytes' | 'ms' | 'fps' | 'mb' | 'count' | 'lines'
  direction: 'max' | 'min'
  value: number | null
  limit: number | null
  baseline: number | null
  from: 'json' | 'command' | 'ci-log' | 'telemetry' | 'dir-size' | 'file-lines' | ''
  at: number
  staleWhy: string
  error: string
}
// The budgets as Code › Budgets shows them, and what the gauge is doing now ('' for nothing): reading the sources,
// or building first after `m`.
export type BudgetState = { readings: BudgetReading[]; doing: string; at: number; error: string }
// Something a check found in a file: a file over its size limit, a lint error, a suppression nothing needs any more.
// `ci` is a rule the repo's CI enforces, `advise` one only the project asks for; `ciWouldFail` says pushing the file
// as it is fails CI. `line` is 0 for a finding about the whole file.
export type Finding = {
  id: string
  check: string
  file: string
  line: number
  rule: string
  severity: 'error' | 'warn' | 'info'
  class: 'ci' | 'advise'
  message: string
  ciWouldFail: boolean
}
// The latest run of a check that runs the repo's own tools after a turn: over how many files, how long it took, and
// what went wrong ('' for nothing). `waitsForTrust` while the repo's tools may not run yet.
export type CheckRun = { check: string; label: string; at: number; ms: number; files: number; isRunning: boolean; waitsForTrust: boolean; error: string }

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
      area: Area
      debugView: DebugView
      workView: WorkView
      // Each area's selected row, '' for none: Work's run shown in full ('' shows the running one), Code's file
      // whose diff shows. Per-row actions act on it.
      selected: Record<Area, string>
      // The workflow phase Work shows; '' follows the live one.
      phase: string
      pack: PackReport | null
      // The processes this session started that target an environment; the band shows the shared and prod ones.
      envTasks: EnvTask[]
      nowView: NowView
      // The pack's processes on this machine, read while Now › Env shows; free memory, read with them and while a
      // heavy task of this session runs.
      processes: ProcessList | null
      memory: MemoryReading | null
      codeView: CodeView
      // What the pack's checks found, newest run per check and file; the ids the person dismissed this session; the
      // latest run of a check that runs the repo's own tools.
      findings: Finding[]
      dismissed: string[]
      checkRun: CheckRun | null
      budgets: BudgetState | null
      // Code's Git view: whether it lists every changed file, and the diff it shows.
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
