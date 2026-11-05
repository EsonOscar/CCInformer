import type { EnvTask } from '../../types'
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

// The approval gates' view of a line: every command in it, split more widely than above (a single `&`, PowerShell's
// call operator included, and newlines), each as written, then, for a package runner, a normalised `npm run <name>`
// line and the script's own commands, depth first. Every line carries the label of the command it came from, so a
// matched script body still names the script that ran it.
const GATE_SEPARATOR = /\s*(?:&&|\|\||;|\||&|\r?\n)\s*/
const WRAPPER = /^(?:(?:env|time|nohup|\.)\s+|npx\s+dotenv(?:-cli)?\s+.*?\s--\s+)/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/
const GATE_RUNNER = /^(npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?$/i
// Runner flags that take the next word as their value.
const VALUE_FLAGS = ['--prefix', '-C', '--cwd', '--dir', '--workspace', '-w', '--filter', '-F']

const unwrap = (part: string): string => {
  let text = part.trim()
  for (let before = ''; before !== text; ) {
    before = text
    text = text.replace(WRAPPER, '').replace(ASSIGNMENT, '').trim()
  }
  return text
}

// The script a runner names, flags skipped: `npm.cmd --prefix api run -s db:migrate` is npm's `db:migrate`.
const runnerScript = (part: string, scripts: Record<string, string>): { runner: string; name: string } | null => {
  const words = unwrap(part).split(/\s+/)
  const runner = GATE_RUNNER.exec(words[0] ?? '')?.[1]?.toLowerCase()
  if (!runner) return null
  let i = 1
  let hasRun = false
  for (; i < words.length; i++) {
    const word = words[i]!
    if (VALUE_FLAGS.includes(word)) i++
    else if (word === 'run' || word === 'run-script') hasRun = true
    else if (!word.startsWith('-')) break
  }
  const name = words[i] ?? ''
  if (!name) return null
  const isScript = hasRun || (name in scripts && (runner !== 'npm' || NPM_BARE.includes(name)))
  return isScript ? { runner, name } : null
}

const gateLines = (part: string, scripts: Record<string, string>, label: string, depth: number): { text: string; label: string }[] => {
  const text = part.trim()
  if (!text || /^cd\s/.test(text)) return []
  const script = runnerScript(text, scripts)
  if (!script) return [{ text, label }]
  const own = label || `${script.runner} run ${script.name}`
  const lines = [{ text, label: own }, { text: `${script.runner} run ${script.name}`, label: own }]
  const body = scripts[script.name]
  if (body === undefined || depth >= MAX_DEPTH) return lines
  return [...lines, ...body.split(GATE_SEPARATOR).flatMap(p => gateLines(p, scripts, own, depth + 1))]
}

export const expandParts = (command: string, scripts: Record<string, string>): { text: string; label: string }[] =>
  command.split(GATE_SEPARATOR).flatMap(p => gateLines(p, scripts, '', 0))

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

// The strictest of some environments: prod over shared over local, the first on a tie.
export const strictestEnv = (envs: EnvRule[]): EnvRule | null =>
  envs.reduce<EnvRule | null>((worst, e) => (!worst || TONE_RANK[e.tone] > TONE_RANK[worst.tone] ? e : worst), null)

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
  return { process, env: strictestEnv([...byArg, ...byHost]) }
}

// The task a placed command is tracked as: one the pack knows as a process, or one aimed at an environment.
export const envTaskFor = (
  target: { label: string; process: ProcessMatcher | null; env: EnvRule | null },
  id: string,
  startedAt: number,
): EnvTask | null =>
  target.env || target.process
    ? {
        id,
        toolUseId: id,
        label: target.label,
        envId: target.env?.id ?? '',
        envLabel: target.env?.label ?? '',
        tone: target.env?.tone ?? 'local',
        isHeavy: !!target.process?.heavy,
        startedAt,
      }
    : null
