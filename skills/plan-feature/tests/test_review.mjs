// Runs plan-review.js with a stub critic, so the whole flow is checked with no model calls.
// Run from the repo root: node skills/plan-feature/tests/test_review.mjs
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

// What each default lens must ask about, beyond its basics: tests that pass wrongly, seams that don't earn their place,
// premises the code contradicts and bug fixes with no repro. plan-fanout's critics carry the same clauses
// (test_agents.mjs), and plan-feature-small's lens list repeats them by hand.
const LENS_CLAUSES = {
  correctness: [/worked out the way the code works it out/, /past the public interface/],
  fit: [/deleting it would move no complexity/, /not even a test stand-in/],
  gaps: [/premise the code contradicts \(quote both\)/, /stated reason none can/],
}
for (const [key, clauses] of Object.entries(LENS_CLAUSES))
  await test(`the ${key} lens carries its clauses`, async () => {
    const { calls } = await run(baseArgs(), () => review())
    const line = calls[0].prompt.match(new RegExp(`^- ${key}: .*$`, 'm'))?.[0] ?? ''
    const missing = clauses.filter(c => !c.test(line))
    assert.deepEqual(missing, [], `${key} lacks ${missing.join(', ')}`)
  })

// Both building skills follow one rules file from plan approval to the finish, so a pointer that goes stale would
// silently drop every build rule.
await test('plan-feature and plan-feature-small point at the build rules, which exist with their three parts', async () => {
  const skills = join(here, '..', '..')
  assert.match(readFileSync(join(skills, 'plan-feature', 'SKILL.md'), 'utf8'), /read `build-rules\.md` next to this file/)
  assert.match(readFileSync(join(skills, 'plan-feature-small', 'SKILL.md'), 'utf8'), /`\.\.\/plan-feature\/build-rules\.md` from this file/)
  const rules = readFileSync(join(here, '..', 'build-rules.md'), 'utf8')
  for (const heading of ['## Before the first checkpoint', '## While building', '## Finish']) assert.ok(rules.includes(heading), heading)
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

// agent({schema}) throws once the structured answer has failed validation too often (one bad character anywhere in a
// long nested answer is enough). The critic is then asked again for one JSON object per line: a bad line costs only
// itself, a lone backslash (a Windows path) is repaired, and a line that still won't parse is kept as raw text.
const LINES = [
  '```jsonl',
  '{"lens":"correctness","checked":["src/parse.ts"]}',
  '{"lens":"fit","severity":"should-fix","claim":"c","evidence":"e","minimalFix":"f","file":"C:\\Users\\dev\\src\\view.ts","line":3}',
  'not json at all',
  '{"lens":"nobody","severity":"nit","claim":"c","evidence":"e","minimalFix":"f"}',
  '{"summary":"s"}',
  '```',
].join('\n')
const throwsOnSchema = (lines) => (prompt, opts) => {
  if (opts.schema) throw new Error('StructuredOutput retry cap (5) exceeded')
  return lines
}

await test('a structured answer that fails is asked for again one finding per line, and nothing in it is lost', async () => {
  const { calls, result } = await run(baseArgs({ round: 'final', changes: 'x' }), throwsOnSchema(LINES))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].opts.schema, undefined)
  assert.match(calls[1].prompt, /JSON Lines/)
  assert.match(calls[1].prompt, /THIS IS THE FINAL CHECK/)
  assert.equal(result.fallback, 'lines')
  assert.deepEqual(result.lenses.correctness, { checked: ['src/parse.ts'], findings: [] })
  assert.deepEqual(result.lenses.fit.findings, [{ severity: 'should-fix', claim: 'c', evidence: 'e', minimalFix: 'f', file: 'C:\\Users\\dev\\src\\view.ts', line: 3 }])
  assert.deepEqual(result.lenses.gaps, { checked: [], findings: [] })
  assert.equal(result.summary, 's')
  assert.deepEqual(result.unparsed, ['not json at all', '{"lens":"nobody","severity":"nit","claim":"c","evidence":"e","minimalFix":"f"}'])
  assert.deepEqual(result.counts, { blocker: 0, shouldFix: 1, nit: 0 })
  assert.deepEqual(Object.keys(result.ranOnAgents), ['critic', 'critic:lines'])
})

await test('when the per-line answer gives nothing either, the check asks to be run again instead of throwing', async () => {
  for (const lines of [null, '', '```\n```'])
    assert.deepEqual((await run(baseArgs({ round: 'final', changes: 'x' }), throwsOnSchema(lines))).result, { round: 'final', error: 'the critic returned nothing; run the final check again' })
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
