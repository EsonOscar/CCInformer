import type { EngineInterface } from 'claude-code'

import type { AgentSettings, SkillsSettings } from '../../types'

// The planning skills' own settings, outside every repo: a plain JSON file in the mod's folder under Claude Code's
// config dir, since a skill runs as Claude and reads it as a file. `{ "planFiles": false }` switches the plan files
// off; a missing file, or any other value, means on. `agents` holds the model and effort the person set for a kind of
// workflow agent, by script name and role, and only where it differs from the script's default. Approve all and Deny
// all leave the file alone: a skill run is started by the person, not by the mod.
export const SKILLS_FILE = 'ccinformer/skills.json'

export const DEFAULT_SKILLS: SkillsSettings = { planFiles: true, agents: {} }

// The Settings row.
export const PLAN_FILES = {
  group: 'Planning skills',
  label: 'Plan files',
  description:
    'The planning skills save the approved plan to .local/plans/, where Work › Plans shows it, and offer to write .local/ccinformer-planning.md. Off: they write nothing into the repo and build from Claude Code\'s own plan file; a handoff doc is still written.',
  note: 'Approve all and Deny all leave this as it is: it is the skills\' own setting, kept in ~/.claude/ccinformer/skills.json for every repo.',
}

// What a workflow agent can be set to: the scripts bring anything above Opus at high effort down to it.
export const AGENT_MODELS = ['haiku', 'sonnet', 'opus']
export const AGENT_EFFORTS = ['low', 'medium', 'high']

export type AgentField = 'model' | 'effort'
export type AgentRole = { script: string; role: string; label: string; model: string; effort: string }

// Every kind of agent the skills' workflow scripts start, with the model and effort its script runs it on when
// nothing is set. A test runs each script and holds these defaults to it.
export const AGENT_ROLES: AgentRole[] = [
  { script: 'plan-fanout', role: 'scout', label: 'Plan: scouts', model: 'sonnet', effort: 'medium' },
  { script: 'plan-fanout', role: 'planner', label: 'Plan: planners', model: 'opus', effort: 'high' },
  { script: 'plan-fanout', role: 'critic', label: 'Plan: critics', model: 'opus', effort: 'high' },
  { script: 'build-fanout', role: 'builder', label: 'Build: builders and fixes', model: 'opus', effort: 'high' },
  { script: 'build-fanout', role: 'reviewer', label: 'Build: reviewers', model: 'opus', effort: 'high' },
  { script: 'audit-docs-fanout', role: 'auditor', label: 'Docs audit: auditors', model: 'opus', effort: 'high' },
  { script: 'audit-docs-fanout', role: 'verifier', label: 'Docs audit: verifiers', model: 'opus', effort: 'high' },
  { script: 'plan-review', role: 'critic', label: 'Plan review: critic (and final checks)', model: 'opus', effort: 'medium' },
]

export const AGENTS_TEXTS = {
  heading: 'Workflow agents',
  note: 'The model and effort each kind of workflow agent runs on, for every repo. Opus at high effort is the most; the session\'s own model is /model\'s. A skill reads these once, before its first workflow. Approve all and Deny all leave them as they are.',
  reset: 'return to default',
  defaults: 'defaults',
  changed: (n: number) => `${n} changed`,
}

const LISTS: Record<AgentField, string[]> = { model: AGENT_MODELS, effort: AGENT_EFFORTS }
const FIELDS: AgentField[] = ['model', 'effort']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// A settings value kept in the session's state from before this field existed has no `agents`.
const agentsOf = (s: SkillsSettings): AgentSettings => s.agents ?? {}

// The settings with one value set; a value equal to the default leaves no key, nor does an emptied role or script.
const withValue = (agents: AgentSettings, def: AgentRole, field: AgentField, value: string): AgentSettings => {
  const choice = { ...agents[def.script]?.[def.role] }
  if (value === def[field]) delete choice[field]
  else choice[field] = value
  const roles = { ...agents[def.script] }
  if (Object.keys(choice).length) roles[def.role] = choice
  else delete roles[def.role]
  const next = { ...agents }
  if (Object.keys(roles).length) next[def.script] = roles
  else delete next[def.script]
  return next
}

// The file's `agents`, keeping only a known script and role with a value on the lists.
const agentsFrom = (raw: unknown): AgentSettings => {
  if (!isObject(raw)) return {}
  let agents: AgentSettings = {}
  for (const def of AGENT_ROLES) {
    const roles = raw[def.script]
    const choice = isObject(roles) ? roles[def.role] : undefined
    if (!isObject(choice)) continue
    for (const field of FIELDS) {
      const value = choice[field]
      if (typeof value === 'string' && LISTS[field].includes(value)) agents = withValue(agents, def, field, value)
    }
  }
  return agents
}

const parsed = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}

export const skillsFrom = (text: string): SkillsSettings => {
  const file = parsed(text)
  return { planFiles: file.planFiles !== false, agents: agentsFrom(file.agents) }
}

// The file's other top-level keys, which a later version may have written: kept as they are when this one writes.
export const skillsRest = (text: string): Record<string, unknown> => {
  const { planFiles: _planFiles, agents: _agents, ...rest } = parsed(text)
  return rest
}

export const skillsText = (s: SkillsSettings, rest: Record<string, unknown> = {}): string => {
  const agents = agentsOf(s)
  return JSON.stringify({ ...rest, planFiles: s.planFiles, ...(Object.keys(agents).length ? { agents } : {}) }, null, 2) + '\n'
}

const roleDef = (script: string, role: string): AgentRole | undefined => AGENT_ROLES.find(d => d.script === script && d.role === role)

// What a kind of agent runs on: the person's value where set, else the script's default.
export const agentChoice = (s: SkillsSettings, script: string, role: string): { model: string; effort: string; isDefault: boolean } => {
  const def = roleDef(script, role)
  const set = agentsOf(s)[script]?.[role] ?? {}
  const model = set.model ?? def?.model ?? ''
  const effort = set.effort ?? def?.effort ?? ''
  return { model, effort, isDefault: model === def?.model && effort === def?.effort }
}

// The settings with one value moved to the next on its list, wrapping round.
export const cycled = (s: SkillsSettings, script: string, role: string, field: AgentField): SkillsSettings => {
  const def = roleDef(script, role)
  if (!def) return s
  const list = LISTS[field]
  const value = list[(list.indexOf(agentChoice(s, script, role)[field]) + 1) % list.length]!
  return { ...s, agents: withValue(agentsOf(s), def, field, value) }
}

export const withoutAgents = (s: SkillsSettings): SkillsSettings => ({ ...s, agents: {} })

// How many kinds of agent run on something other than their default.
export const changedCount = (s: SkillsSettings): number => AGENT_ROLES.filter(d => !agentChoice(s, d.script, d.role).isDefault).length

// The explain prompt's line: every kind of agent and what it runs on.
export const agentsExplain = (s: SkillsSettings): string =>
  `- ${PLAN_FILES.group} · ${AGENTS_TEXTS.heading}: ` +
  AGENT_ROLES.map(d => {
    const c = agentChoice(s, d.script, d.role)
    return `${d.label} on ${c.model} at ${c.effort}${c.isDefault ? '' : ' (changed)'}`
  }).join('; ') +
  `. ${AGENTS_TEXTS.note}`

// The file as it is now; a missing or unreadable one is the defaults.
export async function readSkills($: EngineInterface, path: string): Promise<SkillsSettings> {
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? skillsFrom(text) : DEFAULT_SKILLS
}
