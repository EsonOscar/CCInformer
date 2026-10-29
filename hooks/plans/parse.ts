import type { PlanCheckpoint, PlanStatus } from '../../types'
import type { PlanSpec } from '../packs/types'

// What a checkpoint id looks like when the pack doesn't say: CP3, C7, R3a, PR 4, PR 4b.
export const DEFAULT_CHECKPOINT = '(?:CP|C|R|PR ?)\\d+[a-z]?'
// What marks a checkpoint done when the pack doesn't say; a struck-through id counts too.
export const DEFAULT_DONE = ['merged as #\\d+', '✅', '\\b(?:DONE|[Dd]one|[Pp]assed)\\b']
export const DEFAULT_PR_REF = '#(\\d+)'
const PARTLY = /🟡|\bPARTLY\b/
const DROPPED = /\b(?:[Dd]ropped|[Ss]uperseded|[Oo]bsolete|DROPPED)\b/

// Where a checkpoint can be defined: a heading below the plan's title, a table row's first cell, or a bold label that
// starts a line (or a list item); a mid-sentence mention never is. `rest` is what can name it when the lead holds only
// ids (the text after a bold label, a row's second cell); `marks` is where its status is read: the whole line, or a
// row's first two cells (later cells are notes about other things).
const leadOf = (line: string): { lead: string; rest: string; marks: string } | null => {
  const heading = line.match(/^#{2,6}\s+(.*)$/)
  if (heading) return { lead: heading[1]!, rest: '', marks: line }
  const row = line.match(/^\|([^|]*)\|([^|]*)/)
  if (row && !/^\s*:?-{3,}/.test(row[1]!)) return { lead: row[1]!.trim(), rest: row[2]!, marks: row[1]! + '|' + row[2]! }
  const bold = line.match(/^(?:[-*+]\s+|\d+\.\s+)?(?:~~)?\*\*(.+?)\*\*(.*)$/)
  return bold ? { lead: bold[1]!, rest: bold[2]!, marks: line } : null
}

const stripMarks = (s: string) => s.replace(/\*\*|~~|`/g, '').trim()

// The ids a definition starts with: one, a list ("CP1, CP1b"), or a range of numbered ids ("CP1\u2013CP3", "CP8-CP10").
export const leadingIds = (lead: string, pattern: string): string[] => {
  const id = `(${pattern})`
  const first = stripMarks(lead).match(new RegExp(`^${id}(?![\\w])`))
  if (!first) return []
  const ids = [first[1]!]
  let rest = stripMarks(lead).slice(first[0].length)
  for (;;) {
    const next = rest.match(new RegExp(`^\\s*(\u2013|\u2014|-|,|/|&|and)\\s*${id}(?![\\w])`))
    if (!next) break
    const [, sep, nextId] = next
    const last = ids[ids.length - 1]!
    const range = (sep === '\u2013' || sep === '-') && last.match(/^(.*?)(\d+)$/)
    const end = nextId!.match(/^(.*?)(\d+)$/)
    const prefix = range ? (range[1] ?? '') : null
    if (range && end && prefix === end[1]) for (let n = Number(range[2]) + 1; n < Number(end[2]); n++) ids.push(prefix + n)
    ids.push(nextId!)
    rest = rest.slice(next[0].length)
  }
  // A definition's ids end the lead or are followed by punctuation ("R3: foundation", "CP1, storage"); prose after an
  // id ("R5a (server-side signing) changes ...") makes the line a mention.
  if (!/^\s*($|[:,.;|/\u2014\u2013]|-\s)/.test(rest)) return []
  return ids.map(i => i.replace(/\s+/g, ' '))
}

// A definition's status, from the markers on its own line. Done wins (it is the strongest claim), then dropped, then
// partly; anything else is open.
export const statusOf = (line: string, id: string, done: RegExp[]): PlanStatus => {
  const struck = new RegExp(`~~[^~]*\\b${id.replace(/\s/g, '\\s')}\\b[^~]*~~`).test(line)
  if (struck || done.some(r => r.test(line))) return 'done'
  if (DROPPED.test(line)) return 'dropped'
  return PARTLY.test(line) ? 'partly' : 'open'
}

const MAX_TITLE = 80
// A title without markdown, status words or emoji (a plan's own ⏸, ✅ or 🟡); the warning sign stays, as it carries
// meaning the pane shows elsewhere too.
const tidy = (s: string) =>
  stripMarks(s)
    .replace(/(?!⚠)\p{Extended_Pictographic}️?|\b(?:DONE|PARTLY|TODO)\b/gu, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:,.\u2014\u2013-]+|[\s:,.\u2014\u2013-]+$/g, '')
    .trim()

// The checkpoint's name: the rest of its definition after the ids, up to a spaced em dash (where plans put a status), without
// markers; when that's empty, the text that follows the definition.
const titleOf = (lead: string, rest: string, ids: string[]): string => {
  const name = (s: string) => tidy(s.split(' \u2014 ')[0]!)
  const own = name(stripMarks(lead).replace(new RegExp(`^.*?${ids[ids.length - 1]!.replace(/\s/g, '\\s')}`), ''))
  const title = own || name(stripMarks(rest))
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1) + '…' : title
}

// Every checkpoint a plan's text defines, in order, each once: a repeated id keeps its first name and line, and takes
// the strongest status any of its definitions gives. PR numbers on a definition's line are kept.
export const parsePlan = (text: string, spec: Pick<PlanSpec, 'checkpoint' | 'done' | 'prRef'>): { title: string; checkpoints: PlanCheckpoint[] } => {
  const pattern = spec.checkpoint || DEFAULT_CHECKPOINT
  const done = (spec.done?.length ? spec.done : DEFAULT_DONE).map(d => new RegExp(d))
  const prRef = new RegExp(spec.prRef || DEFAULT_PR_REF, 'g')
  const rank: Record<PlanStatus, number> = { open: 0, partly: 1, dropped: 2, done: 3 }
  const byId = new Map<string, PlanCheckpoint>()
  // Ids whose name came from a definition shared with other ids ("R7\u2013R12, M, R13"); their own definition renames them.
  const shared = new Set<string>()
  let title = ''
  let inCode = false
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) inCode = !inCode
    if (inCode) return
    if (!title) title = line.match(/^#\s+(.*)$/)?.[1]?.trim() ?? ''
    const def = leadOf(line)
    if (def === null) return
    const ids = leadingIds(def.lead, pattern)
    for (const id of ids) {
      const status = statusOf(def.marks, id, done)
      const prs = [...new Set([...line.matchAll(prRef)].map(m => Number(m[1])).filter(Number.isFinite))]
      const seen = byId.get(id)
      const title = titleOf(def.lead, def.rest, ids)
      if (!seen) {
        byId.set(id, { id, title, status, prs, line: i + 1 })
        if (ids.length > 1) shared.add(id)
        continue
      }
      const renamed = shared.has(id) && ids.length === 1 && title
      if (renamed) shared.delete(id)
      byId.set(id, {
        ...seen,
        title: renamed ? title : seen.title,
        status: rank[status] > rank[seen.status] ? status : seen.status,
        prs: [...new Set([...seen.prs, ...prs])],
      })
    }
  })
  return { title, checkpoints: [...byId.values()] }
}
