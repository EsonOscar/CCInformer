import { LIST_SECTIONS } from './types'
import type { EnvRule, Layer, ListSection, PackManifest, RepoConfig, ResolvedPack, Tone } from './types'

// One layer as it goes into the merge, lowest first: a pack, or a repo or local config.
export type LayerInput = { layer: 'built-in' | 'user'; pack: PackManifest } | { layer: 'repo' | 'local'; config: RepoConfig }

// One value of the resolved pack and the layer that set it; a later layer that changed it, or switched it off.
export type Entry = { section: string; id: string; label: string; layer: Layer; changedBy: Layer[]; removedBy?: Layer }

type Item = { id: string; label?: string; glob?: string; kind?: string }

const EMPTY: ResolvedPack = { id: '', processes: [], environments: [], checks: [], budgets: [], locks: [], noise: [], signals: [], claudeMd: [] }

const labelOf = (item: Item): string => item.label ?? item.glob ?? item.kind ?? item.id

// Arrays merge by id (a later entry's fields override), `plans` merges field by field, `preflight` and `detect`
// are replaced whole, and `disable` switches ids off. A repo or local config adds locks and hosts and tightens
// budgets; it was checked before it got here.
export const mergeLayers = (layers: LayerInput[]): { pack: ResolvedPack; entries: Entry[] } => {
  let pack: ResolvedPack = { ...EMPTY }
  const entries = new Map<string, Entry>()
  const key = (section: string, id: string) => section + '\u0000' + id
  const set = (section: string, item: Item, layer: Layer) => {
    const old = entries.get(key(section, item.id))
    entries.set(key(section, item.id), old && !old.removedBy
      ? { ...old, label: labelOf(item), changedBy: [...old.changedBy, layer] }
      : { section, id: item.id, label: labelOf(item), layer, changedBy: [] })
  }

  for (const input of layers) {
    if ('pack' in input) {
      const next = input.pack
      pack = { ...pack, id: next.id }
      for (const section of LIST_SECTIONS) {
        const list = (next[section] ?? []) as Item[]
        pack = { ...pack, [section]: mergeById(pack[section] as Item[], list) }
        for (const item of list) set(section, item, input.layer)
      }
      pack = { ...pack, environments: pack.environments.map(env => withApprovals(env, layers, input)) }
      for (const env of next.environments ?? []) for (const a of env.approvals ?? []) set('approvals', a, input.layer)
      if (next.plans) {
        pack = { ...pack, plans: { ...pack.plans, ...next.plans } }
        set('plans', { id: 'plans', label: next.plans.globs.join(', ') }, input.layer)
      }
      if (next.preflight) {
        pack = { ...pack, preflight: next.preflight }
        set('preflight', { id: 'preflight', label: next.preflight.steps.length + ' steps' }, input.layer)
      }
      for (const id of next.disable ?? []) {
        pack = disableId(pack, id)
        for (const entry of entries.values()) if (entry.id === id && !entry.removedBy) entries.set(key(entry.section, id), { ...entry, removedBy: input.layer })
      }
    } else {
      const { config, layer } = input
      const reason = layer + ' config'
      const locks = [
        ...(config.locks?.exclusive ?? []).map(glob => ({ id: 'repo:' + glob, glob, mode: 'exclusive' as const, reason })),
        ...(config.locks?.warn ?? []).map(glob => ({ id: 'repo:' + glob, glob, mode: 'warn' as const, reason })),
      ]
      pack = { ...pack, locks: mergeById(pack.locks, locks) }
      for (const lock of locks) set('locks', lock, layer)
      for (const tone of ['shared', 'prod'] as const) {
        const hosts = config.envHosts?.[tone] ?? []
        if (!hosts.length) continue
        pack = { ...pack, environments: addHosts(pack.environments, tone, hosts, layer) }
        for (const host of hosts) set('hosts', { id: host, label: tone + ' host' }, layer)
      }
      for (const [id, { limit }] of Object.entries(config.budgets ?? {})) {
        pack = { ...pack, budgets: pack.budgets.map(b => (b.id === id ? { ...b, limit } : b)) }
        const old = entries.get(key('budgets', id))
        if (old) entries.set(key('budgets', id), { ...old, changedBy: [...old.changedBy, layer] })
      }
      if (config.plans) {
        pack = { ...pack, plans: { ...pack.plans, ...config.plans, globs: config.plans.globs ?? pack.plans?.globs ?? [] } }
        set('plans', { id: 'plans', label: (pack.plans?.globs ?? []).join(', ') }, layer)
      }
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
    if ('pack' in input) {
      const defined = input.pack.environments?.find(e => e.id === env.id)
      approvals = mergeById(approvals, defined?.approvals ?? [])
    }
    if (input === upTo) break
  }
  return approvals.length ? { ...env, approvals } : env
}

const disableId = (pack: ResolvedPack, id: string): ResolvedPack => {
  let next = { ...pack }
  for (const section of LIST_SECTIONS) next = { ...next, [section]: (next[section] as Item[]).filter(item => item.id !== id) }
  next = { ...next, environments: next.environments.map(env => (env.approvals ? { ...env, approvals: env.approvals.filter(a => a.id !== id) } : env)) }
  if (id === 'plans') next = { ...next, plans: undefined }
  if (id === 'preflight') next = { ...next, preflight: undefined }
  return next
}

// A repo's hosts join every environment of that tone, or a new one when the packs below have none.
const addHosts = (envs: EnvRule[], tone: Tone, hosts: string[], layer: Layer): EnvRule[] => {
  if (!envs.some(e => e.tone === tone)) return [...envs, { id: layer + ':' + tone, label: tone, tone, hostPatterns: hosts }]
  return envs.map(e => (e.tone === tone ? { ...e, hostPatterns: [...new Set([...(e.hostPatterns ?? []), ...hosts])] } : e))
}

const TONE_RANK: Record<Tone, number> = { local: 0, shared: 1, prod: 2 }

export const hostMatches = (pattern: string, host: string): boolean =>
  new RegExp('^' + pattern.toLowerCase().split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(host.toLowerCase())

// The tone of a host: the strictest of the environments whose patterns it matches, or null when none does.
export const hostTone = (pack: ResolvedPack, host: string): Tone | null =>
  pack.environments
    .filter(e => (e.hostPatterns ?? []).some(p => hostMatches(p, host)))
    .reduce<Tone | null>((worst, e) => (worst === null || TONE_RANK[e.tone] > TONE_RANK[worst] ? e.tone : worst), null)

export const SECTION_ORDER: string[] = [...(LIST_SECTIONS as readonly ListSection[]), 'approvals', 'hosts', 'plans', 'preflight']
