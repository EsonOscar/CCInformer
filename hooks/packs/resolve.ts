import type { PackEntryRow, PackLayerRow, PackReport } from '../../types'
import { detect, remoteMatches } from './detect'
import { parseJsonc } from './jsonc'
import { mergeLayers } from './merge'
import type { Entry, LayerInput } from './merge'
import { BUILTINS } from './builtins'
import { needsTrust, trustOf } from './trust'
import type { StoredTrust } from './trust'
import type { PackManifest, ResolvedPack } from './types'
import { checkPack } from './validate'

// Everything the loader read: the repo's root and remote, each marker file's text, the user packs and the stored
// trust. Packs are personal, so nothing else is read from the repo.
export type PackInput = {
  root: string
  remote: string
  repoKey: string
  markers: Record<string, string | null>
  userPacks: { path: string; text: string }[]
  storedTrust: StoredTrust | null
  now: number
}

// The two layers, lowest first, each checked: a file with any problem adds nothing, and the report says why.
export const resolvePack = (input: PackInput): { pack: ResolvedPack; report: PackReport } => {
  const rows: PackLayerRow[] = []
  const { user, userRows } = pickUserPack(input)
  rows.push(...userRows)

  // The built-in: the one the user pack extends, else the one detected.
  const extended = user?.extends?.map(id => BUILTINS.find(b => b.id === id)).find(Boolean)
  const builtin = extended ?? detect(BUILTINS, input.markers)
  const builtinNote = extended ? 'extended by ' + user?.id : builtin ? 'detected' : 'nothing here matches a built-in'
  rows.unshift({ layer: 'built-in', source: builtin?.id ?? '', state: builtin ? 'loaded' : 'absent', note: builtinNote, reasons: [] })

  const layers: LayerInput[] = []
  if (builtin) layers.push({ layer: 'built-in', pack: builtin })
  if (user) layers.push({ layer: 'user', pack: user })

  const { pack, entries } = mergeLayers(layers)
  const trust = trustOf(!!user, input.storedTrust)
  return {
    pack,
    report: { id: pack.id, root: input.root, remote: input.remote, repoKey: input.repoKey, layers: rows, entries: entryRows(pack, entries), trust, at: input.now },
  }
}

// The report's rows: a check that waits for repo trust says so, and a live approval rule carries what the gate does
// with it. A rule whose environment was switched off is off with it.
export const entryRows = (pack: ResolvedPack, entries: Entry[]): PackEntryRow[] => {
  const checks = new Map(pack.checks.map(c => [c.id, c]))
  const envOff = new Map(entries.filter(e => e.section === 'environments' && e.removedBy).map(e => [e.id, e.removedBy!]))
  return entries.map(e => {
    const check = e.section === 'checks' ? checks.get(e.id) : undefined
    const row: PackEntryRow = { ...e, needsTrust: !!check && needsTrust(check) }
    if (e.section !== 'approvals' || !e.env) return row
    const env = pack.environments.find(x => x.id === e.env)
    const rule = env?.approvals?.find(a => a.id === e.id)
    if (!env || !rule) return e.removedBy ? row : { ...row, removedBy: envOff.get(e.env) ?? row.layer }
    const mode = rule.mode ?? 'ask'
    const isLoosened = env.tone === 'prod' && (mode === 'log' || rule.scope === 'session')
    return { ...row, approval: { tone: env.tone, envLabel: env.label, tool: rule.tool, mode, scope: rule.scope, isLoosened } }
  })
}

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
    if (!pack) {
      userRows.push({ layer: 'user', source: file.path, state: 'refused', note: '', reasons: checked.reasons })
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
