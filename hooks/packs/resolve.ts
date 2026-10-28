import type { PackEntryRow, PackLayerRow, PackReport } from '../../types'
import { detect, remoteMatches } from './detect'
import { parseJsonc } from './jsonc'
import { mergeLayers } from './merge'
import type { LayerInput } from './merge'
import { BUILTINS } from './node-vite'
import { needsTrust, trustOf } from './trust'
import type { StoredTrust } from './trust'
import type { PackManifest, RepoConfig, ResolvedPack } from './types'
import { checkPack, checkRealPaths, checkRepo, checkRepoAgainst, repoPaths } from './validate'

export const REPO_FILE = '.ccinformer.jsonc'
export const LOCAL_FILE = '.ccinformer.local.jsonc'

// Everything the loader read: the repo's root and remote, each marker file's text, the user packs, the repo and
// local configs, where their paths really lead, and the stored trust with the configs' hash.
export type PackInput = {
  root: string
  remote: string
  repoKey: string
  markers: Record<string, string | null>
  userPacks: { path: string; text: string }[]
  repo: string | null
  local: string | null
  isLocalIgnored: boolean
  realPaths: Record<string, string | null>
  storedTrust: StoredTrust | null
  hash: string
  now: number
}

// A repo or local config's own text, parsed and checked on its own; the loader resolves the paths it names.
export const readRepoConfig = (text: string | null): { config?: RepoConfig; reasons: string[]; isBroken: boolean } => {
  if (text === null) return { reasons: [], isBroken: false }
  const parsed = parseJsonc(text)
  if (parsed.error !== undefined) return { reasons: [parsed.error], isBroken: true }
  const checked = checkRepo(parsed.value)
  return checked.value ? { config: checked.value, reasons: [], isBroken: false } : { reasons: checked.reasons, isBroken: false }
}

export const pathsToResolve = (input: Pick<PackInput, 'repo' | 'local'>): string[] =>
  [input.repo, input.local].flatMap(text => {
    const { config } = readRepoConfig(text)
    return config ? repoPaths(config) : []
  })

// The four layers, lowest first, each checked: a file with any problem adds nothing, and the report says why.
export const resolvePack = (input: PackInput): { pack: ResolvedPack; report: PackReport } => {
  const rows: PackLayerRow[] = []
  const { user, userRows } = pickUserPack(input)
  rows.push(...userRows)
  const repo = readRepoConfig(input.repo)
  const local = readRepoConfig(input.local)

  // The built-in: the one the user pack extends, else the one the repo names, else the one detected.
  const extended = user?.extends?.map(id => BUILTINS.find(b => b.id === id)).find(Boolean)
  const named = repo.config?.pack ? BUILTINS.find(b => b.id === repo.config?.pack) : undefined
  const builtin = extended ?? named ?? detect(BUILTINS, input.markers)
  const builtinNote = extended ? 'extended by ' + user?.id : named ? 'named by ' + REPO_FILE : builtin ? 'detected' : 'nothing here matches a built-in'
  rows.unshift({ layer: 'built-in', source: builtin?.id ?? '', state: builtin ? 'loaded' : 'absent', note: builtinNote, reasons: [] })

  const layers: LayerInput[] = []
  if (builtin) layers.push({ layer: 'built-in', pack: builtin })
  if (user) layers.push({ layer: 'user', pack: user })
  for (const [layer, file, text, read] of [
    ['repo', REPO_FILE, input.repo, repo],
    ['local', LOCAL_FILE, input.local, local],
  ] as const) {
    if (text === null) {
      rows.push({ layer, source: file, state: 'absent', note: '', reasons: [] })
      continue
    }
    const below = mergeLayers(layers).pack
    const reasons = read.config
      ? [...checkRealPaths(pick(input.realPaths, repoPaths(read.config)), input.root), ...checkRepoAgainst(read.config, below)]
      : read.reasons
    const note = layer === 'local' && !input.isLocalIgnored ? 'not ignored by git: it may get committed' : ''
    if (read.config && !reasons.length) layers.push({ layer, config: read.config })
    rows.push({ layer, source: file, state: read.isBroken ? 'broken' : reasons.length ? 'refused' : 'loaded', note, reasons })
  }

  const { pack, entries } = mergeLayers(layers)
  const trust = trustOf(!!user, input.storedTrust, input.hash)
  const checks = new Map(pack.checks.map(c => [c.id, c]))
  const entryRows: PackEntryRow[] = entries.map(e => {
    const check = e.section === 'checks' ? checks.get(e.id) : undefined
    return { ...e, needsTrust: !!check && needsTrust(check) }
  })
  return {
    pack,
    report: { id: pack.id, root: input.root, remote: input.remote, repoKey: input.repoKey, hash: input.hash, layers: rows, entries: entryRows, trust, at: input.now },
  }
}

const pick = (all: Record<string, string | null>, keys: string[]): Record<string, string | null> =>
  Object.fromEntries(keys.filter(k => k in all).map(k => [k, all[k] ?? null]))

// The first valid user pack whose `match.remote` matches this repo's remote. A broken user pack is listed, since
// it might have been meant for this repo; one that matches after the first is listed as skipped.
const pickUserPack = (input: PackInput): { user: PackManifest | null; userRows: PackLayerRow[] } => {
  let user: PackManifest | null = null
  const userRows: PackLayerRow[] = []
  for (const file of input.userPacks) {
    const parsed = parseJsonc(file.text)
    if (parsed.error !== undefined) {
      userRows.push({ layer: 'user', source: file.path, state: 'broken', note: '', reasons: [parsed.error] })
      continue
    }
    const checked = checkPack(parsed.value, 'user')
    const pack = checked.value
    const reasons = pack ? (pack.extends ?? []).filter(id => !BUILTINS.some(b => b.id === id)).map(id => `extends "${id}", which isn't a built-in`) : checked.reasons
    if (!pack || reasons.length) {
      userRows.push({ layer: 'user', source: file.path, state: 'refused', note: '', reasons })
      continue
    }
    if (!input.remote || !(pack.match?.remote ?? []).some(p => remoteMatches(p, input.remote))) continue
    if (user) userRows.push({ layer: 'user', source: file.path, state: 'skipped', note: `${user.id} matched this repo first`, reasons: [] })
    else {
      user = pack
      userRows.push({ layer: 'user', source: file.path, state: 'loaded', note: 'matched ' + input.remote, reasons: [] })
    }
  }
  if (!userRows.some(r => r.state === 'loaded')) userRows.unshift({ layer: 'user', source: '', state: 'absent', note: 'no user pack matches this repo', reasons: [] })
  return { user, userRows }
}
