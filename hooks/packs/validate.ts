import { FILES_SLOT, LIST_SECTIONS, MATCHER_GROUPS, MATCHER_REQUIRED, MATCHER_SEVERITIES, MAX_PATTERN_CHARS, MAX_TIMEOUT_MS, OUTPUT_SLOT, PACK_KEYS } from './types'
import type { AnalyzerId, PackManifest } from './types'

// What a file came to: the value when it's valid, or every reason it isn't. A file with any reason is not used.
export type Checked<T> = { value: T; reasons: [] } | { value?: undefined; reasons: string[] }

const ANALYZERS: AnalyzerId[] = ['regex-lines', 'size-lines', 'i18n-keysets', 'eslint-json', 'sarif', 'problem-matcher', 'tscn-connections', 'tscn-nodepaths']
const COSTS = ['edit', 'turn', 'demand']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

const compiles = (pattern: string): boolean => {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

// The regexes a pack entry may carry, by section: each must compile.
const REGEX_FIELDS: Record<string, string[]> = {
  processes: ['match'],
  environments: ['argRegex'],
}

// A built-in or user pack: its keys, its shape, its ids, and every regex it holds.
export const checkPack = (value: unknown, layer: 'built-in' | 'user'): Checked<PackManifest> => {
  if (!isObject(value)) return { reasons: ['is not an object'] }
  const reasons: string[] = []
  for (const key of Object.keys(value))
    if (!(PACK_KEYS as readonly string[]).includes(key)) reasons.push(`"${key}" isn't a pack setting (it takes ${PACK_KEYS.join(', ')})`)
  if (value.schema !== 1) reasons.push('needs "schema": 1')
  if (typeof value.id !== 'string' || !value.id) reasons.push('needs an "id"')
  if (typeof value.version !== 'string') reasons.push('needs a "version" (a string)')
  if (layer === 'user' && value.detect !== undefined) reasons.push('"detect" is for built-in packs; a user pack is picked by "match.remote"')
  if (layer === 'built-in' && value.match !== undefined) reasons.push('"match" is for user packs')
  if (value.match !== undefined && !(isObject(value.match) && isStrings(value.match.remote ?? []))) reasons.push('"match.remote" must be a list of strings')
  if (value.extends !== undefined && !isStrings(value.extends)) reasons.push('"extends" must be a list of built-in ids')
  if (value.disable !== undefined && !isStrings(value.disable)) reasons.push('"disable" must be a list of ids')
  for (const section of LIST_SECTIONS) reasons.push(...checkList(section, value[section]))
  for (const env of Array.isArray(value.environments) ? value.environments : []) {
    if (isObject(env) && env.approvals !== undefined) reasons.push(...checkList('environments.' + String(env.id) + '.approvals', env.approvals))
    for (const a of isObject(env) && Array.isArray(env.approvals) ? env.approvals : [])
      for (const field of ['commandRegex', 'inputRegex'])
        if (isObject(a) && typeof a[field] === 'string' && !compiles(a[field] as string)) reasons.push(`approval ${String(a.id)}: ${field} doesn't compile`)
  }
  for (const c of Array.isArray(value.checks) ? value.checks : []) {
    if (!isObject(c)) continue
    if (!ANALYZERS.includes(c.analyzer as AnalyzerId)) reasons.push(`check ${String(c.id)}: no analyzer "${String(c.analyzer)}"`)
    if (!COSTS.includes(c.cost as string)) reasons.push(`check ${String(c.id)}: cost must be one of ${COSTS.join(', ')}`)
    if (!isStrings(c.on)) reasons.push(`check ${String(c.id)}: "on" must be a list of globs`)
    if (c.analyzer === 'regex-lines') reasons.push(...checkRegexLines(c))
    if (c.analyzer === 'i18n-keysets') reasons.push(...checkKeysets(c))
    if (c.analyzer === 'sarif' || c.analyzer === 'problem-matcher') reasons.push(...checkCommand(c))
    if (c.analyzer === 'problem-matcher') reasons.push(...checkMatcher(c))
    if (c.analyzer === 'eslint-json') reasons.push(...checkEslintBin(c))
  }
  return reasons.length ? { reasons } : { value: value as PackManifest, reasons: [] }
}

// A regex-lines check runs on each write, inside the mod: its pattern must be there and compile.
const checkRegexLines = (c: Record<string, unknown>): string[] => {
  const options = isObject(c.options) ? c.options : {}
  const reasons: string[] = []
  if (c.cost !== 'edit') reasons.push(`check ${String(c.id)}: a regex-lines check runs on each write, so its cost must be "edit"`)
  if (typeof options.pattern !== 'string' || !options.pattern) reasons.push(`check ${String(c.id)}: needs "options.pattern", the regex each line is tested against`)
  else if (!compiles(options.pattern)) reasons.push(`check ${String(c.id)}: "options.pattern" doesn't compile`)
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

// A sarif or problem-matcher check runs the command its pack names once a turn ends, through the heavy lane: its
// cost is "turn", `bin` is the whole command with the program first, `{files}` is a list item on its own (once) and
// `{output}` belongs to sarif checks; a timeout is a whole number of milliseconds with a ceiling.
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
  const timeout = c.timeoutMs
  if (timeout !== undefined && !(Number.isInteger(timeout) && (timeout as number) > 0 && (timeout as number) <= MAX_TIMEOUT_MS))
    reasons.push(`check ${id}: "timeoutMs" must be a whole number of milliseconds, from 1 to ${MAX_TIMEOUT_MS}`)
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
  else if (!compiles(pattern)) reasons.push(`check ${id}: "options.pattern" doesn't compile`)
  else {
    if (pattern.length > MAX_PATTERN_CHARS) reasons.push(`check ${id}: "options.pattern" is over ${MAX_PATTERN_CHARS} characters`)
    const groups = groupsOf(pattern)
    const missing = MATCHER_REQUIRED.filter(g => !groups.includes(g))
    if (missing.length)
      reasons.push(`check ${id}: "options.pattern" needs the named groups file, line and message (missing: ${missing.join(', ')}), e.g. (?<file>[^:]+):(?<line>\\d+): (?<message>.*)`)
    for (const g of groups)
      if (!(MATCHER_GROUPS as readonly string[]).includes(g)) reasons.push(`check ${id}: "options.pattern" has a group "${g}"; the groups are file, line, column, severity, code and message`)
    const scan = scanPattern(pattern)
    if (scan.repeatsRepeat)
      reasons.push(`check ${id}: "options.pattern" repeats a group that itself repeats or branches, like (\\w+)+ or (a|b)+, which can hang on a long line; drop the outer repeat`)
    if (scan.wildcards > 2) reasons.push(`check ${id}: "options.pattern" has more than two unbounded wildcards (.* or .+); anchor the fields instead`)
  }
  if (options.severity !== undefined && !(MATCHER_SEVERITIES as readonly unknown[]).includes(options.severity))
    reasons.push(`check ${id}: "options.severity" must be "error", "warn" or "info"`)
  return reasons
}

// A list section: entries are objects with a unique id, and their regexes compile.
const checkList = (section: string, list: unknown): string[] => {
  if (list === undefined) return []
  if (!Array.isArray(list)) return [`"${section}" must be a list`]
  const reasons: string[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id) {
      reasons.push(`"${section}" has an entry without an "id"`)
      continue
    }
    if (seen.has(entry.id)) reasons.push(`"${section}" has "${entry.id}" twice`)
    seen.add(entry.id)
    for (const field of REGEX_FIELDS[section] ?? [])
      if (typeof entry[field] === 'string' && !compiles(entry[field] as string)) reasons.push(`${section} ${entry.id}: ${field} doesn't compile`)
  }
  return reasons
}
