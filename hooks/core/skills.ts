import type { EngineInterface } from 'claude-code'

import type { SkillsSettings } from '../../types'

// The planning skills' own settings, outside every repo: a plain JSON file in the mod's folder under Claude Code's
// config dir, since a skill runs as Claude and reads it as a file. `{ "planFiles": false }` switches the plan files
// off; a missing file, or any other value, means on. Approve all and Deny all leave it alone: a skill run is started
// by the person, not by the mod.
export const SKILLS_FILE = 'ccinformer/skills.json'

export const DEFAULT_SKILLS: SkillsSettings = { planFiles: true }

// The Settings row.
export const PLAN_FILES = {
  group: 'Planning skills',
  label: 'Plan files',
  description:
    'The planning skills save the approved plan to .local/plans/, where Work › Plans shows it, and offer to write .local/ccinformer-planning.md. Off: they write nothing into the repo and build from Claude Code\'s own plan file; a handoff doc is still written.',
  note: 'Approve all and Deny all leave this as it is: it is the skills\' own setting, kept in ~/.claude/ccinformer/skills.json for every repo.',
}

export const skillsFrom = (text: string): SkillsSettings => {
  try {
    const parsed: unknown = JSON.parse(text)
    const planFiles = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { planFiles?: unknown }).planFiles : undefined
    return { planFiles: planFiles !== false }
  } catch {
    return DEFAULT_SKILLS
  }
}

export const skillsText = (s: SkillsSettings): string => JSON.stringify({ planFiles: s.planFiles }, null, 2) + '\n'

// The file as it is now; a missing or unreadable one is the defaults.
export async function readSkills($: EngineInterface, path: string): Promise<SkillsSettings> {
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? skillsFrom(text) : DEFAULT_SKILLS
}
