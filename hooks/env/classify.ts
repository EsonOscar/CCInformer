import { hostMatches } from '../packs/merge'
import type { EnvRule, ProcessMatcher, ResolvedPack, Tone } from '../packs/types'

// A shell line's commands, split at `&&`, `||`, `;` and `|`. Quoting is not followed: a separator inside quotes
// splits too, which only makes the match look at smaller pieces.
const SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/

// `npm run x`, `pnpm x`, `yarn run x`, `bun x`, after any `NAME=value` assignments.
const RUNNER = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(npm|pnpm|yarn|bun)\s+(run(?:-script)?\s+)?(\S+)(.*)$/
// Scripts npm runs without `run`.
const NPM_BARE = ['start', 'test', 'stop', 'restart']
const MAX_DEPTH = 4

// The folder a line starts with `cd <dir> &&`, or '' when it doesn't.
export const commandDir = (command: string): string => {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(command)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

// The script a runner names in one command, when package.json has it.
const scriptOf = (part: string, scripts: Record<string, string>): { name: string; label: string; rest: string } | null => {
  const m = RUNNER.exec(part.trim())
  if (!m) return null
  const [, runner = '', run = '', name = '', rest = ''] = m
  const isScript = name in scripts && (runner !== 'npm' || !!run || NPM_BARE.includes(name))
  return isScript ? { name, label: `${runner} ${run ? 'run ' : ''}${name}`, rest: rest.replace(/^\s*--(?=\s|$)/, '') } : null
}

// One command and every script it runs, depth first: `npm run dev:staging` → the script's own text → ...
const expandPart = (part: string, scripts: Record<string, string>, depth: number): string[] => {
  const script = depth < MAX_DEPTH ? scriptOf(part, scripts) : null
  if (!script) return [part.trim()]
  const body = (scripts[script.name] ?? '') + script.rest
  return [part.trim(), ...body.split(SEPARATOR).filter(Boolean).flatMap(p => expandPart(p, scripts, depth + 1))]
}

// A line with its package scripts expanded, as one text the pack's regexes run over, and a short label for it:
// the first script it runs (`npm run dev:staging`), never the line itself, which may hold a secret.
export const expandCommand = (command: string, scripts: Record<string, string>): { text: string; label: string } => {
  const parts = command.split(SEPARATOR).filter(p => p && !/^cd\s/.test(p.trim()))
  const text = parts.flatMap(p => expandPart(p, scripts, 0)).join('\n')
  const label = parts.map(p => scriptOf(p, scripts)?.label).find(Boolean) ?? ''
  return { text, label }
}

const tests = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern, 'm').test(text)
  } catch {
    return false
  }
}

// The env files the matched processes read: `envFrom.envFile` with `{mode}` filled from `envFrom.argRegex`'s first
// group. A file whose mode isn't in the line is skipped.
export const envFilesFor = (pack: ResolvedPack, text: string): { file: string; key?: string }[] =>
  pack.processes
    .filter(p => p.envFrom && tests(p.match, text))
    .flatMap(p => {
      const from = p.envFrom!
      let mode = ''
      try {
        mode = from.argRegex ? (new RegExp(from.argRegex, 'm').exec(text)?.[1] ?? '') : ''
      } catch {
        mode = ''
      }
      const file = from.envFile ?? '.env'
      if (file.includes('{mode}') && !mode) return []
      return [{ file: file.replace('{mode}', mode), key: from.envKey }]
    })

// The hosts an env file's values point at: a URL's host, or a bare host name. Only the named key's value when the
// pack names one. The values themselves go no further than this function.
export const hostsIn = (text: string, key?: string): string[] =>
  text.split(/\r?\n/).flatMap(line => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || (key && m[1] !== key)) return []
    const value = (m[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return [new URL(value).hostname]
    } catch {
      return []
    }
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value) ? [value] : []
  })

// The tasks a background-task notification says have ended: each block with a `<task-id>` and a `<status>`.
export const endedTaskIds = (text: string): string[] =>
  text
    .split('<task-notification>')
    .flatMap(block => {
      const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(block)?.[1]
      return id && /<status>[^<]+<\/status>/.test(block) ? [id] : []
    })

const TONE_RANK: Record<Tone, number> = { local: 0, shared: 1, prod: 2 }

// What a line runs and where it points: the first process matcher that matches, and the strictest environment
// among those whose `argRegex` matches the line and those whose hosts the env files point at.
export const classify = (
  pack: ResolvedPack,
  text: string,
  envFiles: { text: string; key?: string }[],
): { process: ProcessMatcher | null; env: EnvRule | null } => {
  const process = pack.processes.find(p => tests(p.match, text)) ?? null
  const byArg = pack.environments.filter(e => e.argRegex && tests(e.argRegex, text))
  const hosts = envFiles.flatMap(f => hostsIn(f.text, f.key))
  const byHost = pack.environments.filter(e => hosts.some(h => (e.hostPatterns ?? []).some(p => hostMatches(p, h))))
  const env = [...byArg, ...byHost].reduce<EnvRule | null>((worst, e) => (!worst || TONE_RANK[e.tone] > TONE_RANK[worst.tone] ? e : worst), null)
  return { process, env }
}
