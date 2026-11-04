import type { PackEntryRow } from '../../types'
import { BUILTINS } from './builtins'
import { detect, normalizeRemote, remoteMatches } from './detect'
import { parseJsonc } from './jsonc'
import { resolvePack } from './resolve'
import type { PackInput } from './resolve'
import type { PackManifest } from './types'
import { checkPack } from './validate'

// The tool Claude checks a user pack draft with (the write-pack skill): the mod's own validator and resolution, over
// the repo the session is in and the packs folder, writing nothing.
export const PACK_TOOL = 'check_pack'
export const PACK_TOOL_TEXT =
  'Checks a CCInformer user pack (the JSONC text of a <name>.pack.jsonc) with the mod\'s own validator, without writing anything. ' +
  "Returns JSON: this repo's normalized remote, the absolute packs folder and every pack in it (valid or not, whether it matches this repo, and the text of this repo's own), " +
  'the built-in packs, and for the text given every reason it would be refused, each saying how to fix it, whether a file of that name exists ' +
  'and whose it is, whether another pack loads for this repo first, and the merged entries. Call it with no text to look before drafting.'
export const PACK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The whole JSONC text of the pack, exactly as it would be saved. Leave out to look at the repo and the packs folder only.' },
    file: { type: 'string', description: 'The file name it would be saved as, <name>.pack.jsonc, no folder. Defaults to <pack id>.pack.jsonc.' },
  },
}

const PACK_FILE = /^[^\\/:]+\.pack\.jsonc$/

// A pack in the folder. `text` only for this repo's own packs (matchesRepo), so an update needs no read of a file
// outside the repo; another repo's pack never reaches the model.
export type PackFileRow = { file: string; valid: boolean; reasons: string[]; matchesRepo: boolean; text?: string }
export type DraftReport = {
  file: string
  valid: boolean
  reasons: string[]
  // A file of that name is in the packs folder, and whether that file is for this repo.
  exists: boolean
  existsMatchesRepo: boolean
  matchesRepo: boolean
  // The file that loads for this repo before the draft would, or ''.
  shadowedBy: string
  // What the draft resolves to on its own: the built-in it extends and its own entries.
  entries: PackEntryRow[]
}
export type PackToolReport = {
  repo: { root: string; remote: string }
  packsDir: string
  packs: PackFileRow[]
  builtins: { id: string; detected: boolean; pack: PackManifest }[]
  draft?: DraftReport
}

const nameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

// Whether a pack's own `match.remote` names this repo, read from the raw value, so a refused pack still shows which
// repo it was written for.
const matchesRepo = (value: unknown, remote: string): boolean => {
  const match = typeof value === 'object' && value !== null ? (value as { match?: { remote?: unknown } }).match : undefined
  const globs = Array.isArray(match?.remote) ? match.remote.filter((g): g is string => typeof g === 'string') : []
  return !!remote && globs.some(g => remoteMatches(g, remote))
}

const rowOf = (file: string, text: string, remote: string): PackFileRow => {
  const parsed = parseJsonc(text)
  if (parsed.error !== undefined) return { file, valid: false, reasons: [parsed.error], matchesRepo: false }
  const { reasons } = checkPack(parsed.value, 'user')
  return { file, valid: !reasons.length, reasons, matchesRepo: matchesRepo(parsed.value, remote) }
}

// The tool's answer: the repo, the packs folder and its packs, the built-ins, and, given a draft's text, what the
// validator says of it and how it would resolve here. `input` is what the loader reads, `packsDir` its folder.
export const checkDraft = (input: PackInput, packsDir: string, draft: { text?: string; file?: string }): PackToolReport => {
  const packs = input.userPacks.map(p => {
    const row = rowOf(nameOf(p.path), p.text, input.remote)
    return row.matchesRepo ? { ...row, text: p.text } : row
  })
  const detected = detect(BUILTINS, input.markers)?.id
  const report: PackToolReport = {
    repo: { root: input.root, remote: input.remote ? normalizeRemote(input.remote) : '' },
    packsDir,
    packs,
    builtins: BUILTINS.map(b => ({ id: b.id, detected: b.id === detected, pack: b })),
  }
  if (typeof draft.text !== 'string') return report

  const parsed = parseJsonc(draft.text)
  const id = parsed.error === undefined && typeof (parsed.value as { id?: unknown })?.id === 'string' ? (parsed.value as { id: string }).id : ''
  const file = draft.file || (id ? id + '.pack.jsonc' : '')
  const own = rowOf(file, draft.text, input.remote)
  const reasons = PACK_FILE.test(file) ? own.reasons : [`"file" must be a file name ending in .pack.jsonc, with no folder, such as "${id || 'acme-shop'}.pack.jsonc"`, ...own.reasons]
  const existing = packs.find(p => p.file === file)
  const path = packsDir + '/' + file
  // The folder as it would be with the draft saved, in the order the loader reads it.
  const after = [...input.userPacks.filter(p => nameOf(p.path) !== file), { path, text: draft.text }].sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path)))
  const loaded = resolvePack({ ...input, userPacks: after }).report.layers.find(l => l.layer === 'user' && l.state === 'loaded')
  report.draft = {
    file,
    valid: !reasons.length,
    reasons,
    exists: !!existing,
    existsMatchesRepo: !!existing?.matchesRepo,
    matchesRepo: own.matchesRepo,
    shadowedBy: own.matchesRepo && loaded && loaded.source !== path ? nameOf(loaded.source) : '',
    entries: reasons.length ? [] : resolvePack({ ...input, userPacks: [{ path, text: draft.text }] }).report.entries,
  }
  return report
}
