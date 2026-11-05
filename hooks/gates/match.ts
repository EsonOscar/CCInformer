import type { GateRule, GateRules } from '../../types'
import { matchesGlob, toRepoFile } from '../checks/glob'
import { expandParts } from '../env/classify'
import type { ApprovalRule, ResolvedPack, Tone } from '../packs/types'

export type { GateRule, GateRules }

// Approval gates: a pack's environments list rules, and a tool call one of them names is asked (or, in log mode, only
// logged) before it runs. Everything here is data in, data out; register.tsx asks, writes the log and calls next.

// The tools that run a shell command. A rule that names one of them names them all, so a command run through
// PowerShell or a Monitor meets the same rule as through Bash.
export const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor'] as const
export const PATH_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

// A tool call as the rules read it: the shell command's lines (expandParts), the input as `key=value` lines and the
// written file's repo path ('' when there is none, or it lies outside the repo).
export type GateCall = { tool: string; command: string; lines: { text: string; label: string }[]; inputText: string; path: string; isCaseless: boolean }
export type Answer = 'approved' | 'approved-session' | 'session' | 'logged' | 'denied' | 'other' | 'no answer' | 'busy' | 'error'
// One line of the approval log. Never the command, an argument, an input value or a typed answer.
export type ApprovalEvent = { t: number; env: string; rule: string; tool: string; script?: string; cwd: string; head?: string; answer: Answer }

export const DENY = 'Deny'
export const APPROVE_ONCE = 'Approve once'
export const APPROVE_SESSION = 'Approve for this session'
export const ASK_HEADER = 'CCInformer'
const WHAT_CHARS = 300
const TONE_RANK: Record<Tone, number> = { local: 0, shared: 1, prod: 2 }
// Input keys that aren't the tool's own arguments.
const NOT_INPUT = ['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent']

export const isShell = (tool: string): boolean => SHELL_TOOLS.some(s => s.toLowerCase() === tool.toLowerCase())

const globRegex = (glob: string): RegExp =>
  new RegExp('^' + [...glob].map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 'i')

// A rule's tool glob against one tool name, without case.
export const toolGlobMatches = (glob: string, tool: string): boolean => globRegex(glob).test(tool)

// Whether a rule's tool glob names this tool, counting the shell tools as one.
export const toolMatches = (glob: string, tool: string): boolean =>
  toolGlobMatches(glob, tool) || (isShell(tool) && SHELL_TOOLS.some(s => toolGlobMatches(glob, s)))

const filePathOf = (input: Record<string, unknown>): string => {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : ''
}

// Whether a rule could name this call at all, before any regex runs: its tool, a shell command when it reads one, a
// file path when it reads one. A routine call no rule could name costs nothing more.
export const couldApply = (rule: ApprovalRule, tool: string, input: Record<string, unknown>): boolean =>
  toolMatches(rule.tool, tool) &&
  (!rule.commandRegex || (isShell(tool) && typeof input.command === 'string' && input.command.trim() !== '')) &&
  (!rule.pathGlob || filePathOf(input) !== '')

// The call's own arguments, one `key=value` line each (top-level text, numbers and booleans), with line breaks in a
// value escaped, so a `^key=value$` pattern sees each key once and a value can't forge a line of its own.
export const inputText = (input: Record<string, unknown>): string =>
  Object.entries(input)
    .filter(([key, value]) => !NOT_INPUT.includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => key + '=' + String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n'))
    .join('\n')

export const gateCall = (tool: string, input: Record<string, unknown>, scripts: Record<string, string>, root: string): GateCall => {
  const command = isShell(tool) && typeof input.command === 'string' ? input.command : ''
  const file = filePathOf(input)
  const isCaseless = /^[a-z]:/i.test(root)
  const path = file ? toRepoFile(root, file) : ''
  return { tool, command, lines: command ? expandParts(command, scripts) : [], inputText: inputText(input), path: isCaseless ? path.toLowerCase() : path, isCaseless }
}

const tests = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern, 'm').test(text)
  } catch {
    return false
  }
}

// A rule names a call when its tool glob does and every field it sets matches: the command on any of its lines, the
// input lines, the repo path.
export const ruleMatches = (rule: ApprovalRule, call: GateCall): boolean =>
  toolMatches(rule.tool, call.tool) &&
  (!rule.commandRegex || call.lines.some(line => tests(rule.commandRegex!, line.text))) &&
  (!rule.inputRegex || tests(rule.inputRegex, call.inputText)) &&
  (!rule.pathGlob || (call.path !== '' && matchesGlob([call.isCaseless ? rule.pathGlob.toLowerCase() : rule.pathGlob], call.path)))

const hash = (text: string): string => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// What a session approval is kept under: the rule and what it matches, so an edited rule asks again.
export const sessionKey = (g: GateRule): string =>
  `${g.env}/${g.rule.id}#${hash(JSON.stringify([g.rule.tool, g.rule.commandRegex ?? '', g.rule.inputRegex ?? '', g.rule.pathGlob ?? '']))}`

const isAsk = (g: GateRule): boolean => (g.rule.mode ?? 'ask') === 'ask'
const isHeld = (g: GateRule, approved: ReadonlySet<string>): boolean => isAsk(g) && g.rule.scope === 'session' && approved.has(sessionKey(g))
const strictest = (gates: GateRule[]): GateRule =>
  gates.reduce((best, g) => {
    const rank = (x: GateRule) => (isAsk(x) ? 10 : 0) + TONE_RANK[x.tone]
    return rank(g) > rank(best) ? g : best
  })

// The rule that decides a call: of those that match, the ones a session approval still holds are set aside, then
// asking beats logging, prod beats shared beats local, the first on a tie. When every match is held, the call runs
// on that approval.
export const pickGate = (rules: GateRule[], call: GateCall, approved: ReadonlySet<string>): { gate: GateRule; isSessionApproved: boolean } | null => {
  const matched = rules.filter(g => ruleMatches(g.rule, call))
  if (!matched.length) return null
  const open = matched.filter(g => !isHeld(g, approved))
  return open.length ? { gate: strictest(open), isSessionApproved: false } : { gate: strictest(matched), isSessionApproved: true }
}

const cut = (text: string): string => (text.length > WHAT_CHARS ? text.slice(0, WHAT_CHARS - 1) + '…' : text)

// What the call will do, for the question only: the whole command, the MCP tool and its input, or the path.
const whatOf = (call: GateCall): string => {
  if (call.command) return cut(call.command.trim())
  if (/^mcp__/i.test(call.tool)) return cut([call.tool.split('__').pop() ?? call.tool, call.inputText.replace(/\n/g, ', ')].filter(Boolean).join(': '))
  return cut(call.path ? `${call.tool} ${call.path}` : call.tool)
}

export const askFor = (g: GateRule, call: GateCall): { question: string; options: string[]; header: string } => ({
  question: `Let Claude run this on ${g.envLabel} (${g.rule.label})? ${whatOf(call)}`,
  options: [DENY, APPROVE_ONCE, ...(g.rule.scope === 'session' ? [APPROVE_SESSION] : [])],
  header: ASK_HEADER,
})

// Only an exact label approves: free text typed under "Other" is not a yes, and no answer is a no.
export const answerOf = (reply: string | null, options: readonly string[]): Answer => {
  if (reply === null || reply.trim() === '') return 'no answer'
  if (reply === DENY) return 'denied'
  if (reply === APPROVE_ONCE) return 'approved'
  if (reply === APPROVE_SESSION && options.includes(APPROVE_SESSION)) return 'approved-session'
  return 'other'
}

export const isApproved = (a: Answer): boolean => a === 'approved' || a === 'approved-session' || a === 'session' || a === 'logged'

// What Claude is told when a gate stops a call.
export const denyText = (g: GateRule | null, a: Answer): string => {
  const which = g ? `("${g.rule.label}", ${g.envLabel})` : ''
  if (a === 'denied') return `The person denied this call at CCInformer's approval gate ${which}. Don't retry it; ask them what to do instead.`
  if (a === 'other') return "The person answered CCInformer's approval question with their own text, so the call did not run. Ask them what they meant."
  if (a === 'no answer') return `No answer to CCInformer's approval question ${which}, so the call did not run; it needs the person's OK.`
  if (a === 'busy') return 'Another CCInformer approval question is open, so this call did not run; retry it once that one is answered.'
  return "CCInformer's approval gate failed, so this call did not run. The person can turn the gates off in Debug › Settings › Approval gates."
}

const LABEL = /^(?:npm|pnpm|yarn|bun) run [\w.:@-]{1,80}$/
const EXECUTABLE = /^[\w.:@-]{1,80}$/

// The event's `script`: the label of the script the matched line came from, else that line's program's file name.
// Never a path, an argument or a value.
export const eventScript = (call: GateCall, rule: ApprovalRule): string | undefined => {
  if (!rule.commandRegex) return undefined
  const line = call.lines.find(l => tests(rule.commandRegex!, l.text))
  if (!line) return undefined
  if (LABEL.test(line.label)) return line.label
  const program = line.text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').split(/\s+/)[0] ?? ''
  // A quoted program may hold spaces, so its first word isn't its name.
  if (/^["']/.test(program)) return undefined
  const name = program.split(/[\\/]/).pop() ?? ''
  return EXECUTABLE.test(name) ? name : undefined
}

export const eventLine = (ev: ApprovalEvent): string =>
  JSON.stringify({
    t: ev.t,
    env: ev.env,
    rule: ev.rule,
    tool: ev.tool,
    ...(ev.script ? { script: ev.script } : {}),
    cwd: ev.cwd,
    ...(ev.head ? { head: ev.head } : {}),
    answer: ev.answer,
  }) + '\n'

// The log: one file per session, a new segment once one reaches about 128 KiB.
export const SEGMENT_CHARS = 128 * 1024

export const ledgerDir = (configDir: string, repoKey: string): string => `${configDir}/ccinformer/approvals/${repoKey}`

export const ledgerName = (sessionId: string, segment: number): string => (segment ? `${sessionId}-${segment}.jsonl` : `${sessionId}.jsonl`)

export const latestSegment = (names: string[], sessionId: string): number =>
  names.reduce((latest, name) => {
    if (name === `${sessionId}.jsonl`) return latest
    const m = name.startsWith(sessionId + '-') ? /^-(\d+)\.jsonl$/.exec(name.slice(sessionId.length)) : null
    return m ? Math.max(latest, Number(m[1])) : latest
  }, 0)

export const appended = (cur: { segment: number; text: string }, line: string, limit: number): { segment: number; text: string } =>
  cur.text && cur.text.length + line.length > limit ? { segment: cur.segment + 1, text: line } : { segment: cur.segment, text: cur.text + line }

// The rules of a resolved pack, each with its environment, as the gate keeps them.
export const gateRulesOf = (pack: ResolvedPack, root: string, ledgerDir: string): GateRules => ({
  root,
  ledgerDir,
  rules: pack.environments.flatMap(env => (env.approvals ?? []).map(rule => ({ env: env.id, envLabel: env.label, tone: env.tone, rule }))),
})
