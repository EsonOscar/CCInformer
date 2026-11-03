// Runs audit-docs-fanout.js with stub agents, so the whole flow is checked with no model calls.
// Run from the skill folder: node tests/test_fanout.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'audit-docs-fanout.js'), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const body = source.replace('export const meta', 'const meta')

// handler(label, prompt, opts) returns the stub agent's result for one call.
async function run(args, handler) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt, opts })
    return handler(opts.label, prompt, opts)
  }
  const parallel = (fns) => Promise.all(fns.map(f => f()))
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)
  const result = await fn(args, agent, parallel, () => {}, () => {})
  return { result, calls }
}

const baseArgs = (over = {}) => ({
  context: 'test', root: '/repo', date: '2026-11-02', history: { file: 'history.md', heading: '## 2026-11-02: docs audit' },
  docs: [{ file: 'a.md', kind: 'current', tracked: true }, { file: 'history.md', kind: 'history', tracked: false }],
  auditors: [{ key: 'one', brief: 'b', role: 'audit', words: 100, ranges: [{ file: 'a.md', start: 1, end: 50 }] }],
  ...over,
})
const row = (over) => ({ category: 'DRIFT', action: 'EDIT', file: 'a.md', start: 3, end: 3, first_line: 'line three of a', new_text: 'new text here', problem: 'p', evidence: ['a.md:3'], ...over })
const owned = (prompt) => {
  const m = /BEGIN OWNED[^\n]*\n(.*)\nEND OWNED/s.exec(prompt)
  return m ? JSON.parse(m[1]).map(c => c.id) : []
}
const second = (prompt) => {
  const m = /BEGIN SECOND OPINION[^\n]*\n(.*)\nEND SECOND OPINION/s.exec(prompt)
  return m ? JSON.parse(m[1]).map(c => c.id) : []
}
let failures = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`) } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.message}`) }
}

await test('bad args throw', async () => {
  const bad = [
    baseArgs({ date: undefined }),
    baseArgs({ docs: [{ file: 'a.md', kind: 'nonsense', tracked: true }] }),
    baseArgs({ auditors: [{ key: 'Bad-Key', brief: 'b', words: 10, ranges: [] }] }),
    baseArgs({ auditors: [{ key: 'user', brief: 'b', words: 10, ranges: [] }] }),
    baseArgs({ auditors: [{ key: 'one', brief: 'b', words: 10, ranges: [{ file: 'a.md', start: 1, end: 20 }] }, { key: 'two', brief: 'b', words: 10, ranges: [{ file: 'a.md', start: 20, end: 30 }] }] }),
    baseArgs({ auditors: [{ key: 'one', brief: 'b', words: 8001, ranges: [] }] }),
    baseArgs({ auditors: [{ key: 'one', brief: 'b', role: 'extract', words: 3001, ranges: [] }] }),
    baseArgs({ verifiers: [{ key: 'evidence', owns: ['MOVE', 'DRIFT', 'STALE_STATUS', 'HISTORY_LEAK', 'BROKEN_REF', 'CONTRADICTION', 'MISPLACED', 'INCOMPLETE_LIST', 'DUPLICATE'], focus: 'f' }] }),
    baseArgs({ verifiers: [{ key: 'keep', owns: ['MOVE', 'DRIFT'], focus: 'f' }] }),
    baseArgs({ auditors: Array.from({ length: 11 }, (_, i) => ({ key: `a${i}`, brief: 'b', words: 10, ranges: [] })) }),
  ]
  for (const args of bad) await assert.rejects(run(args, () => null), /audit-docs args/)
})

await test('every schema lists its required keys in properties', async () => {
  const { calls } = await run(baseArgs(), (label) => label.startsWith('audit') ? { slice: 'a.md:1-50', changes: [row({})] } : { verdicts: [], missed: [] })
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return
    if (Array.isArray(s.required)) for (const k of s.required) assert.ok(s.properties && k in s.properties, `${path}: required ${k} not in properties`)
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${path}.${k}`)
    if (s.items) walk(s.items, `${path}[]`)
  }
  for (const c of calls) walk(c.opts.schema, c.label)
})

await test('each row has one owner, keep gets shortening EDITs as a second opinion', async () => {
  const rows = [
    row({ category: 'DRIFT', action: 'EDIT', start: 3, end: 5, first_line: 'line three of a', last_line: 'line five of a' }),
    row({ category: 'HISTORY_LEAK', action: 'MOVE', start: 8, end: 9, new_text: undefined, destination: { file: 'history.md', section: 'old' } }),
    row({ category: 'STALE_STATUS', action: 'EDIT', start: 12, end: 12, new_text: 'short' }),
    row({ category: 'BROKEN_REF', action: 'EDIT', start: 14, end: 14, new_text: 'a much longer replacement text than the anchor' }),
  ]
  const { calls } = await run(baseArgs(), (label) => label.startsWith('audit') ? { slice: 'x', changes: rows } : { verdicts: [], missed: [] })
  const verify = calls.filter(c => c.label.startsWith('verify:'))
  const ids = ['one-1', 'one-2', 'one-3', 'one-4']
  for (const id of ids) assert.equal(verify.filter(c => owned(c.prompt).includes(id)).length, 1, `${id} has one owner`)
  const keep = verify.find(c => c.label === 'verify:keep')
  assert.deepEqual(owned(keep.prompt), ['one-2'])
  assert.deepEqual(second(keep.prompt).sort(), ['one-1', 'one-3'])
  assert.deepEqual(owned(verify.find(c => c.label === 'verify:missed').prompt), [])
})

await test('merge: REJECTED wins, second opinion cannot amend, owner AMENDED replaces', async () => {
  const rows = [row({ start: 3, end: 5, last_line: 'line five' }), row({ start: 10, end: 10, new_text: 'x' }), row({ start: 20, end: 20, new_text: 'a long enough replacement here' })]
  const { result } = await run(baseArgs(), (label) => {
    if (label === 'audit:one') return { slice: 'x', changes: rows }
    if (label === 'verify:keep') return { verdicts: [{ id: 'one-1', verdict: 'REJECTED', reason: 'drops a rule' }, { id: 'one-2', verdict: 'AMENDED', reason: 'r', amended: row({ new_text: 'keep tried' }) }], missed: [] }
    if (label === 'verify:evidence') return { verdicts: [{ id: 'one-1', verdict: 'CONFIRMED', reason: 'r' }, { id: 'one-2', verdict: 'CONFIRMED', reason: 'r' }, { id: 'one-3', verdict: 'AMENDED', reason: 'r', amended: row({ start: 20, end: 20, new_text: 'owner fix' }) }], missed: [] }
    return { verdicts: [], missed: [] }
  })
  assert.deepEqual(result.rejected.map(r => r.id), ['one-1'])
  assert.deepEqual(result.summary.rejected_by_second_opinion, ['one-1'])
  assert.equal(result.changes.find(c => c.id === 'one-2').new_text, 'x')
  assert.equal(result.changes.find(c => c.id === 'one-3').new_text, 'owner fix')
  assert.equal(result.changes.find(c => c.id === 'one-3').verdict, 'AMENDED')
})

await test('extras and silent owners are UNVERIFIED; a failed verifier is incomplete', async () => {
  const rows = [row({ category: 'DRIFT', start: 3, end: 3 }), row({ category: 'MISPLACED', action: 'DELETE', start: 30, end: 31, new_text: undefined })]
  const { result } = await run(baseArgs(), (label) => {
    if (label === 'audit:one') return { slice: 'x', changes: rows }
    if (label === 'verify:evidence') return null
    if (label === 'verify:missed') return { verdicts: [], missed: [row({ start: 40, end: 40 })] }
    return { verdicts: [], missed: [] }
  })
  assert.ok(result.summary.incomplete.includes('verify:evidence'))
  assert.equal(result.changes.find(c => c.id === 'one-1').verdict, 'UNVERIFIED')
  assert.equal(result.changes.find(c => c.id === 'one-2').verdict, 'UNVERIFIED')
  assert.equal(result.changes.find(c => c.id === 'missed-x1').verdict, 'UNVERIFIED')
  assert.equal(result.summary.counts.extras, 1)
})

await test('an amendment that changes the action gets keep\'s look', async () => {
  const { result, calls } = await run(baseArgs(), (label) => {
    if (label === 'audit:one') return { slice: 'x', changes: [row({ start: 3, end: 3 })] }
    if (label === 'verify:evidence') return { verdicts: [{ id: 'one-1', verdict: 'AMENDED', reason: 'r', amended: row({ action: 'DELETE', new_text: undefined }) }], missed: [] }
    if (label === 'verify:keep-changed') return { verdicts: [{ id: 'one-1', verdict: 'REJECTED', reason: 'the delete loses a rule' }], missed: [] }
    return { verdicts: [], missed: [] }
  })
  assert.ok(calls.some(c => c.label === 'verify:keep-changed'))
  assert.deepEqual(result.rejected.map(r => r.id), ['one-1'])
  assert.equal(result.rejected[0].amended.action, 'DELETE')
})

await test('outside docs, structural problems and overlaps go to blocked', async () => {
  const rows = [
    row({ file: 'elsewhere.md', start: 1, end: 1 }),
    row({ action: 'MOVE', start: 5, end: 6, destination: { file: 'history.md', section: 'x' }, new_text: 'moved text' }),
    row({ start: 10, end: 12, last_line: 'x' }), row({ start: 11, end: 11 }),
    row({ start: 20, end: 21, quote: 'q' }),
  ]
  const { result } = await run(baseArgs(), (label) => label === 'audit:one' ? { slice: 'x', changes: rows } : { verdicts: [], missed: [] })
  const why = Object.fromEntries(result.summary.blocked.map(b => [b.id, b.why]))
  assert.equal(why['one-1'], 'outside docs')
  assert.equal(why['one-2'], 'MOVE with new_text')
  assert.equal(why['one-3+one-4'], 'overlap')
  assert.equal(why['one-5'], 'quote with end > start')
  assert.equal(result.changes.find(c => c.id === 'one-1').blocked, 'outside docs')
})

await test('a 150-row run keeps summary first and under 5 KB', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => row({ start: i * 3 + 1, end: i * 3 + 1, action: i % 7 === 0 ? 'ASK' : 'EDIT', options: [{ label: 'yes' }], problem: 'a problem described at some length to make the rows heavy '.repeat(3) }))
  const { result } = await run(baseArgs({ auditors: [{ key: 'one', brief: 'b', words: 100, ranges: [{ file: 'a.md', start: 1, end: 500 }] }] }),
    (label) => label === 'audit:one' ? { slice: 'x', changes: rows } : { verdicts: rows.map((_, i) => ({ id: `one-${i + 1}`, verdict: i % 5 ? 'CONFIRMED' : 'REJECTED', reason: 'r' })), missed: [] })
  assert.equal(Object.keys(result)[0], 'summary')
  const size = JSON.stringify(result.summary).length
  assert.ok(size < 5000, `summary is ${size} chars`)
})

await test('every agent runs on Opus at high effort', async () => {
  const { calls } = await run(baseArgs(), (label) => label.startsWith('audit') ? { slice: 'a.md:1-50', changes: [row({})] } : { verdicts: [], missed: [] })
  assert.ok(calls.length >= 2)
  for (const c of calls) assert.deepEqual([c.opts.model, c.opts.effort], ['opus', 'high'], c.label)
})

await test('the script source has no backslash-u escape and no Date or Math.random', async () => {
  assert.ok(!source.includes('\\u'), 'found a backslash-u escape')
  assert.ok(!/\bDate\b|Math\.random/.test(source), 'found Date or Math.random')
})

if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
