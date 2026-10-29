import type { Area } from '../types'

// A sub-view or action and the key that reaches it. A key is unique within its area plus the global keys
// (a test holds this), since two hotkeys on one site clash and the later one wins.
export type KeyDef = { id: string; label: string; key: string }
export type AreaDef = { id: Area; digit: string; label: string; views: KeyDef[] }

// The digits switch areas and stay fixed, so Debug is 5 even while Timeline isn't drawn.
export const AREAS: AreaDef[] = [
  {
    id: 'now',
    digit: '1',
    label: 'Now',
    views: [
      { id: 'env', label: 'Env', key: 'e' },
      { id: 'sessions', label: 'Sessions', key: 's' },
    ],
  },
  {
    id: 'code',
    digit: '2',
    label: 'Code',
    views: [
      { id: 'git', label: 'Git', key: 'g' },
      { id: 'rules', label: 'Rules', key: 'k' },
      { id: 'budgets', label: 'Budgets', key: 'b' },
    ],
  },
  {
    id: 'work',
    digit: '3',
    label: 'Work',
    views: [
      { id: 'runs', label: 'Runs', key: 'w' },
      { id: 'stats', label: 'Stats', key: 's' },
      { id: 'plans', label: 'Plans', key: 't' },
    ],
  },
  { id: 'timeline', digit: '4', label: 'Timeline', views: [] },
  {
    id: 'debug',
    digit: '5',
    label: 'Debug',
    views: [
      { id: 'tools', label: 'Calls', key: 't' },
      { id: 'requests', label: 'Requests', key: 'q' },
      { id: 'context', label: 'Context', key: 'c' },
      { id: 'pack', label: 'Pack', key: 'p' },
    ],
  },
]

export const REFRESH_KEY = 'r'

// Each area's actions; the views take their hotkeys from here.
export const ACTIONS = {
  now: {},
  code: { fetch: 'u', allFiles: 'f', diffPane: 'd', dismiss: 'x', measure: 'm' },
  work: { phasePrev: 'p', phaseNext: 'n', followLive: 'l', closeRun: 'x', nextWorkflow: 'o', archive: 'a' },
  timeline: {},
  debug: { trust: 'a' },
} as const satisfies Record<Area, Record<string, string>>

// An area is drawn once it has a view to show.
export const isBuilt = (area: AreaDef): boolean => area.views.length > 0

export const areaDef = (id: Area): AreaDef => AREAS.find(a => a.id === id) ?? AREAS[0]!

export const isArea = (v: unknown): v is Area => AREAS.some(a => a.id === v)

// Every key reachable while an area shows: the global ones, its views' and its actions'.
export const keysOf = (area: AreaDef): string[] => [
  ...AREAS.map(a => a.digit),
  REFRESH_KEY,
  ...area.views.map(v => v.key),
  ...Object.values(ACTIONS[area.id] as Record<string, string>),
]

// The tab names before the areas, which commands and the store may still hold.
const OLD_NAMES: Record<string, { area: Area; view: string }> = {
  agents: { area: 'work', view: 'runs' },
  calls: { area: 'debug', view: 'tools' },
}

// What `/ccinformer <arg>` opens: a built area by name, or the area holding a view of that name. Null otherwise.
export const areaFor = (arg: string): { area: Area; view?: string } | null => {
  const name = arg.trim().toLowerCase()
  const area = AREAS.find(a => a.id === name && isBuilt(a))
  if (area) return { area: area.id }
  const holder = AREAS.find(a => a.views.some(v => v.id === name))
  return holder ? { area: holder.id, view: name } : (OLD_NAMES[name] ?? null)
}

// The names a command takes, for its hint and for an unknown one.
export const areaNames = (): string[] => AREAS.filter(isBuilt).map(a => a.id)
