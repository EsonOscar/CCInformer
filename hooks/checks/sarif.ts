import type { CheckSpec } from '../packs/types'
import type { RawFinding } from './findings'
import { toRepoFile } from './glob'

// SARIF 2.1.0 (what ESLint's formatter, Roslyn's ErrorLog, ruff, Semgrep and CodeQL write), read into raw findings
// for `toolFindings`. Every run is read. A result that isn't a failure (`kind`), one the tool itself suppressed (a
// `suppressions` entry that stands), or one of level `none` is left out. ESLint's parse errors come as the
// invocation's notifications, not as results, so those with a location are read too, as rule `parse`.

type Region = { startLine?: number; startColumn?: number }
type ArtifactLocation = { uri?: string; uriBaseId?: string; index?: number }
type Location = { physicalLocation?: { artifactLocation?: ArtifactLocation; region?: Region } }
type Result = {
  ruleId?: string
  ruleIndex?: number
  rule?: { id?: string }
  level?: string
  kind?: string
  message?: { text?: string; id?: string }
  locations?: Location[]
  suppressions?: { status?: string }[]
}
type Notification = { level?: string; message?: { text?: string }; locations?: Location[] }
type Run = {
  tool?: { driver?: { rules?: { id?: string; defaultConfiguration?: { level?: string } }[] } }
  artifacts?: { location?: ArtifactLocation }[]
  originalUriBaseIds?: Record<string, { uri?: string }>
  results?: Result[]
  invocations?: { toolConfigurationNotifications?: Notification[]; toolExecutionNotifications?: Notification[] }[]
}

export const NOT_SARIF = "its output isn't SARIF 2.1.0"

const LEVELS: Record<string, RawFinding['severity']> = { error: 'error', warning: 'warn', note: 'info' }

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// A uri's path: a `file:` uri on this machine loses its scheme (`file:///C:/a` is `/C:/a`, `file:///a` is `/a`);
// no scheme, or a lone drive letter, is a path as given; another scheme, or a host that isn't this machine, is null.
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const pathOf = (uri: string): string | null => {
  const scheme = SCHEME.exec(uri)
  if (!scheme || scheme[1]!.length === 1) return uri
  if (scheme[1]!.toLowerCase() !== 'file') return null
  const rest = uri.slice(scheme[0].length)
  const hosted = /^\/\/([^/]*)(\/.*)?$/.exec(rest)
  if (!hosted) return rest
  const host = hosted[1]!
  if (host && host.toLowerCase() !== 'localhost') return null
  return hosted[2] ?? '/'
}

const isRooted = (path: string): boolean => /^(?:\/?[a-z]:)?[\\/]/i.test(path)

// The repo file a location names, or '' (outside the repo, no uri, another machine). A uri with a base id is joined
// to the run's base uri; one named by index comes from the run's artifacts. Decoded before the dots are resolved, so
// an encoded `..` can't leave the repo.
const fileOf = (root: string, run: Run, location: ArtifactLocation | undefined): string => {
  let uri = location?.uri
  let baseId = location?.uriBaseId
  if (uri === undefined && location?.index !== undefined) {
    const artifact = run.artifacts?.[location.index]?.location
    uri = artifact?.uri
    baseId = artifact?.uriBaseId ?? baseId
  }
  if (!uri) return ''
  let path = pathOf(decode(uri))
  if (path === null) return ''
  if (baseId && !isRooted(path)) {
    const baseUri = run.originalUriBaseIds?.[baseId]?.uri
    if (baseUri) {
      const base = pathOf(decode(baseUri))
      if (base === null) return ''
      path = base.replace(/\/?$/, '/') + path
    }
  }
  return toRepoFile(root, path.replace(/^\/(?=[a-z]:)/i, ''))
}

const ruleOf = (check: CheckSpec, run: Run, r: Result): string =>
  r.ruleId ?? (r.ruleIndex !== undefined ? run.tool?.driver?.rules?.[r.ruleIndex]?.id : undefined) ?? r.rule?.id ?? check.rules?.[0] ?? check.id

const levelOf = (run: Run, r: Result): string =>
  r.level ?? (r.ruleIndex !== undefined ? run.tool?.driver?.rules?.[r.ruleIndex]?.defaultConfiguration?.level : undefined) ?? 'warning'

const raw = (root: string, run: Run, location: Location | undefined, rule: string, severity: RawFinding['severity'], message: string): RawFinding => ({
  file: location ? fileOf(root, run, location.physicalLocation?.artifactLocation) : '',
  line: location?.physicalLocation?.region?.startLine ?? 0,
  column: location?.physicalLocation?.region?.startColumn ?? 0,
  rule,
  severity,
  message,
})

// The log's raw findings, the repo files its runs list as artifacts (files the tool looked at, clean ones too), and
// the error when the text isn't SARIF 2.1.0 (a SARIF 1.0 log, as Roslyn writes without `version=2.1`, carries no
// messages or locations, so it is refused rather than read as clean).
export const sarifResults = (check: CheckSpec, text: string, root: string): { raws: RawFinding[]; reported: string[]; error: string } => {
  let log: { version?: unknown; runs?: unknown }
  try {
    log = JSON.parse(text) as { version?: unknown; runs?: unknown }
  } catch {
    return { raws: [], reported: [], error: NOT_SARIF }
  }
  if (typeof log !== 'object' || log === null || log.version !== '2.1.0' || !Array.isArray(log.runs)) return { raws: [], reported: [], error: NOT_SARIF }
  const raws: RawFinding[] = []
  const reported: string[] = []
  for (const run of log.runs as Run[]) {
    if (typeof run !== 'object' || run === null) continue
    for (const artifact of run.artifacts ?? []) {
      const file = fileOf(root, run, artifact.location)
      if (file) reported.push(file)
    }
    for (const r of run.results ?? []) {
      if (r.kind !== undefined && r.kind !== 'fail') continue
      if (r.suppressions?.length && !r.suppressions.every(s => s.status === 'rejected' || s.status === 'underReview')) continue
      const severity = LEVELS[levelOf(run, r)]
      if (!severity) continue
      raws.push(raw(root, run, r.locations?.[0], ruleOf(check, run, r), severity, r.message?.text ?? r.message?.id ?? ''))
    }
    for (const invocation of run.invocations ?? [])
      for (const n of [...(invocation.toolConfigurationNotifications ?? []), ...(invocation.toolExecutionNotifications ?? [])]) {
        const location = n.locations?.[0]
        if (n.level !== 'error' || !location?.physicalLocation) continue
        raws.push(raw(root, run, location, 'parse', 'error', n.message?.text ?? ''))
      }
  }
  return { raws, reported, error: '' }
}
