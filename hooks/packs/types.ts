import type { PackLayer } from '../../types'

// Schema 1 of a pack: data only. The host loads no code from outside the plugin, so every behaviour is an analyzer
// of the mod's own that a pack names by id. Built-in packs ship in hooks/packs/; user packs live in
// ~/.claude/ccinformer/packs/*.pack.jsonc. Packs are personal: nothing is read from inside a repo.

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
  noise?: NoiseRule[]
  plans?: PlanSpec
  // Ids from the built-in below that this pack switches off.
  disable?: string[]
}

// Every top-level key a pack may hold: any other key refuses the pack, so a typo or a removed field says so.
export const PACK_KEYS = ['schema', 'id', 'version', 'match', 'detect', 'extends', 'processes', 'environments', 'checks', 'budgets', 'noise', 'plans', 'disable'] as const

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
  | 'sarif'
  | 'problem-matcher'
  | 'tscn-connections'
  | 'tscn-nodepaths'
export type CheckCost = 'edit' | 'turn' | 'demand'
// A sarif or problem-matcher check runs the command its pack names (`bin`, the whole argv) once a turn ends; these
// placeholders in it are replaced by the engine. `{files}`, a list item on its own, at most once: the run's files
// (repo-relative, forward slashes, at most 40 a run); without it the command runs once over the whole project.
// `{output}`, inside any item, sarif only: the mod's own file the tool writes its results to. For eslint-json `bin`
// stays a prefix that gets ESLint's flags and the files appended.
export const FILES_SLOT = '{files}'
export const OUTPUT_SLOT = '{output}'
// A problem-matcher's `options.pattern`: one regex with named groups, tested per output line. The first three are
// required; `options.severity` is the severity when the pattern has no severity group or its word isn't known.
export const MATCHER_REQUIRED = ['file', 'line', 'message'] as const
export const MATCHER_GROUPS = ['file', 'line', 'message', 'column', 'severity', 'code'] as const
export const MATCHER_SEVERITIES = ['error', 'warn', 'info'] as const
export const MAX_PATTERN_CHARS = 300
export const MAX_TIMEOUT_MS = 600_000
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
  // `build` runs first when the person asks for a measurement (`m`); `freshAfter` is the file whose age says whether
  // the output measures the tree as it is now.
  | { kind: 'command'; argv: string[]; parse: string; scale?: number; freshAfter?: string; build?: string[] }
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

export type NoiseRule = { id: string; glob: string; kind: 'generated' | 'editor-rewrite'; normalize?: string[] }

// The patterns are optional here: a pack names only where its plans are, and the plan reader brings defaults.
export type PlanSpec = { globs: string[]; archiveDir?: string; checkpoint?: string; done?: string[]; prRef?: string; results?: { glob: string; index?: string } }

export type Layer = PackLayer

// The sections whose entries merge by id.
export const LIST_SECTIONS = ['processes', 'environments', 'checks', 'budgets', 'noise'] as const
export type ListSection = (typeof LIST_SECTIONS)[number]

// The pack a repo ends up with: the built-in and the user pack merged.
export type ResolvedPack = {
  id: string
  processes: ProcessMatcher[]
  environments: EnvRule[]
  checks: CheckSpec[]
  budgets: BudgetSpec[]
  noise: NoiseRule[]
  plans?: PlanSpec
}
