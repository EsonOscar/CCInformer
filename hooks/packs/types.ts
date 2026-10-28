import type { PackLayer } from '../../types'

// Schema 1 of a pack: data only. The host loads no code from outside the plugin, so every behaviour is an analyzer
// of the mod's own that a pack names by id. Built-in packs ship in hooks/packs/; user packs live in
// ~/.claude/ccinformer/packs/*.pack.jsonc; a repo adds values through .ccinformer.jsonc (RepoConfig below).

export type PackManifest = {
  schema: 1
  id: string
  version: string
  // User packs only: the repos it applies to, as globs over the remote's `host/owner/repo`.
  match?: { remote?: string[] }
  // Built-ins only: the marker files that pick it.
  detect?: DetectRule[]
  // Built-in ids this pack builds on.
  extends?: string[]
  processes?: ProcessMatcher[]
  environments?: EnvRule[]
  checks?: CheckSpec[]
  budgets?: BudgetSpec[]
  locks?: LockSpec[]
  noise?: NoiseRule[]
  signals?: SignalSpec[]
  plans?: PlanSpec
  preflight?: PreflightSpec
  claudeMd?: ClaudeMdRule[]
  // Ids from the layers below that this pack switches off.
  disable?: string[]
}

export type DetectRule = { file: string; contains?: string; weight: number; required?: boolean }

export type ProcessKind = 'dev' | 'test' | 'worker' | 'db' | 'editor' | 'game' | 'build' | 'batch'
export type ProcessMatcher = {
  id: string
  label: string
  // A regex over argv, after package scripts are resolved through package.json.
  match: string
  kind: ProcessKind
  // A heavy process arms the memory probe.
  heavy?: boolean
  envFrom?: { argRegex?: string; envFile?: string; envKey?: string }
  ramWarnMb?: number
}

export type Tone = 'local' | 'shared' | 'prod'
export type EnvRule = { id: string; label: string; tone: Tone; hostPatterns?: string[]; argRegex?: string; readOnly?: boolean; approvals?: ApprovalRule[] }
export type ApprovalRule = {
  id: string
  tool: string
  commandRegex?: string
  inputRegex?: string
  pathGlob?: string
  label: string
  mode?: 'ask' | 'log'
  scope: 'once' | 'session'
}

export type AnalyzerId =
  | 'regex-lines'
  | 'size-lines'
  | 'i18n-keysets'
  | 'eslint-json'
  | 'ruff-json'
  | 'mypy-text'
  | 'msbuild'
  | 'alembic-check'
  | 'pybabel-po'
  | 'tscn-connections'
  | 'tscn-nodepaths'
export type CheckCost = 'edit' | 'batch' | 'turn' | 'demand'
export type CheckSpec = {
  id: string
  label: string
  on: string[]
  analyzer: AnalyzerId
  cost: CheckCost
  class: 'ci' | 'advise'
  ignore?: string[]
  suppressions?: string
  timeoutMs?: number
  rules?: string[]
  options?: Record<string, string | number | string[]>
  bin?: string[]
}

export type Source =
  | { kind: 'json'; path: string; pointer: string }
  | { kind: 'command'; argv: string[]; parse: string; scale?: number; freshAfter?: string }
  | { kind: 'ci-log'; job: string; step: string; parse: string; scale?: number }
  | { kind: 'telemetry'; metric: string; stat: 'p95' | 'min' | 'max' | 'last' }
  | { kind: 'dir-size'; path: string }
  | { kind: 'file-lines'; path: string; parse: string; stat: 'p95' | 'max' | 'count' }
export type BudgetSpec = {
  id: string
  label: string
  unit: 'bytes' | 'ms' | 'fps' | 'mb' | 'count' | 'lines'
  direction: 'max' | 'min'
  limit: number | { relative: number; baseline: Source }
  sources: Source[]
  cost: 'cheap' | 'demand'
}

export type LockMode = 'exclusive' | 'warn'
export type LockSpec = { id: string; glob: string; mode: LockMode; reason: string; commandRegex?: string; enforce?: boolean }
export type NoiseRule = { id: string; glob: string; kind: 'generated' | 'editor-rewrite'; normalize?: string[] }

export type SignalSpec = {
  id: string
  kind: 'gh-runs' | 'gh-reviews' | 'sentry-issues' | 'sentry-vitals' | 'telemetry-file'
  jobs?: Record<string, { kind: 'deploy' | 'migration' | 'ci' | 'smoke'; env?: string }>
  sentry?: { baseUrl: string; org: string; project: string }
  path?: string
}

// The patterns are optional here: a repo names only where its plans are, and the plan reader brings defaults.
export type PlanSpec = { globs: string[]; archiveDir?: string; checkpoint?: string; done?: string[]; prRef?: string; results?: { glob: string; index?: string } }
export type PreflightSpec = { steps: ({ check: string } | { argv: string[] })[]; cacheBy: 'HEAD'; timeoutMs?: number; onPush?: 'warn' | 'ask' | 'off' }
export type ClaudeMdRule = { id: string; lineRegex: string; as: 'note' | 'value'; key?: string }

// What a repo may set in .ccinformer.jsonc (and .ccinformer.local.jsonc): values only, which add or tighten.
export type RepoConfig = {
  pack?: string
  budgets?: Record<string, { limit: number }>
  locks?: { exclusive?: string[]; warn?: string[] }
  envHosts?: { shared?: string[]; prod?: string[] }
  plans?: { globs?: string[]; archiveDir?: string }
}

export type Layer = PackLayer

// The sections whose entries merge by id.
export const LIST_SECTIONS = ['processes', 'environments', 'checks', 'budgets', 'locks', 'noise', 'signals', 'claudeMd'] as const
export type ListSection = (typeof LIST_SECTIONS)[number]

// The pack a repo ends up with: every layer merged, and which layer set each entry.
export type ResolvedPack = {
  id: string
  processes: ProcessMatcher[]
  environments: EnvRule[]
  checks: CheckSpec[]
  budgets: BudgetSpec[]
  locks: LockSpec[]
  noise: NoiseRule[]
  signals: SignalSpec[]
  claudeMd: ClaudeMdRule[]
  plans?: PlanSpec
  preflight?: PreflightSpec
}
