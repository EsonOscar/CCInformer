import { BUILTINS } from './builtins'
import {
  ANALYZERS,
  APPROVAL_MODES,
  APPROVAL_SCOPES,
  BUDGET_COSTS,
  CHECK_COSTS,
  CLASSES,
  DIRECTIONS,
  FILE_LINES_STATS,
  FILES_SLOT,
  LIST_SECTIONS,
  MATCHER_GROUPS,
  MATCHER_REQUIRED,
  MATCHER_SEVERITIES,
  MAX_PATTERN_CHARS,
  MAX_TIMEOUT_MS,
  NOISE_KINDS,
  OUTPUT_SLOT,
  PACK_KEYS,
  PROCESS_KINDS,
  SOURCE_KINDS,
  TELEMETRY_STATS,
  TONES,
  UNITS,
} from './types'
import type { AnalyzerId, ApprovalRule, BudgetSpec, CheckSpec, DetectRule, EnvRule, ListSection, NoiseRule, PackManifest, PlanSpec, ProcessMatcher, Source } from './types'

// What a file came to: the value when it's valid, or every reason it isn't. A file with any reason is not used.
export type Checked<T> = { value: T; reasons: [] } | { value?: undefined; reasons: string[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

// What a field holds: a string, a list of strings, a number above 0, true or false, one value of a list, or a shape
// checked on its own ('any').
type FieldKind = 'string' | 'strings' | 'positive' | 'boolean' | 'any' | readonly string[]
// The keys a type may not leave out, so a list of them can be typed against the type itself.
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T]
type SourceOf<K extends Source['kind']> = Extract<Source, { kind: K }>

// Each entry's fields, typed against its TS type: a key added to the type and not here (or the other way) fails tsc.
const PROCESS_SHAPE = { id: 'string', label: 'string', match: 'string', kind: PROCESS_KINDS, heavy: 'boolean', envFrom: 'any', ramWarnMb: 'positive' } satisfies Record<keyof ProcessMatcher, FieldKind>
const PROCESS_REQUIRED = { id: true, label: true, match: true, kind: true } satisfies Record<RequiredKeys<ProcessMatcher>, true>
const ENV_FROM_SHAPE = { argRegex: 'string', envFile: 'string', envKey: 'string' } satisfies Record<keyof NonNullable<ProcessMatcher['envFrom']>, FieldKind>
const ENV_SHAPE = { id: 'string', label: 'string', tone: TONES, hostPatterns: 'strings', argRegex: 'string', readOnly: 'boolean', approvals: 'any' } satisfies Record<keyof EnvRule, FieldKind>
const ENV_REQUIRED = { id: true, label: true, tone: true } satisfies Record<RequiredKeys<EnvRule>, true>
const APPROVAL_SHAPE = {
  id: 'string',
  tool: 'string',
  commandRegex: 'string',
  inputRegex: 'string',
  pathGlob: 'string',
  label: 'string',
  mode: APPROVAL_MODES,
  scope: APPROVAL_SCOPES,
} satisfies Record<keyof ApprovalRule, FieldKind>
const APPROVAL_REQUIRED = { id: true, tool: true, label: true, scope: true } satisfies Record<RequiredKeys<ApprovalRule>, true>
const CHECK_SHAPE = {
  id: 'string',
  label: 'string',
  on: 'strings',
  analyzer: ANALYZERS,
  cost: CHECK_COSTS,
  class: CLASSES,
  ignore: 'strings',
  suppressions: 'string',
  timeoutMs: 'any',
  rules: 'strings',
  options: 'any',
  bin: 'any',
} satisfies Record<keyof CheckSpec, FieldKind>
const CHECK_REQUIRED = { id: true, label: true, on: true, analyzer: true, cost: true, class: true } satisfies Record<RequiredKeys<CheckSpec>, true>
const BUDGET_SHAPE = { id: 'string', label: 'string', unit: UNITS, direction: DIRECTIONS, limit: 'any', sources: 'any', cost: BUDGET_COSTS } satisfies Record<keyof BudgetSpec, FieldKind>
const BUDGET_REQUIRED = { id: true, label: true, unit: true, direction: true, limit: true, sources: true, cost: true } satisfies Record<RequiredKeys<BudgetSpec>, true>
const SOURCE_SHAPES = {
  json: { kind: 'string', path: 'string', pointer: 'string' } satisfies Record<keyof SourceOf<'json'>, FieldKind>,
  command: { kind: 'string', argv: 'strings', parse: 'string', scale: 'positive', freshAfter: 'string', build: 'strings' } satisfies Record<keyof SourceOf<'command'>, FieldKind>,
  'ci-log': { kind: 'string', job: 'string', step: 'string', parse: 'string', scale: 'positive' } satisfies Record<keyof SourceOf<'ci-log'>, FieldKind>,
  telemetry: { kind: 'string', metric: 'string', stat: TELEMETRY_STATS } satisfies Record<keyof SourceOf<'telemetry'>, FieldKind>,
  'dir-size': { kind: 'string', path: 'string' } satisfies Record<keyof SourceOf<'dir-size'>, FieldKind>,
  'file-lines': { kind: 'string', path: 'string', parse: 'string', stat: FILE_LINES_STATS } satisfies Record<keyof SourceOf<'file-lines'>, FieldKind>,
} satisfies Record<Source['kind'], Record<string, FieldKind>>
const SOURCE_REQUIRED = {
  json: { kind: true, path: true, pointer: true } satisfies Record<RequiredKeys<SourceOf<'json'>>, true>,
  command: { kind: true, argv: true, parse: true } satisfies Record<RequiredKeys<SourceOf<'command'>>, true>,
  'ci-log': { kind: true, job: true, step: true, parse: true } satisfies Record<RequiredKeys<SourceOf<'ci-log'>>, true>,
  telemetry: { kind: true, metric: true, stat: true } satisfies Record<RequiredKeys<SourceOf<'telemetry'>>, true>,
  'dir-size': { kind: true, path: true } satisfies Record<RequiredKeys<SourceOf<'dir-size'>>, true>,
  'file-lines': { kind: true, path: true, parse: true, stat: true } satisfies Record<RequiredKeys<SourceOf<'file-lines'>>, true>,
} satisfies Record<Source['kind'], Record<string, true>>
const NOISE_SHAPE = { id: 'string', glob: 'string', kind: NOISE_KINDS, normalize: 'strings' } satisfies Record<keyof NoiseRule, FieldKind>
const NOISE_REQUIRED = { id: true, glob: true, kind: true } satisfies Record<RequiredKeys<NoiseRule>, true>
const PLANS_SHAPE = { globs: 'strings', archiveDir: 'string', checkpoint: 'string', done: 'strings', prRef: 'string', results: 'any' } satisfies Record<keyof PlanSpec, FieldKind>
const RESULTS_SHAPE = { glob: 'string', index: 'string' } satisfies Record<keyof NonNullable<PlanSpec['results']>, FieldKind>
const DETECT_SHAPE = { file: 'string', contains: 'string', weight: 'positive', required: 'boolean' } satisfies Record<keyof DetectRule, FieldKind>
const DETECT_REQUIRED = { file: true, weight: true } satisfies Record<RequiredKeys<DetectRule>, true>

// The list sections: what an entry is called in a reason, and its fields.
const SECTIONS: Record<ListSection, { name: string; shape: Record<string, FieldKind>; required: Record<string, true> }> = {
  processes: { name: 'process', shape: PROCESS_SHAPE, required: PROCESS_REQUIRED },
  environments: { name: 'environment', shape: ENV_SHAPE, required: ENV_REQUIRED },
  checks: { name: 'check', shape: CHECK_SHAPE, required: CHECK_REQUIRED },
  budgets: { name: 'budget', shape: BUDGET_SHAPE, required: BUDGET_REQUIRED },
  noise: { name: 'noise', shape: NOISE_SHAPE, required: NOISE_REQUIRED },
}

// The options each analyzer reads (hooks/checks); any other key is a typo the analyzer would ignore.
const OPTION_KEYS: Record<AnalyzerId, string[]> = {
  'size-lines': ['max'],
  'regex-lines': ['pattern', 'message'],
  'i18n-keysets': ['languages'],
  'problem-matcher': ['pattern', 'severity'],
  'eslint-json': [],
  sarif: [],
  'tscn-connections': [],
  'tscn-nodepaths': [],
}

// What a missing required field is for, where its kind alone wouldn't say.
const NEEDS: Record<string, string> = {
  label: ', the name the pane shows',
  class: ': "ci" when the repo\'s CI fails on it, else "advise"',
  on: ', the files it covers as globs, e.g. ["src/**/*.ts"]',
  match: ', a regex over the command line, e.g. "\\\\bvite\\\\b"',
  limit: ', a number above 0 or { "relative": 1.05, "baseline": <a source> }',
  baseline: ', the source of the value the limit is a share of, e.g. { "kind": "json", "path": "<baseline>.json", "pointer": "/size" }',
  sources: ', where its value is read, e.g. [{ "kind": "json", "path": "<file>", "pointer": "/size" }]',
  argv: ', the command as a list, e.g. ["node", "tools/report.mjs"]',
}

const describe = (kind: FieldKind): string =>
  typeof kind !== 'string'
    ? `one of ${kind.join(', ')}`
    : kind === 'string'
      ? 'a string'
      : kind === 'strings'
        ? 'a list of strings'
        : kind === 'positive'
          ? 'a number above 0'
          : kind === 'boolean'
            ? 'true or false'
            : 'set'

const fits = (value: unknown, kind: FieldKind): boolean =>
  typeof kind !== 'string'
    ? kind.includes(value as string)
    : kind === 'string'
      ? typeof value === 'string'
      : kind === 'strings'
        ? isStrings(value)
        : kind === 'positive'
          ? typeof value === 'number' && Number.isFinite(value) && value > 0
          : kind === 'boolean'
            ? typeof value === 'boolean'
            : true

// One object against its shape: no key it doesn't take, every required key there, each value of its kind. `where`
// names the entry; `path` the object inside it (`envFrom.`), empty for the entry itself.
const checkShape = (where: string, obj: Record<string, unknown>, shape: Record<string, FieldKind>, required: Record<string, true>, path = ''): string[] => {
  const reasons: string[] = []
  const keys = Object.keys(shape)
  const takes = keys.length ? keys.join(', ') : 'none'
  for (const key of Object.keys(obj))
    if (!keys.includes(key)) reasons.push(path ? `${where}: "${path.slice(0, -1)}" has "${key}"; it takes ${takes}` : `${where} has "${key}"; it takes ${takes}`)
  for (const key of Object.keys(required)) if (obj[key] === undefined) reasons.push(`${where} needs "${path}${key}"${NEEDS[key] ?? ` (${describe(shape[key]!)})`}`)
  for (const [key, kind] of Object.entries(shape))
    if (obj[key] !== undefined && !fits(obj[key], kind)) reasons.push(`${where}: "${path}${key}" must be ${describe(kind)}`)
  return reasons
}

// The built-in a user pack builds on: the first id in its `extends` that is one, as resolve.ts picks it.
const baseOf = (value: Record<string, unknown>): PackManifest | undefined =>
  isStrings(value.extends) ? value.extends.map(id => BUILTINS.find(b => b.id === id)).find(Boolean) : undefined

// A list section's entries as the merge sees them: each merged over the same-id entry of the built-in it builds on.
const mergedEntries = (section: ListSection, list: unknown, base: PackManifest | undefined): Record<string, unknown>[] =>
  (Array.isArray(list) ? list : []).filter(isObject).map(entry => {
    const under = (base?.[section] as { id: string }[] | undefined)?.find(b => b.id === entry.id)
    return under ? { ...under, ...entry } : entry
  })

// The engine's message when a pattern doesn't compile with these flags, else null.
export const compileError = (pattern: string, flags?: string): string | null => {
  try {
    new RegExp(pattern, flags)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// A built-in or user pack: its keys, its shape, its ids, and every regex it holds. A user pack's entry with the id of
// an entry in the built-in it extends is checked merged over that entry, as the merge reads it, so it may name only
// the fields it changes.
export const checkPack = (value: unknown, layer: 'built-in' | 'user'): Checked<PackManifest> => {
  if (!isObject(value)) return { reasons: ['is not an object; a pack is one JSON object, { "schema": 1, "id": ..., "version": "1", ... }'] }
  const reasons: string[] = []
  const builtinIds = BUILTINS.map(b => b.id).join(', ')
  for (const key of Object.keys(value))
    if (!(PACK_KEYS as readonly string[]).includes(key)) reasons.push(`"${key}" isn't a pack setting (it takes ${PACK_KEYS.join(', ')})`)
  if (value.schema !== 1) reasons.push('needs "schema": 1')
  if (typeof value.id !== 'string' || !value.id) reasons.push('needs an "id", a short name such as "acme-shop"')
  if (typeof value.version !== 'string') reasons.push('needs a "version", a string such as "1"')
  if (layer === 'user' && value.detect !== undefined) reasons.push('"detect" is for built-in packs; a user pack is picked by "match.remote"')
  if (layer === 'built-in' && value.match !== undefined) reasons.push('"match" is for user packs; a built-in is picked by "detect"')
  if (layer === 'user') reasons.push(...checkMatch(value.match))
  if (layer === 'built-in') reasons.push(...checkDetect(value.detect))
  if (value.extends !== undefined && !isStrings(value.extends)) reasons.push(`"extends" must be a list of built-in ids (the built-ins: ${builtinIds})`)
  else for (const id of (value.extends as string[] | undefined) ?? []) if (!BUILTINS.some(b => b.id === id)) reasons.push(`extends "${id}", which isn't a built-in (the built-ins: ${builtinIds})`)
  if (value.disable !== undefined && !isStrings(value.disable)) reasons.push('"disable" must be a list of entry ids to switch off, such as ["playwright"]')

  const base = layer === 'user' ? baseOf(value) : undefined
  const merged: Record<string, unknown> = { ...value }
  for (const section of LIST_SECTIONS) {
    reasons.push(...checkList(section, value[section]))
    const { name, shape, required } = SECTIONS[section]
    const entries = mergedEntries(section, value[section], base)
    merged[section] = entries
    for (const entry of entries.filter(e => typeof e.id === 'string' && e.id)) {
      const where = `${name} ${String(entry.id)}`
      const entryReasons = checkShape(where, entry, shape, required)
      reasons.push(...entryReasons)
      const isMissing = Object.keys(required).some(k => entry[k] === undefined)
      const owner = BUILTINS.find(b => (b[section] as { id: string }[] | undefined)?.some(e => e.id === entry.id))
      if (layer === 'user' && isMissing && owner && owner !== base)
        reasons.push(`${where} is also in ${owner.id}; to change only some of its fields, add "extends": ["${owner.id}"]`)
    }
  }
  for (const env of merged.environments as Record<string, unknown>[]) {
    if (env.approvals === undefined) continue
    reasons.push(...checkList('environments.' + String(env.id) + '.approvals', env.approvals))
    for (const a of Array.isArray(env.approvals) ? env.approvals.filter(isObject) : [])
      if (typeof a.id === 'string' && a.id) reasons.push(...checkShape(`approval ${a.id}`, a, APPROVAL_SHAPE, APPROVAL_REQUIRED))
  }
  for (const p of merged.processes as Record<string, unknown>[])
    if (p.envFrom !== undefined)
      reasons.push(...(isObject(p.envFrom) ? checkShape(`process ${String(p.id)}`, p.envFrom, ENV_FROM_SHAPE, {}, 'envFrom.') : [`process ${String(p.id)}: "envFrom" must be an object such as { "argRegex": "--mode[= ](\\\\S+)", "envFile": ".env.{mode}" }`]))
  for (const c of merged.checks as Record<string, unknown>[]) reasons.push(...checkCheck(c))
  for (const b of merged.budgets as Record<string, unknown>[]) reasons.push(...checkBudget(b))
  if (value.plans !== undefined) reasons.push(...checkPlans(value.plans))
  reasons.push(...regexReasons(merged))
  return reasons.length ? { reasons } : { value: value as PackManifest, reasons: [] }
}

// A user pack's `match`: only `remote`, globs over the remote's host/owner/repo, at least one.
const checkMatch = (match: unknown): string[] => {
  const needs = 'needs "match.remote", globs over host/owner/repo such as ["github.com/<owner>/<repo>"]'
  if (match === undefined) return [needs]
  if (!isObject(match)) return ['"match" must be an object, { "remote": ["github.com/<owner>/<repo>"] }']
  const reasons = checkShape('"match"', match, { remote: 'strings' }, {})
  if (match.remote === undefined || (isStrings(match.remote) && !match.remote.length)) reasons.push(needs)
  return reasons
}

// A built-in's `detect`: marker files inside the repo, with a weight, at least one of them required, so the built-in
// applies only where its stack is.
const checkDetect = (detect: unknown): string[] => {
  if (!Array.isArray(detect) || !detect.length) return ['needs "detect", the marker files that pick it, e.g. [{ "file": "package.json", "contains": "\\"vite\\"", "weight": 2, "required": true }]']
  const reasons: string[] = []
  detect.forEach((rule, i) => {
    const where = `detect rule ${i + 1}`
    if (!isObject(rule)) return reasons.push(`${where} must be an object, { "file": "<file>", "weight": 1 }`)
    reasons.push(...checkShape(where, rule, DETECT_SHAPE, DETECT_REQUIRED))
    if (typeof rule.file === 'string' && (/^([a-z]:|[\\/])/i.test(rule.file) || rule.file.split(/[\\/]/).includes('..')))
      reasons.push(`${where}: "file" must be a path inside the repo, such as "package.json"`)
  })
  if (!detect.some(r => isObject(r) && r.required === true)) reasons.push('"detect" needs one rule with "required": true, so the built-in applies only where its stack is')
  return reasons
}

// One check, as merged: what its analyzer needs, the options it reads, and a bounded timeout.
const checkCheck = (c: Record<string, unknown>): string[] => {
  const reasons: string[] = []
  const id = String(c.id)
  if (c.analyzer === 'regex-lines') reasons.push(...checkRegexLines(c))
  if (c.analyzer === 'size-lines') reasons.push(...checkSizeLines(c))
  if (c.analyzer === 'i18n-keysets') reasons.push(...checkKeysets(c))
  if (c.analyzer === 'tscn-connections' || c.analyzer === 'tscn-nodepaths') reasons.push(...checkTscn(c))
  if (c.analyzer === 'sarif' || c.analyzer === 'problem-matcher') reasons.push(...checkCommand(c))
  if (c.analyzer === 'problem-matcher') reasons.push(...checkMatcher(c))
  if (c.analyzer === 'eslint-json') reasons.push(...checkEslintBin(c))
  if (c.options !== undefined && !isObject(c.options)) reasons.push(`check ${id}: "options" must be an object`)
  const takes = OPTION_KEYS[c.analyzer as AnalyzerId]
  if (takes && isObject(c.options))
    for (const key of Object.keys(c.options))
      if (!takes.includes(key)) reasons.push(`check ${id}: "options" has "${key}"; ${/^[aeiou]/.test(String(c.analyzer)) ? 'an' : 'a'} ${String(c.analyzer)} check takes ${takes.length ? takes.join(', ') : 'no options'}`)
  if (c.bin !== undefined && !isStrings(c.bin) && c.analyzer === 'eslint-json') reasons.push(`check ${id}: "bin" must be a list of strings`)
  const timeout = c.timeoutMs
  if (timeout !== undefined && !(Number.isInteger(timeout) && (timeout as number) > 0 && (timeout as number) <= MAX_TIMEOUT_MS))
    reasons.push(`check ${id}: "timeoutMs" must be a whole number of milliseconds, from 1 to ${MAX_TIMEOUT_MS}`)
  return reasons
}

// A size-lines check counts a written file's lines against `options.max`; without it the check checks nothing.
const checkSizeLines = (c: Record<string, unknown>): string[] => {
  const max = isObject(c.options) ? c.options.max : undefined
  return Number.isInteger(max) && (max as number) > 0 ? [] : [`check ${String(c.id)}: needs "options.max", a whole number of lines (e.g. 500)`]
}

// A budget: its limit, and the sources its value is read from, each by its kind.
const checkBudget = (b: Record<string, unknown>): string[] => {
  const where = `budget ${String(b.id)}`
  const reasons: string[] = []
  const limit = b.limit
  if (isObject(limit)) {
    reasons.push(...checkShape(where, limit, { relative: 'positive', baseline: 'any' }, { relative: true, baseline: true }, 'limit.'))
    if (limit.baseline !== undefined) reasons.push(...checkSource(where, limit.baseline, 'limit.baseline'))
  } else if (limit !== undefined && !fits(limit, 'positive')) reasons.push(`${where}: "limit" must be a number above 0 or { "relative": 1.05, "baseline": <a source> }`)
  if (b.sources !== undefined) {
    if (!Array.isArray(b.sources) || !b.sources.length) reasons.push(`${where}: "sources" needs at least one source${NEEDS.sources}`)
    else b.sources.forEach((s, i) => reasons.push(...checkSource(where, s, `sources[${i}]`)))
  }
  return reasons
}

// A source of a budget's value: a known kind, and that kind's fields.
const checkSource = (where: string, source: unknown, path: string): string[] => {
  if (!isObject(source)) return [`${where}: "${path}" must be an object, { "kind": "<kind>", ... }`]
  const kind = source.kind as Source['kind']
  if (!(SOURCE_KINDS as readonly unknown[]).includes(kind)) return [`${where}: "${path}.kind" must be one of ${SOURCE_KINDS.join(', ')}`]
  const reasons = checkShape(where, source, SOURCE_SHAPES[kind], SOURCE_REQUIRED[kind], path + '.')
  if (kind === 'json' && typeof source.pointer === 'string' && !source.pointer.startsWith('/'))
    reasons.push(`${where}: "${path}.pointer" must start with "/", a JSON pointer such as "/start/brotli"`)
  if (kind === 'command' && isStrings(source.argv) && !source.argv.length) reasons.push(`${where}: "${path}.argv" needs the program to run first${NEEDS.argv}`)
  return reasons
}

// `plans`: where the plan files are (at least one glob) and the patterns that read them.
const checkPlans = (plans: unknown): string[] => {
  if (!isObject(plans)) return ['"plans" must be an object, { "globs": [".local/*.md"] }']
  const reasons = checkShape('"plans"', plans, PLANS_SHAPE, {})
  if (plans.globs === undefined || (isStrings(plans.globs) && !plans.globs.length)) reasons.push('"plans" needs "globs", the plan files as globs, e.g. [".local/*.md"]')
  if (plans.results !== undefined)
    reasons.push(...(isObject(plans.results) ? checkShape('"plans"', plans.results, RESULTS_SHAPE, { glob: true }, 'results.') : ['"plans": "results" must be an object, { "glob": "<results>" }']))
  return reasons
}

// A regex-lines check runs on each write, inside the mod: its pattern must be there and compile.
const checkRegexLines = (c: Record<string, unknown>): string[] => {
  const options = isObject(c.options) ? c.options : {}
  const reasons: string[] = []
  if (c.cost !== 'edit') reasons.push(`check ${String(c.id)}: a regex-lines check runs on each write, so its cost must be "edit"`)
  if (typeof options.pattern !== 'string' || !options.pattern) reasons.push(`check ${String(c.id)}: needs "options.pattern", the regex each line is tested against`)
  if (options.message !== undefined && typeof options.message !== 'string') reasons.push(`check ${String(c.id)}: "options.message" must be a string`)
  return reasons
}

// An i18n-keysets check compares whole tables once a turn's writes are done: its cost is "turn", and it names the
// languages every table must carry.
const checkKeysets = (c: Record<string, unknown>): string[] => {
  const options = isObject(c.options) ? c.options : {}
  const reasons: string[] = []
  if (c.cost !== 'turn') reasons.push(`check ${String(c.id)}: an i18n-keysets check runs once a turn ends, so its cost must be "turn"`)
  if (!isStrings(options.languages) || !options.languages.length || options.languages.some(l => !l))
    reasons.push(`check ${String(c.id)}: needs "options.languages", the languages every table must have (e.g. ["da", "en", "sv"])`)
  return reasons
}

// A tscn-connections or tscn-nodepaths check compares a Godot repo's scenes and C# scripts inside the mod once a turn's
// writes are done: its cost is "turn", and it runs no command, so it takes no command fields.
const checkTscn = (c: Record<string, unknown>): string[] => {
  const reasons: string[] = []
  const id = String(c.id)
  const analyzer = String(c.analyzer)
  if (c.cost !== 'turn') reasons.push(`check ${id}: a ${analyzer} check compares scenes and scripts once a turn ends, so its cost must be "turn"`)
  for (const key of ['bin', 'suppressions', 'timeoutMs'])
    if (c[key] !== undefined) reasons.push(`check ${id}: a ${analyzer} check compares files inside the mod, so it takes no "${key}"`)
  return reasons
}

// A sarif or problem-matcher check runs the command its pack names once a turn ends, through the heavy lane: its
// cost is "turn", `bin` is the whole command with the program first, `{files}` is a list item on its own (once) and
// `{output}` belongs to sarif checks.
const EXAMPLE_BIN: Record<string, string> = {
  sarif: '["ruff", "check", "--output-format", "sarif", "{files}"]',
  'problem-matcher': '["gcc", "-fsyntax-only", "{files}"]',
}
const checkCommand = (c: Record<string, unknown>): string[] => {
  const id = String(c.id)
  const analyzer = String(c.analyzer)
  const reasons: string[] = []
  if (c.cost !== 'turn') reasons.push(`check ${id}: a ${analyzer} check runs the repo's tool once a turn ends, so its cost must be "turn"`)
  const bin = c.bin
  if (!isStrings(bin) || !bin.length || !bin[0]) {
    reasons.push(`check ${id}: needs "bin", the command to run as a list (e.g. ${EXAMPLE_BIN[analyzer]})`)
  } else {
    if (bin[0] === FILES_SLOT || bin[0].includes(OUTPUT_SLOT))
      reasons.push(`check ${id}: "bin"'s first item is the program to run; "${FILES_SLOT}" and "${OUTPUT_SLOT}" can't be it`)
    const slots = bin.filter(a => a.includes(FILES_SLOT))
    if (slots.length > 1 || slots.some(a => a !== FILES_SLOT))
      reasons.push(`check ${id}: "${FILES_SLOT}" must be a list item on its own, at most once; it's replaced by the files to check`)
    if (analyzer === 'problem-matcher' && bin.some(a => a.includes(OUTPUT_SLOT)))
      reasons.push(`check ${id}: "${OUTPUT_SLOT}" is for sarif checks; a problem-matcher check reads the command's output`)
  }
  return reasons
}

// An eslint-json check gets its files appended by the engine, so the placeholders have no place in its bin.
const checkEslintBin = (c: Record<string, unknown>): string[] =>
  isStrings(c.bin) && c.bin.some(a => a.includes(FILES_SLOT) || a.includes(OUTPUT_SLOT))
    ? [`check ${String(c.id)}: an eslint-json check gets its files appended; drop "${FILES_SLOT}" and "${OUTPUT_SLOT}" from "bin"`]
    : []

// The named groups a pattern defines: JS lists every one as a key of `groups`, matched or not, so an alternative
// that matches the empty string reaches them all.
export const groupsOf = (pattern: string): string[] => Object.keys(new RegExp('(?:' + pattern + ')|').exec('')?.groups ?? {})

// A walk over a pattern's text, outside its escapes and character classes: whether a group that repeats or branches
// is itself repeated (`(\w+)+`, `(a|b)+`: exponential on a line that almost matches), and how many unbounded
// wildcards it holds (`.*`, `.+`: polynomial where they overlap). A heuristic, not a proof: JS has no regex timeout.
export const scanPattern = (pattern: string): { repeatsRepeat: boolean; wildcards: number } => {
  const frames: { hasRepeat: boolean; hasAlt: boolean }[] = []
  let repeatsRepeat = false
  let wildcards = 0
  const isUnbounded = (i: number) => pattern[i] === '+' || pattern[i] === '*' || (pattern[i] === '{' && /^\{\d+,\}/.test(pattern.slice(i)))
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') {
      for (i++; i < pattern.length && pattern[i] !== ']'; i++) if (pattern[i] === '\\') i++
      continue
    }
    if (c === '(') {
      frames.push({ hasRepeat: false, hasAlt: false })
      continue
    }
    const top = frames[frames.length - 1]
    if (c === ')') {
      const frame = frames.pop()
      const next = pattern[i + 1]
      const isQuantified = next === '+' || next === '*' || next === '{'
      if (frame && isQuantified && (frame.hasRepeat || frame.hasAlt)) repeatsRepeat = true
      if (isQuantified && frames.length) frames[frames.length - 1]!.hasRepeat = true
      continue
    }
    if (c === '|' && top) top.hasAlt = true
    if (c === '.' && (pattern[i + 1] === '*' || pattern[i + 1] === '+')) wildcards++
    if (isUnbounded(i) && top) top.hasRepeat = true
  }
  return { repeatsRepeat, wildcards }
}

// A problem-matcher's pattern: present, compiling, short, with the required groups and no unknown one, and not of a
// shape that can hang on a long line.
const checkMatcher = (c: Record<string, unknown>): string[] => {
  const id = String(c.id)
  const reasons: string[] = []
  const options = isObject(c.options) ? c.options : {}
  const pattern = options.pattern
  if (typeof pattern !== 'string' || !pattern) reasons.push(`check ${id}: needs "options.pattern", the regex each output line is tested against`)
  else if (compileError(pattern) === null) {
    const groups = groupsOf(pattern)
    const missing = MATCHER_REQUIRED.filter(g => !groups.includes(g))
    if (missing.length)
      reasons.push(`check ${id}: "options.pattern" needs the named groups file, line and message (missing: ${missing.join(', ')}), e.g. (?<file>[^:]+):(?<line>\\d+): (?<message>.*)`)
    for (const g of groups)
      if (!(MATCHER_GROUPS as readonly string[]).includes(g)) reasons.push(`check ${id}: "options.pattern" has a group "${g}"; the groups are file, line, column, severity, code and message`)
  }
  if (options.severity !== undefined && !(MATCHER_SEVERITIES as readonly unknown[]).includes(options.severity))
    reasons.push(`check ${id}: "options.severity" must be "error", "warn" or "info"`)
  return reasons
}

// A list section: entries are objects with a unique id.
const checkList = (section: string, list: unknown): string[] => {
  if (list === undefined) return []
  if (!Array.isArray(list)) return [`"${section}" must be a list of entries, [{ "id": "<id>", ... }]`]
  const reasons: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) {
      reasons.push(`"${section}" has an entry without an "id"; give each entry its own "id"`)
      continue
    }
    if (seen.has(entry.id)) reasons.push(`"${section}" has "${entry.id}" twice; give each entry its own "id"`)
    seen.add(entry.id)
  }
  return reasons
}

// What a regex field's reader needs beyond a pattern that compiles: the capture groups it reads (with an example of
// one, as written in JSONC), the flags it compiles with, how it wraps the pattern, and whether the Windows process
// query also runs it in .NET.
type RegexNeed = { groups?: number; example?: string; flags?: string; wrap?: (pattern: string) => string; isDotnet?: boolean }

// A control character other than tab. In JSONC "\b" is a backspace, not a word boundary, so a pattern that lost one
// backslash still compiles and never matches.
const CONTROL = /[\u0000-\u0008\u000a-\u001f]/

const groupCount = (pattern: string): number => (new RegExp(pattern + '|').exec('')?.length ?? 1) - 1

// One regex a pack holds, checked the way its reader uses it. Every reason says what to change.
export const checkRegex = (where: string, field: string, pattern: unknown, need: RegexNeed = {}): string[] => {
  if (typeof pattern !== 'string') return []
  const at = `${where}: "${field}"`
  const control = pattern.match(CONTROL)?.[0]
  if (control !== undefined) {
    const code = 'U+' + control.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
    return [`${at} holds a control character (${code}); in JSONC write a word boundary as "\\\\b" and every backslash twice`]
  }
  // On its own and as its reader wraps it: a class left open can swallow the wrapper's own brackets and compile.
  const error = compileError(pattern, need.flags) ?? (need.wrap ? compileError(need.wrap(pattern), need.flags) : null)
  if (error !== null) return [`${at} doesn't compile: ${error}`]
  const reasons: string[] = []
  if (pattern.length > MAX_PATTERN_CHARS) reasons.push(`${at} is over ${MAX_PATTERN_CHARS} characters; shorten it`)
  const scan = scanPattern(pattern)
  if (scan.repeatsRepeat) reasons.push(`${at} repeats a group that itself repeats or branches, like (\\w+)+ or (a|b)+, which can hang on a long line; drop the outer repeat`)
  if (scan.wildcards > 2) reasons.push(`${at} has more than two unbounded wildcards (.* or .+); anchor the fields instead`)
  if (need.groups && groupCount(pattern) < need.groups) reasons.push(`${at} needs a group around the value it reads, e.g. ${need.example}`)
  const dotnet = need.isDotnet ? dotnetProblem(pattern) : null
  if (dotnet) reasons.push(`${at} also runs in .NET on Windows, ${dotnet}`)
  return reasons
}

// What .NET can't read in a pattern JS accepts without the u flag, or null: an escape of a letter or "_" .NET doesn't
// know (JS reads it as the letter), a \x, \u, \p, \c or \k without what .NET wants after it, a backreference to a group
// that isn't there, and the empty classes [] and [^].
const DOTNET_ESCAPES = 'dDwWsSbBnrtfvcxukpP'
export const dotnetProblem = (pattern: string): string | null => {
  const groups = groupCount(pattern)
  let isInClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\') {
      const n = pattern[i + 1] ?? ''
      const rest = pattern.slice(i + 2)
      if (/[A-Za-z_]/.test(n) && !DOTNET_ESCAPES.includes(n)) return `which has no "\\${n}"; drop the backslash`
      const isShort =
        (n === 'x' && !/^[0-9a-fA-F]{2}/.test(rest)) ||
        (n === 'u' && !/^[0-9a-fA-F]{4}/.test(rest)) ||
        ((n === 'p' || n === 'P') && !rest.startsWith('{')) ||
        (n === 'c' && !/^[A-Za-z]/.test(rest)) ||
        (n === 'k' && !rest.startsWith('<'))
      if (isShort) return `which reads "\\${n}" only as \\x41, \\u0041, \\p{L}, \\cA or \\k<name>; write it so, or drop the backslash`
      if (/[1-9]/.test(n) && !isInClass && Number(n + (rest.match(/^\d*/)?.[0] ?? '')) > groups) return `which has no group ${n} for "\\${n}"; write the digit as [${n}]`
      i++
      continue
    }
    if (isInClass) {
      if (c === ']') isInClass = false
      continue
    }
    if (c === '[') {
      if (pattern.startsWith('[]', i)) return 'which reads [] as the start of a class; write (?!) for "never matches"'
      if (pattern.startsWith('[^]', i)) return 'which reads [^] as the start of a class; write [\\s\\S] for "any character"'
      isInClass = true
      if (pattern[i + 1] === '^') i++
    }
  }
  return null
}

// Every regex a pack holds, each with what its reader needs (hooks/env, checks, budgets, plans).
const regexReasons = (value: Record<string, unknown>): string[] => {
  const reasons: string[] = []
  const list = (section: string) => (Array.isArray(value[section]) ? (value[section] as unknown[]).filter(isObject) : [])
  for (const p of list('processes')) {
    reasons.push(...checkRegex(`process ${String(p.id)}`, 'match', p.match, { isDotnet: true }))
    if (isObject(p.envFrom))
      reasons.push(...checkRegex(`process ${String(p.id)}`, 'envFrom.argRegex', p.envFrom.argRegex, { groups: 1, flags: 'm', example: '"--mode[= ](\\\\S+)"' }))
  }
  for (const e of list('environments')) {
    reasons.push(...checkRegex(`environment ${String(e.id)}`, 'argRegex', e.argRegex, { flags: 'm', isDotnet: true }))
    for (const a of Array.isArray(e.approvals) ? e.approvals.filter(isObject) : [])
      for (const field of ['commandRegex', 'inputRegex']) reasons.push(...checkRegex(`approval ${String(a.id)}`, field, a[field]))
  }
  for (const c of list('checks'))
    if (c.analyzer === 'regex-lines' || c.analyzer === 'problem-matcher')
      reasons.push(...checkRegex(`check ${String(c.id)}`, 'options.pattern', isObject(c.options) ? c.options.pattern : undefined, { flags: 'g' }))
  for (const b of list('budgets'))
    (Array.isArray(b.sources) ? b.sources : []).forEach((source, i) => {
      if (isObject(source) && ['command', 'ci-log', 'file-lines'].includes(source.kind as string))
        reasons.push(...checkRegex(`budget ${String(b.id)}`, `sources[${i}].parse`, source.parse, { groups: 1, example: '"brotli: ([0-9.]+) KB"' }))
    })
  for (const n of list('noise'))
    (Array.isArray(n.normalize) ? n.normalize : []).forEach((pattern, i) => reasons.push(...checkRegex(`noise ${String(n.id)}`, `normalize[${i}]`, pattern)))
  if (isObject(value.plans)) {
    const plans = value.plans
    reasons.push(...checkRegex('plans', 'checkpoint', plans.checkpoint, { wrap: p => `^(${p})(?![\\w])` }))
    ;(Array.isArray(plans.done) ? plans.done : []).forEach((pattern, i) => reasons.push(...checkRegex('plans', `done[${i}]`, pattern)))
    reasons.push(...checkRegex('plans', 'prRef', plans.prRef, { groups: 1, flags: 'g', example: '"#(\\\\d+)"' }))
  }
  return reasons
}
