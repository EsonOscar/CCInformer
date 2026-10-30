import type { Finding } from '../../types'
import type { CheckSpec } from '../packs/types'
import { finding } from './findings'

// One language's file in a translation table: its repo path, and its text (null when the file isn't there).
export type TableFile = { lang: string; path: string; text: string | null }

// A table is the folder its language files sit in.
export const tableOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf('/')))

// The languages every table must carry, from the check's `options.languages`.
export const languagesOf = (check: CheckSpec): string[] => (Array.isArray(check.options?.languages) ? check.options.languages : [])

type Keys = { keys: Set<string>; lines: Map<string, number> }

// A flat JSON file's top-level keys, each with the line it is first written on; null when it isn't a JSON object.
const keysOf = (text: string): Keys | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const lines = new Map<string, number>()
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    const key = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(line)?.[1]
    if (key !== undefined && !lines.has(key)) lines.set(key, i + 1)
  })
  return { keys: new Set(Object.keys(value)), lines }
}

// "da.json", "da.json and en.json", "da.json, en.json and sv.json"
const listed = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

// An i18n-keysets check over translation tables: in each touched table, a key one required language has and another
// lacks (on the file that lacks it), a required language with no file, a file that isn't a JSON object (its table's
// keys then go uncompared), and a key another table already has in the same language (at its line). `tables` holds
// every table the check covers, one file per required language; `touched` the tables written this turn.
export const keysetFindings = (check: CheckSpec, tables: Record<string, TableFile[]>, touched: string[]): Finding[] => {
  const parsed = new Map<string, Keys | null>()
  for (const files of Object.values(tables)) for (const f of files) parsed.set(f.path, f.text === null ? null : keysOf(f.text))
  const error = (file: string, line: number, rule: string, message: string) =>
    finding(check, { file, line, rule, severity: 'error', message, ciWouldFail: check.class === 'ci' })
  const others = (table: string, lang: string) =>
    Object.entries(tables).flatMap(([t, files]) => (t === table ? [] : files.filter(f => f.lang === lang).map(f => ({ table: t, keys: parsed.get(f.path)?.keys }))))
  const out: Finding[] = []
  for (const table of touched) {
    const files = tables[table] ?? []
    const present = files.filter(f => f.text !== null)
    for (const f of files) if (f.text === null) out.push(error(f.path, 0, 'missing-file', `this table has no ${f.lang}.json`))
    const broken = present.filter(f => !parsed.get(f.path))
    for (const f of broken) out.push(error(f.path, 0, 'invalid-json', "isn't valid JSON, so its keys weren't compared"))
    if (broken.length) continue
    const sets = present.map(f => ({ f, keys: parsed.get(f.path)!.keys }))
    const union = new Set(sets.flatMap(s => [...s.keys]))
    for (const key of union) {
      const having = sets.filter(s => s.keys.has(key)).map(s => s.f.lang + '.json')
      for (const { f, keys } of sets)
        if (!keys.has(key)) out.push(error(f.path, 0, 'missing-key', `"${key}" is missing; ${listed(having)} ${having.length > 1 ? 'have' : 'has'} it`))
    }
    for (const { f, keys } of sets) {
      const elsewhere = others(table, f.lang)
      for (const key of keys) {
        const other = elsewhere.find(o => o.keys?.has(key))
        if (other) out.push(error(f.path, parsed.get(f.path)!.lines.get(key) ?? 0, 'key-in-two-tables', `"${key}" is also in ${other.table}; a key lives in one table`))
      }
    }
  }
  return out
}
