import { describe, expect, test } from 'claude-code/testing'

import { keysetFindings, tableOf } from '../hooks/checks/i18n'
import type { TableFile } from '../hooks/checks/i18n'
import type { CheckSpec } from '../hooks/packs/types'

// A synthetic shop's translation tables: a shared one and one per module, da, en and sv required.
const CHECK: CheckSpec = {
  id: 'i18n',
  label: 'Translation keys',
  on: ['src/i18n/common/*.json', 'src/modules/*/i18n/*.json'],
  analyzer: 'i18n-keysets',
  cost: 'turn',
  class: 'ci',
  options: { languages: ['da', 'en', 'sv'] },
}
const COMMON = 'src/i18n/common'
const CART = 'src/modules/cart/i18n'

// A flat table file, two spaces in, one key a line, as the files are written.
const json = (entries: Record<string, string>) => '{\n' + Object.entries(entries).map(([k, v]) => `  "${k}": "${v}"`).join(',\n') + '\n}\n'
const table = (dir: string, texts: Record<string, string | null>): TableFile[] =>
  Object.entries(texts).map(([lang, text]) => ({ lang, path: `${dir}/${lang}.json`, text }))
const full = (dir: string, keys: string[]) => table(dir, Object.fromEntries(['da', 'en', 'sv'].map(l => [l, json(Object.fromEntries(keys.map(k => [k, `${k} (${l})`])))])))
const brief = (fs: { file: string; line?: number; rule?: string; message: string }[]) => fs.map(f => `${f.file}:${f.line} ${f.rule} ${f.message}`)

describe('translation keys', () => {
  test('a table is the folder its files sit in', async () => {
    expect(tableOf('src/modules/cart/i18n/da.json')).toBe(CART)
    expect(tableOf('da.json')).toBe('')
  })

  test('every required language with the same keys gives nothing', async () => {
    const tables = { [COMMON]: full(COMMON, ['save', 'cancel']), [CART]: full(CART, ['cart_title']) }
    expect(keysetFindings(CHECK, tables, [COMMON, CART])).toEqual([])
  })

  test('a key en and da have and sv lacks is a finding on sv.json, failing CI', async () => {
    const tables = {
      [CART]: table(CART, {
        da: json({ cart_title: 'Kurv', cart_empty: 'Kurven er tom' }),
        en: json({ cart_title: 'Cart', cart_empty: 'The cart is empty' }),
        sv: json({ cart_title: 'Kundvagn' }),
      }),
    }
    const found = keysetFindings(CHECK, tables, [CART])
    expect(brief(found)).toEqual([`${CART}/sv.json:0 missing-key "cart_empty" is missing; da.json and en.json have it`])
    expect(found[0]).toMatchObject({ severity: 'error', class: 'ci', ciWouldFail: true, check: 'i18n' })
  })

  test('a key only one language has names that one file', async () => {
    const tables = { [CART]: table(CART, { da: json({ a: '1', extra: 'x' }), en: json({ a: '1' }), sv: json({ a: '1' }) }) }
    expect(brief(keysetFindings(CHECK, tables, [CART]))).toEqual([
      `${CART}/en.json:0 missing-key "extra" is missing; da.json has it`,
      `${CART}/sv.json:0 missing-key "extra" is missing; da.json has it`,
    ])
  })

  test('a table without one of the languages says so, and the others are still compared', async () => {
    const tables = { [CART]: table(CART, { da: json({ a: '1' }), en: json({ a: '1', b: '2' }), sv: null }) }
    expect(brief(keysetFindings(CHECK, tables, [CART]))).toEqual([
      `${CART}/sv.json:0 missing-file this table has no sv.json`,
      `${CART}/da.json:0 missing-key "b" is missing; en.json has it`,
    ])
  })

  test('a key another table already has is a finding at its line, only in the table written this turn', async () => {
    const tables = {
      [COMMON]: full(COMMON, ['save', 'cancel']),
      [CART]: full(CART, ['cart_title', 'save']),
    }
    expect(brief(keysetFindings(CHECK, tables, [CART]))).toEqual(
      ['da', 'en', 'sv'].map(l => `${CART}/${l}.json:3 key-in-two-tables "save" is also in ${COMMON}; a key lives in one table`),
    )
  })

  test("a file that isn't JSON says so, and its table's keys aren't compared", async () => {
    const tables = { [CART]: table(CART, { da: json({ a: '1' }), en: '{ "a": "1",', sv: json({}) }) }
    expect(brief(keysetFindings(CHECK, tables, [CART]))).toEqual([`${CART}/en.json:0 invalid-json isn't valid JSON, so its keys weren't compared`])
  })

  test('an advise check reports the same, as a project rule', async () => {
    const tables = { [CART]: table(CART, { da: json({ a: '1' }), en: json({ a: '1' }), sv: json({}) }) }
    const [found] = keysetFindings({ ...CHECK, class: 'advise' }, tables, [CART])
    expect(found).toMatchObject({ rule: 'missing-key', severity: 'error', ciWouldFail: false, class: 'advise' })
  })
})
