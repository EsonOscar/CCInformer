// Runs plan-review.js with a stub critic, so the whole flow is checked with no model calls.
// Run from the repo root: node skills/plan-feature-small/tests/test_review.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'plan-review.js'), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const body = source.replace('export const meta', 'const meta')

// handler(prompt, opts) returns the stub critic's result.
async function run(args, handler) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts })
    return handler(prompt, opts)
  }
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', body)
  const result = await fn(args, agent, () => {}, () => {})
  return { result, calls }
}

const baseArgs = (over = {}) => ({
  context: 'A sample project.',
  requirements: 'Parse and show it.',
  plan: '/home/dev/.claude/plans/sample.md',
  files: ['src/parse.ts', 'src/view.ts'],
  round: 1,
  ...over,
})
const finding = (severity) => ({ severity, claim: 'c', evidence: 'e', minimalFix: 'f' })
const review = (byLens = {}) => ({
  lenses: Object.fromEntries(['correctness', 'fit', 'gaps', 'access'].map(k => [k, { checked: ['src/parse.ts'], findings: byLens[k] ?? [] }])),
  summary: 's',
})

let failures = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`) } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.message}`) }
}

await test('bad args throw', async () => {
  const bad = [
    baseArgs({ context: '' }),
    baseArgs({ requirements: undefined }),
    baseArgs({ plan: '' }),
    baseArgs({ files: [] }),
    baseArgs({ files: Array.from({ length: 31 }, (_, i) => `f${i}.ts`) }),
    baseArgs({ round: 3 }),
    baseArgs({ round: 2 }),
    baseArgs({ lenses: [{ key: 'fit', focus: 'again' }] }),
    baseArgs({ lenses: [{ key: 'Bad Key', focus: 'f' }] }),
    baseArgs({ lenses: [{ key: 'a', focus: 'f' }, { key: 'a', focus: 'g' }] }),
    baseArgs({ lenses: ['a', 'b', 'c', 'd'].map(key => ({ key, focus: 'f' })) }),
  ]
  for (const args of bad) await assert.rejects(run(args, () => review()), /plan-review args/)
})

await test('one critic on Opus at medium effort, with every required key in its properties', async () => {
  const { calls } = await run(baseArgs(), () => review())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.model, 'opus')
  assert.equal(calls[0].opts.effort, 'medium')
  const walk = (s, path) => {
    if (!s || typeof s !== 'object') return
    if (Array.isArray(s.required)) for (const k of s.required) assert.ok(s.properties && k in s.properties, `${path}: required ${k} not in properties`)
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${path}.${k}`)
    if (s.items) walk(s.items, `${path}[]`)
  }
  walk(calls[0].opts.schema, 'schema')
})

await test('every lens, an extra one too, is a required section and named in the prompt', async () => {
  const { calls } = await run(baseArgs({ lenses: [{ key: 'access', focus: 'who may read what' }] }), () => review())
  const { schema } = calls[0].opts
  assert.deepEqual(schema.properties.lenses.required, ['correctness', 'fit', 'gaps', 'access'])
  for (const key of ['correctness', 'fit', 'gaps']) assert.match(calls[0].prompt, new RegExp(`- ${key}: `))
  assert.match(calls[0].prompt, /- access: who may read what/)
})

await test('the prompt names the plan file and the files to read first, and stays read-only', async () => {
  const { calls } = await run(baseArgs(), () => review())
  const { prompt } = calls[0]
  assert.match(prompt, /Read the plan at \/home\/dev\/\.claude\/plans\/sample\.md\./)
  assert.match(prompt, /- src\/parse\.ts\n- src\/view\.ts/)
  assert.match(prompt, /YOU ARE READ-ONLY/)
  assert.doesNotMatch(prompt, /ROUND 2/)
})

await test("round 2's prompt carries round 1's findings and what changed", async () => {
  const previous = { findings: [{ severity: 'blocker', claim: 'misses the empty case' }], changes: 'CP2 now handles empty input' }
  const { calls } = await run(baseArgs({ round: 2, previous }), () => review())
  assert.match(calls[0].prompt, /THIS IS ROUND 2/)
  assert.match(calls[0].prompt, /misses the empty case/)
  assert.match(calls[0].prompt, /CP2 now handles empty input/)
})

await test('counts, and a second round only after a blocker in round 1', async () => {
  const lenses = [{ key: 'access', focus: 'f' }]
  const blocker = await run(baseArgs({ lenses }), () => review({ correctness: [finding('blocker'), finding('nit')], access: [finding('should-fix')] }))
  assert.deepEqual(blocker.result.counts, { blocker: 1, shouldFix: 1, nit: 1 })
  assert.equal(blocker.result.needsRound2, true)
  const shouldFix = await run(baseArgs(), () => review({ fit: [finding('should-fix')] }))
  assert.equal(shouldFix.result.needsRound2, false)
  const previous = { findings: [], changes: 'x' }
  const second = await run(baseArgs({ round: 2, previous }), () => review({ gaps: [finding('blocker')] }))
  assert.equal(second.result.needsRound2, false)
  assert.equal(second.result.round, 2)
})

await test('a critic that returns nothing asks for the round again', async () => {
  const { result } = await run(baseArgs(), () => null)
  assert.deepEqual(result, { round: 1, error: 'the critic returned nothing; run this round again' })
})

await test("a round other than 1, 2 or 'final' is refused by name", async () => {
  await assert.rejects(run(baseArgs({ round: 3 }), () => review()), /round must be 1, 2 or 'final'/)
})

await test('the final check needs the changes made since the last review', async () => {
  for (const changes of [undefined, '', '  ', ['a']])
    await assert.rejects(run(baseArgs({ round: 'final', changes }), () => review()), /the final check needs changes: what changed since the last review/)
})

await test('the final check is one critic over only the listed changes', async () => {
  const changes = 'CP2 now handles empty input\nThe contract renames parse() to read()'
  const { calls } = await run(baseArgs({ round: 'final', changes }), () => review())
  assert.equal(calls.length, 1)
  const { prompt } = calls[0]
  assert.match(prompt, /THIS IS THE FINAL CHECK/)
  assert.match(prompt, /CP2 now handles empty input\nThe contract renames parse\(\) to read\(\)/)
  assert.match(prompt, /Don't re-review the rest of the plan\./)
  assert.doesNotMatch(prompt, /ROUND 2/)
})

await test('the final check never asks for another round, even after a blocker', async () => {
  const { result } = await run(baseArgs({ round: 'final', changes: 'x' }), () => review({ correctness: [finding('blocker')] }))
  assert.equal(result.round, 'final')
  assert.equal(result.needsRound2, false)
  assert.deepEqual(result.counts, { blocker: 1, shouldFix: 0, nit: 0 })
})

await test('a final check whose critic returns nothing asks for the final check again', async () => {
  const { result } = await run(baseArgs({ round: 'final', changes: 'x' }), () => null)
  assert.deepEqual(result, { round: 'final', error: 'the critic returned nothing; run the final check again' })
})

if (failures) {
  console.log(`${failures} failed`)
  process.exit(1)
}
