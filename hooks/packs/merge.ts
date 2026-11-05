import { LIST_SECTIONS } from './types'
import type { EnvRule, Layer, ListSection, PackManifest, ResolvedPack, Tone } from './types'

// One layer as it goes into the merge, lowest first: the built-in, then the user pack.
export type LayerInput = { layer: Layer; pack: PackManifest }

// One value of the resolved pack and the layer that set it; a later layer that changed it, or switched it off.
// An approval's entry also names its environment: rules in two environments may share an id.
export type Entry = { section: string; id: string; label: string; layer: Layer; changedBy: Layer[]; removedBy?: Layer; env?: string }

type Item = { id: string; label?: string; glob?: string; kind?: string }

const EMPTY: ResolvedPack = { id: '', processes: [], environments: [], checks: [], budgets: [], noise: [] }

const labelOf = (item: Item): string => item.label ?? item.glob ?? item.kind ?? item.id

// Arrays merge by id (a later entry's fields override), `plans` merges field by field, `detect` is replaced whole,
// and `disable` switches ids off.
export const mergeLayers = (layers: LayerInput[]): { pack: ResolvedPack; entries: Entry[] } => {
  let pack: ResolvedPack = { ...EMPTY }
  const entries = new Map<string, Entry>()
  const key = (section: string, id: string, env?: string) => section + '\u0000' + (env ? env + '/' : '') + id
  const set = (section: string, item: Item, layer: Layer, env?: string) => {
    const k = key(section, item.id, env)
    const old = entries.get(k)
    // An entry that changes only some fields of an earlier one keeps that one's label unless it names its own.
    entries.set(k, old && !old.removedBy
      ? { ...old, label: item.label ?? old.label, changedBy: [...old.changedBy, layer] }
      : { section, id: item.id, label: labelOf(item), layer, changedBy: [], ...(env ? { env } : {}) })
  }

  for (const input of layers) {
    const next = input.pack
    pack = { ...pack, id: next.id }
    for (const section of LIST_SECTIONS) {
      const list = (next[section] ?? []) as Item[]
      pack = { ...pack, [section]: mergeById(pack[section] as Item[], list) }
      for (const item of list) set(section, item, input.layer)
    }
    pack = { ...pack, environments: pack.environments.map(env => withApprovals(env, layers, input)) }
    for (const env of next.environments ?? []) for (const a of env.approvals ?? []) set('approvals', a, input.layer, env.id)
    if (next.plans) {
      pack = { ...pack, plans: { ...pack.plans, ...next.plans } }
      set('plans', { id: 'plans', label: next.plans.globs.join(', ') }, input.layer)
    }
    for (const id of next.disable ?? []) {
      pack = disableId(pack, id)
      // Each entry with the id, in any section and environment, under its own key.
      for (const [k, entry] of entries) if (entry.id === id && !entry.removedBy) entries.set(k, { ...entry, removedBy: input.layer })
    }
  }
  return { pack, entries: [...entries.values()] }
}

const mergeById = <T extends Item>(old: T[], added: T[]): T[] => {
  const merged = old.map(item => {
    const next = added.find(a => a.id === item.id)
    return next ? { ...item, ...next } : item
  })
  return [...merged, ...added.filter(a => !old.some(o => o.id === a.id))]
}

// An environment's approvals merge by id across the layers that define it, as the lists do.
const withApprovals = (env: EnvRule, layers: LayerInput[], upTo: LayerInput): EnvRule => {
  let approvals: EnvRule['approvals'] = []
  for (const input of layers) {
    const defined = input.pack.environments?.find(e => e.id === env.id)
    approvals = mergeById(approvals, defined?.approvals ?? [])
    if (input === upTo) break
  }
  return approvals.length ? { ...env, approvals } : env
}

const disableId = (pack: ResolvedPack, id: string): ResolvedPack => {
  let next = { ...pack }
  for (const section of LIST_SECTIONS) next = { ...next, [section]: (next[section] as Item[]).filter(item => item.id !== id) }
  next = { ...next, environments: next.environments.map(env => (env.approvals ? { ...env, approvals: env.approvals.filter(a => a.id !== id) } : env)) }
  if (id === 'plans') next = { ...next, plans: undefined }
  return next
}

const TONE_RANK: Record<Tone, number> = { local: 0, shared: 1, prod: 2 }

export const hostMatches = (pattern: string, host: string): boolean =>
  new RegExp('^' + pattern.toLowerCase().split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(host.toLowerCase())

// The tone of a host: the strictest of the environments whose patterns it matches, or null when none does.
export const hostTone = (pack: ResolvedPack, host: string): Tone | null =>
  pack.environments
    .filter(e => (e.hostPatterns ?? []).some(p => hostMatches(p, host)))
    .reduce<Tone | null>((worst, e) => (worst === null || TONE_RANK[e.tone] > TONE_RANK[worst] ? e.tone : worst), null)

export const SECTION_ORDER: string[] = [...(LIST_SECTIONS as readonly ListSection[]), 'approvals', 'plans']
