// Runs the four workflow scripts with stub agents (no model calls) and holds what each kind of agent runs on: the
// defaults the mod's Settings show (AGENT_ROLES), a value the person set, the cap, and what the script reports back.
// The registry is the mod's TypeScript, so this runs under tsx:
//   npx -y tsx@4 skills/plan-feature/tests/test_agents.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { AGENT_ROLES } = await import(pathToFileURL(join(root, 'hooks/core/skills.ts')).href)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Each script: its file, the role an agent's label belongs to, its smallest valid args and what its stub agents return.
const SCRIPTS = {
  'plan-fanout': {
    file: 'skills/plan-feature/plan-fanout.js',
    role: label => ({ scout: 'scout', plan: 'planner', critic: 'critic' })[label.split(':')[0]],
    args: { context: 'c', scouts: [{ key: 's1', brief: 'b' }, { key: 's2', brief: 'b' }], planners: [{ key: 'p1', brief: 'b' }] },
    reply: label => (label.startsWith('critic') ? { findings: [], summary: 's' } : 'text'),
  },
  'build-fanout': {
    file: 'skills/plan-feature/build-fanout.js',
    role: label => ({ build: 'builder', fix: 'builder', review: 'reviewer' })[label.split(':')[0]],
    args: {
      context: 'c', plan: '/plan.md', wave: 1, snapshot: { script: '/snap.sh', baseline: '/base.txt' },
      packages: [{ key: 'one', brief: 'b', files: ['a.ts'], doneWhen: 'd' }, { key: 'two', brief: 'b', files: ['b.ts'], doneWhen: 'd' }],
    },
    // The review sends every package back, so the fix agents run too.
    reply: label => (label.startsWith('review') ? { verdict: 'fix', findings: [{ severity: 'should-fix' }] } : { blocked: '' }),
  },
  'audit-docs-fanout': {
    file: 'skills/audit-docs/audit-docs-fanout.js',
    role: label => ({ audit: 'auditor', verify: 'verifier' })[label.split(':')[0]],
    args: {
      context: 'c', root: '/repo', date: '2026-11-02', history: null,
      docs: [{ file: 'a.md', kind: 'current', tracked: true }],
      auditors: [{ key: 'one', brief: 'b', role: 'audit', words: 100, ranges: [{ file: 'a.md', start: 1, end: 50 }] }],
    },
    reply: label => (label.startsWith('audit') ? { slice: 'a.md:1-50', changes: [] } : { verdicts: [], missed: [] }),
    at: result => result.run,
  },
  'plan-review': {
    file: 'skills/plan-feature/plan-review.js',
    role: () => 'critic',
    args: { context: 'c', requirements: 'r', plan: '/plan.md', files: ['a.ts'], round: 1 },
    reply: () => ({ lenses: {}, summary: 's' }),
  },
}

async function run(name, over = {}) {
  const script = SCRIPTS[name]
  const body = readFileSync(join(root, script.file), 'utf8').replace('export const meta', 'const meta')
  const calls = []
  const logs = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, role: script.role(opts.label), model: opts.model, effort: opts.effort })
    return script.reply(opts.label)
  }
  const parallel = fns => Promise.all(fns.map(f => f()))
  const pipeline = (items, ...stages) => Promise.all(items.map(async item => {
    let r = await stages[0](item)
    for (const stage of stages.slice(1)) r = await stage(r, item)
    return r
  }))
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', body)
  const result = await fn({ ...script.args, ...over }, agent, parallel, pipeline, () => {}, text => logs.push(text))
  const at = (script.at ?? (r => r))(result)
  // What the run says each agent ran on must be what each call was given, label for label.
  const asked = Object.fromEntries(calls.map(c => [c.label, { model: c.model, effort: c.effort }]))
  return { calls, logs, result, ranOn: at.ranOn, ranOnAgents: at.ranOnAgents, asked }
}

const rolesOf = name => AGENT_ROLES.filter(d => d.script === name)
const defaultsOf = name => Object.fromEntries(rolesOf(name).map(d => [d.role, { model: d.model, effort: d.effort }]))
const ranOnText = ranOn => 'ran on: ' + Object.entries(ranOn).map(([role, o]) => `${role} ${o.model}/${o.effort}`).join(', ')

let failures = 0
async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`) } catch (e) { failures++; console.log(`FAIL - ${name}\n  ${e.message}`) }
}

await test('the registry names every script here, and no other', () => {
  assert.deepEqual([...new Set(AGENT_ROLES.map(d => d.script))].sort(), Object.keys(SCRIPTS).sort())
})

for (const name of Object.keys(SCRIPTS)) {
  const defaults = defaultsOf(name)
  const roles = Object.keys(defaults)

  await test(`${name}: with nothing set, every agent runs on the registry's default for its role, and the run says so`, async () => {
    const { calls, logs, ranOn, ranOnAgents, asked } = await run(name)
    assert.deepEqual(ranOnAgents, asked)
    assert.deepEqual([...new Set(calls.map(c => c.role))].sort(), [...roles].sort(), 'every role ran')
    for (const c of calls) assert.deepEqual({ model: c.model, effort: c.effort }, defaults[c.role], c.label)
    assert.deepEqual(ranOn, defaults)
    assert.ok(logs.includes(ranOnText(defaults)), logs.join(' | '))
  })

  await test(`${name}: a set value reaches that role's agents only, and a value left out stays the default`, async () => {
    for (const role of roles) {
      const { calls, logs, ranOn, ranOnAgents, asked } = await run(name, { agents: { [role]: { model: 'haiku' } } })
      assert.deepEqual(ranOnAgents, asked)
      const want = { ...defaults, [role]: { model: 'haiku', effort: defaults[role].effort } }
      for (const c of calls) assert.deepEqual({ model: c.model, effort: c.effort }, want[c.role], c.label)
      assert.deepEqual(ranOn, want)
      assert.ok(logs.includes(ranOnText(want)), logs.join(' | '))
    }
    const { calls } = await run(name, { agents: { [roles[0]]: { effort: 'low' } } })
    for (const c of calls) assert.deepEqual({ model: c.model, effort: c.effort }, c.role === roles[0] ? { model: defaults[roles[0]].model, effort: 'low' } : defaults[c.role], c.label)
  })

  await test(`${name}: a model or effort above the cap, or not on the lists, comes down to opus at high`, async () => {
    const all = Object.fromEntries(roles.map(r => [r, { model: 'fable', effort: 'max' }]))
    const { calls, ranOn, ranOnAgents, asked } = await run(name, { agents: all })
    assert.deepEqual(ranOnAgents, asked)
    for (const c of calls) assert.deepEqual([c.model, c.effort], ['opus', 'high'], c.label)
    for (const r of roles) assert.deepEqual(ranOn[r], { model: 'opus', effort: 'high' })
    const odd = await run(name, { agents: Object.fromEntries(roles.map(r => [r, { model: 'gpt', effort: 'extreme' }])) })
    for (const c of odd.calls) assert.deepEqual([c.model, c.effort], ['opus', 'high'], c.label)
  })

  await test(`${name}: agents that is not an object, or a role that is not one, runs on the defaults`, async () => {
    for (const agents of ['x', 3, null, [], { [roles[0]]: null }, { [roles[0]]: 'opus' }, { someone: { model: 'haiku' } }]) {
      const { calls, ranOn } = await run(name, { agents })
      for (const c of calls) assert.deepEqual({ model: c.model, effort: c.effort }, defaults[c.role], `${JSON.stringify(agents)} ${c.label}`)
      assert.deepEqual(ranOn, defaults)
    }
  })
}

await test("plan-fanout: a scout's own model and effort go before the scouts' setting", async () => {
  const scouts = [{ key: 's1', brief: 'b', model: 'opus', effort: 'high' }, { key: 's2', brief: 'b' }]
  const { calls, ranOn, ranOnAgents, asked } = await run('plan-fanout', { scouts, agents: { scout: { model: 'haiku', effort: 'low' } } })
  assert.deepEqual(ranOnAgents, asked)
  assert.deepEqual(ranOnAgents['scout:s1'], { model: 'opus', effort: 'high' })
  assert.deepEqual(ranOnAgents['scout:s2'], { model: 'haiku', effort: 'low' })
  const by = Object.fromEntries(calls.map(c => [c.label, [c.model, c.effort]]))
  assert.deepEqual(by['scout:s1'], ['opus', 'high'])
  assert.deepEqual(by['scout:s2'], ['haiku', 'low'])
  assert.deepEqual(ranOn.scout, { model: 'haiku', effort: 'low' })
})

await test('plan-fanout: a re-check runs only the critics, on their setting, and reports only them', async () => {
  const { calls, logs, result, ranOnAgents, asked } = await run('plan-fanout', { recheck: { plan: '/plan.md', changes: 'x' }, agents: { critic: { effort: 'medium' }, planner: { model: 'haiku' } } })
  assert.ok(calls.length >= 3 && calls.every(c => c.role === 'critic'))
  for (const c of calls) assert.deepEqual([c.model, c.effort], ['opus', 'medium'], c.label)
  assert.deepEqual(result.ranOn, { critic: { model: 'opus', effort: 'medium' } })
  assert.deepEqual(ranOnAgents, asked)
  assert.ok(Object.keys(ranOnAgents).every(label => label.startsWith('critic:')))
  assert.ok(logs.includes('ran on: critic opus/medium'), logs.join(' | '))
})

await test('plan-fanout: a run that skips the critique for a missing plan still says what it ran on', async () => {
  const script = SCRIPTS['plan-fanout']
  const reply = script.reply
  script.reply = label => (label.startsWith('plan') ? null : reply(label))
  try {
    const { result, ranOnAgents, asked } = await run('plan-fanout')
    assert.deepEqual(result.missingPlanners, ['p1'])
    assert.deepEqual(ranOnAgents, asked)
    assert.deepEqual(Object.keys(ranOnAgents).sort(), ['plan:p1', 'scout:s1', 'scout:s2'])
    assert.deepEqual(result.ranOn, defaultsOf('plan-fanout'))
  } finally {
    script.reply = reply
  }
})

await test("build-fanout: a package's own model and effort go before the builders' setting, for its build and its fix", async () => {
  const packages = [{ key: 'one', brief: 'b', files: ['a.ts'], doneWhen: 'd', model: 'sonnet', effort: 'medium' }, { key: 'two', brief: 'b', files: ['b.ts'], doneWhen: 'd' }]
  const { calls, ranOnAgents, asked } = await run('build-fanout', { packages, agents: { builder: { model: 'haiku', effort: 'low' }, reviewer: { effort: 'medium' } } })
  assert.deepEqual(ranOnAgents, asked)
  assert.deepEqual(ranOnAgents['fix:one'], { model: 'sonnet', effort: 'medium' })
  const by = Object.fromEntries(calls.map(c => [c.label, [c.model, c.effort]]))
  assert.deepEqual(by, {
    'build:one': ['sonnet', 'medium'], 'fix:one': ['sonnet', 'medium'], 'review:one': ['opus', 'medium'],
    'build:two': ['haiku', 'low'], 'fix:two': ['haiku', 'low'], 'review:two': ['opus', 'medium'],
  })
})

await test('plan-review: the final check runs on the critic setting too, and a critic that returns nothing reports no ranOn', async () => {
  const final = await run('plan-review', { round: 'final', changes: 'x', agents: { critic: { model: 'sonnet', effort: 'high' } } })
  assert.deepEqual([final.calls[0].model, final.calls[0].effort], ['sonnet', 'high'])
  assert.deepEqual(final.ranOn, { critic: { model: 'sonnet', effort: 'high' } })
  assert.deepEqual(final.ranOnAgents, { critic: { model: 'sonnet', effort: 'high' } })
  const script = SCRIPTS['plan-review']
  const reply = script.reply
  script.reply = () => null
  try {
    const { result } = await run('plan-review')
    assert.deepEqual(Object.keys(result), ['round', 'error'])
  } finally {
    script.reply = reply
  }
})

console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
