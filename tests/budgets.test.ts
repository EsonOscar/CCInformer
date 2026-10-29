import { describe, expect, test } from 'claude-code/testing'

import { atPointer, isFresh, isOver, limitOf, parseValue, pickReading, shown, verdict } from '../hooks/budgets/gauge'
import type { SourceResult } from '../hooks/budgets/gauge'
import type { BudgetSpec } from '../hooks/packs/types'

const BROTLI: BudgetSpec = {
  id: 'start-brotli',
  label: 'Start-up brotli',
  unit: 'bytes',
  direction: 'max',
  limit: { relative: 1.05, baseline: { kind: 'json', path: 'tools/bundle/baseline.json', pointer: '/start/brotli' } },
  sources: [{ kind: 'command', argv: ['node', 'report.mjs', '--check'], parse: 'Start brotli: ([\\d.]+) KB', scale: 1024 }],
  cost: 'cheap',
}
const result = (kind: SourceResult['kind'], value: number | null, staleWhy = '', error = ''): SourceResult => ({ kind, value, staleWhy, error, at: 5 })

describe('reading a value', () => {
  test("KB in a report's line become bytes, and a line without the pattern gives nothing", async () => {
    const bytes = parseValue('Start brotli: 395.3 KB, baseline 389.3 KB (1.5%, within the 5% budget)', 'Start brotli: ([\\d.]+) KB', 1024)
    expect(Math.round(bytes! * 10)).toBe(4047872)
    expect(parseValue('Start raw: 1851.4 KB', 'Start raw: ([\\d.]+) KB')).toBe(1851.4)
    expect(parseValue('nothing here', 'Start raw: ([\\d.]+) KB', 1024)).toBeNull()
    expect(parseValue('Start raw: 1 KB', '(unclosed', 1024)).toBeNull()
  })

  test('a JSON pointer leads to a number in the baseline file', async () => {
    const text = JSON.stringify({ start: { brotli: 398610, raw: 1871021, 'a/b': 3 } })
    expect(atPointer(text, '/start/brotli')).toBe(398610)
    expect(atPointer(text, '/start/a~1b')).toBe(3)
    expect(atPointer(text, '/start/missing')).toBeNull()
    expect(atPointer('{ broken', '/start/raw')).toBeNull()
  })
})

describe('against the budget', () => {
  test('a value at the baseline × 1.06 is 6% over it, past a 5% budget', async () => {
    const limit = limitOf(BROTLI, 400_000)
    expect(limit).toEqual({ limit: 420_000, baseline: 400_000 })
    const reading = pickReading(BROTLI, [result('command', 424_000)], limit)
    expect(isOver(reading)).toBe(true)
    expect(verdict(reading)).toBe('6.0% over the baseline, past the 5% budget')
    expect(verdict(pickReading(BROTLI, [result('command', 404_000)], limit))).toBe('1.0% over the baseline, within the 5% budget')
    expect(verdict(pickReading(BROTLI, [result('command', 396_000)], limit))).toBe('1.0% under the baseline, within the 5% budget')
  })

  test('a fixed limit reads as a share of it; a minimum is broken from below', async () => {
    const fixed = { ...BROTLI, limit: 500 * 1024 }
    expect(verdict(pickReading(fixed, [result('command', 250 * 1024)], limitOf(fixed, null)))).toBe('50% of 500.0 KB')
    const fps: BudgetSpec = { ...BROTLI, unit: 'fps', direction: 'min', limit: 60 }
    expect(isOver(pickReading(fps, [result('telemetry', 45)], limitOf(fps, null)))).toBe(true)
    expect(shown(404787.2, 'bytes')).toBe('395.3 KB')
  })
})

describe('which reading shows', () => {
  test('a build older than HEAD or than the last write is stale', async () => {
    expect(isFresh(2000, 1000, 1500)).toBe(true)
    expect(isFresh(900, 1000, 0)).toBe(false)
    expect(isFresh(2000, 1000, 2500)).toBe(false)
  })

  test('the first fresh source wins; else the first with a value, marked stale; else the first reason', async () => {
    const limit = limitOf(BROTLI, 400_000)
    expect(pickReading(BROTLI, [result('command', 1, 'old build'), result('ci-log', 2)], limit)).toMatchObject({ value: 2, from: 'ci-log', staleWhy: '' })
    expect(pickReading(BROTLI, [result('command', 1, 'old build'), result('ci-log', null, '', 'no run')], limit)).toMatchObject({ value: 1, from: 'command', staleWhy: 'old build' })
    expect(pickReading(BROTLI, [result('command', null, '', 'needs trust'), result('ci-log', null, '', 'no run')], limit)).toMatchObject({ value: null, from: '', error: 'needs trust' })
  })
})
