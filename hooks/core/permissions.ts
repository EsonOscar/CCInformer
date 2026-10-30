import type { PermissionChoices } from '../../types'

// What CCInformer does by itself, each on a switch in Debug › Settings. A key, button or /ccinformer command the person
// uses is never gated: only what happens on its own. The Safety group warns before harm (a process aimed at production),
// so Approve all and Deny all leave it as it is; each of its switches still turns off by hand.

export type PermissionGroup = 'claude' | 'ask' | 'notify' | 'show' | 'background' | 'safety'
export type PermissionDef = { id: string; group: PermissionGroup; label: string; description: string; isOnByDefault: boolean }

export const PERMISSION_GROUPS: { id: PermissionGroup; label: string }[] = [
  { id: 'claude', label: 'Told to Claude' },
  { id: 'ask', label: 'Questions' },
  { id: 'notify', label: 'Toasts and notifications' },
  { id: 'show', label: 'Shown by itself' },
  { id: 'background', label: 'In the background' },
  { id: 'safety', label: 'Safety' },
]

export const SAFETY_NOTE = 'Approve all and Deny all leave these as they are'

export const PERMISSIONS = [
  {
    id: 'claude.inlineNotes',
    group: 'claude',
    label: 'Inline check notes',
    description: 'Tells Claude what the inline checks find, in the result of each Edit or Write.',
    isOnByDefault: true,
  },
  {
    id: 'claude.turnNotes',
    group: 'claude',
    label: 'Turn check notes',
    description: 'Tells Claude what the turn checks found, with your next typed message.',
    isOnByDefault: true,
  },
  {
    id: 'claude.ciHandoff',
    group: 'claude',
    label: 'Look into failed CI',
    description: "In a repo set to active CI mode (i in Code › Git), hands Claude one read-only turn with a failed check's logs. Uses tokens.",
    isOnByDefault: true,
  },
  {
    id: 'ask.repoTrust',
    group: 'ask',
    label: 'Ask about repo trust',
    description: "Asks once per repo, the first time a check needs the repo's own tools. Off: those checks wait until you allow them in Debug › Pack.",
    isOnByDefault: true,
  },
  { id: 'notify.ciToast', group: 'notify', label: 'CI finished toast', description: "A toast when a commit's checks finish.", isOnByDefault: true },
  {
    id: 'notify.ciOs',
    group: 'notify',
    label: 'CI finished notification',
    description: "A desktop notification when a commit's checks finish.",
    isOnByDefault: true,
  },
  {
    id: 'notify.plans',
    group: 'notify',
    label: 'Plans toasts',
    description: "A toast when a plan's PR merges, and a daily reminder about finished plans (the reminder comes with Plans in the background).",
    isOnByDefault: true,
  },
  { id: 'notify.memory', group: 'notify', label: 'Low memory toast', description: 'A toast when free memory runs low.', isOnByDefault: true },
  {
    id: 'show.paneReopen',
    group: 'show',
    label: 'Reopen the pane',
    description: 'Opens the pane at session start when it was open as the last session ended.',
    isOnByDefault: true,
  },
  {
    id: 'bg.gitOnEdit',
    group: 'background',
    label: 'Git after edits',
    description: 'Reads git, and CI when the commit moved, after Claude changes files.',
    isOnByDefault: true,
  },
  {
    id: 'bg.ciWatch',
    group: 'background',
    label: 'Watch CI',
    description:
      "Asks gh every 8 s while checks run and for 3 minutes after a push, pane open or closed. Off: CI is read only while Code is shown or after Claude's edits move the commit.",
    isOnByDefault: true,
  },
  {
    id: 'bg.turnChecks',
    group: 'background',
    label: 'Turn checks',
    description: 'Runs ESLint (repo trust needed) and the translation-key check once a turn that wrote files ends.',
    isOnByDefault: true,
  },
  {
    id: 'bg.plansPoll',
    group: 'background',
    label: 'Plans in the background',
    description: "Asks gh about the plans' PRs every 10 minutes while Work › Plans isn't shown.",
    isOnByDefault: true,
  },
  {
    id: 'bg.memoryProbe',
    group: 'background',
    label: 'Memory probe',
    description: 'Reads free memory every 30 s while a heavy process Claude started runs.',
    isOnByDefault: true,
  },
  {
    id: 'bg.sessionBeat',
    group: 'background',
    label: 'Tell other sessions',
    description: 'Writes what this session is doing every 15 s, for their Sessions view. Off also takes this session out of them.',
    isOnByDefault: true,
  },
  {
    id: 'safety.envBand',
    group: 'safety',
    label: 'Environment band',
    description: 'The band above the prompt while a process Claude started targets a shared or production environment.',
    isOnByDefault: true,
  },
  {
    id: 'safety.prodStatus',
    group: 'safety',
    label: 'Production status line',
    description: 'The status line while a process Claude started targets production.',
    isOnByDefault: true,
  },
] as const satisfies readonly PermissionDef[]

export type PermissionId = (typeof PERMISSIONS)[number]['id']
export type May = (id: PermissionId) => boolean

const defOf = (id: string): PermissionDef | undefined => (PERMISSIONS as readonly PermissionDef[]).find(d => d.id === id)
const isOrdinary = (id: string): boolean => {
  const def = defOf(id)
  return !!def && def.group !== 'safety'
}

// Nothing chosen: every permission at its default, which is today's behaviour.
export const NO_CHOICES: PermissionChoices = { base: 'defaults', set: {} }

// The stored choices as this version reads them: anything odd is no choice at all, a base other than 'off' is the
// defaults, and only yes/no entries count. Ids this version doesn't know are kept, so a newer build's choices survive.
export const choicesFrom = (stored: unknown): PermissionChoices => {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return NO_CHOICES
  const { base, set } = stored as { base?: unknown; set?: unknown }
  const entries = typeof set === 'object' && set !== null && !Array.isArray(set) ? Object.entries(set) : []
  return { base: base === 'off' ? 'off' : 'defaults', set: Object.fromEntries(entries.filter(([, v]) => typeof v === 'boolean')) }
}

// A switch set by hand wins; otherwise a Safety permission takes its default, and an ordinary one follows Deny all.
export const isAllowed = (c: PermissionChoices, id: PermissionId): boolean => {
  const chosen = c.set[id]
  if (typeof chosen === 'boolean') return chosen
  const def = defOf(id)
  if (!def) return false
  if (def.group === 'safety') return def.isOnByDefault
  return c.base === 'off' ? false : def.isOnByDefault
}

// Approve all or Deny all: every ordinary permission of this version on or off. What isn't theirs to change (the
// Safety switches, ids this version doesn't know) is kept. Deny all is a base, so a permission added later starts off
// too; Approve all keeps the defaults as its base, so one added later starts at its own default.
export const allSet = (c: PermissionChoices, isOn: boolean): PermissionChoices => {
  const kept = Object.fromEntries(Object.entries(c.set).filter(([id]) => !isOrdinary(id)))
  if (!isOn) return { base: 'off', set: kept }
  const on = Object.fromEntries(PERMISSIONS.filter(d => isOrdinary(d.id)).map(d => [d.id, true]))
  return { base: 'defaults', set: { ...kept, ...on } }
}

export const toggled = (c: PermissionChoices, id: PermissionId): PermissionChoices => ({ ...c, set: { ...c.set, [id]: !isAllowed(c, id) } })

// Every ordinary permission off: the mod only shows what the person opens.
export const isPassive = (c: PermissionChoices): boolean => PERMISSIONS.every(d => d.group === 'safety' || !isAllowed(c, d.id))

const groupLabel = (group: PermissionGroup): string => PERMISSION_GROUPS.find(g => g.id === group)?.label ?? group

// What the explain button says once pressed.
export const EXPLAIN_TEXTS = {
  sent: "Asked Claude to explain these settings: it answers once it's free",
  refused: (why: string) => `Claude Code didn't take the prompt: ${why}`,
}

// The prompt the explain button hands Claude: every permission, whether it's on and what it does.
export const explainPrompt = (c: PermissionChoices): string =>
  [
    'CCInformer, a Claude Code mod, lists below what it may do on its own and whether each is on. Explain each in plain words: ' +
      'what it does, what it costs (tokens, commands, interruptions) and what turning it off changes. Answer from this message alone; ' +
      'no tools are needed.',
    '',
    ...PERMISSION_GROUPS.flatMap(g =>
      PERMISSIONS.filter(d => d.group === g.id).map(d => `- ${isAllowed(c, d.id) ? 'On' : 'Off'} · ${groupLabel(g.id)} · ${d.label}: ${d.description}`),
    ),
    '',
    'Approve all and Deny all switch every one except the Safety group; keys, buttons and /ccinformer commands in the pane always work.',
  ].join('\n')
