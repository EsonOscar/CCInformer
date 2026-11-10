import { expect, test } from 'claude-code/testing'

import type { SkillsSettings } from '../types'
import { AGENT_ROLES, DEFAULT_SKILLS, agentChoice, agentsExplain, changedCount, cycled, skillsFrom, skillsRest, skillsText, withoutAgents } from '../hooks/core/skills'

test('the skills file: planFiles false is off, anything else is on', () => {
  expect(skillsFrom('{ "planFiles": false }')).toEqual({ planFiles: false, agents: {} })
  expect(skillsFrom('{ "planFiles": true }')).toEqual({ planFiles: true, agents: {} })
  expect(skillsFrom('{}')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('not json')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('[false]')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('{ "planFiles": "false" }')).toEqual(DEFAULT_SKILLS)
})

test('what the switch writes reads back the same, and is plain JSON for the skills', () => {
  expect(skillsFrom(skillsText({ planFiles: false, agents: {} }))).toEqual({ planFiles: false, agents: {} })
  expect(skillsFrom(skillsText({ planFiles: true, agents: {} }))).toEqual({ planFiles: true, agents: {} })
  expect(skillsText({ planFiles: false, agents: {} })).toBe('{\n  "planFiles": false\n}\n')
})

const file = (agents: unknown) => JSON.stringify({ planFiles: true, agents })

test('agents: a known script and role with a value on the lists is kept; the rest is dropped', () => {
  expect(skillsFrom(file({ 'plan-fanout': { planner: { effort: 'medium' }, scout: { model: 'opus', effort: 'high' } } })).agents).toEqual({
    'plan-fanout': { planner: { effort: 'medium' }, scout: { model: 'opus', effort: 'high' } },
  })
  // An unknown script, an unknown role, a value off the lists, a value that isn't text, a role that isn't an object.
  expect(
    skillsFrom(
      file({
        'some-script': { critic: { model: 'sonnet' } },
        'plan-fanout': { reader: { model: 'sonnet' }, planner: { model: 'fable', effort: 'max' }, critic: { model: 3 }, scout: null },
        'plan-review': 'sonnet',
      }),
    ).agents,
  ).toEqual({})
  expect(skillsFrom(file('opus')).agents).toEqual({})
  expect(skillsFrom(file(['opus'])).agents).toEqual({})
})

test('agents: a value equal to the default is not kept', () => {
  expect(skillsFrom(file({ 'plan-fanout': { scout: { model: 'sonnet', effort: 'low' }, planner: { model: 'opus', effort: 'high' } } })).agents).toEqual({
    'plan-fanout': { scout: { effort: 'low' } },
  })
})

test('agents are written only when set, read back the same, and a key this version does not know stays in the file', () => {
  const set: SkillsSettings = { planFiles: false, agents: { 'plan-review': { critic: { model: 'sonnet' } } } }
  expect(skillsText(set)).toBe('{\n  "planFiles": false,\n  "agents": {\n    "plan-review": {\n      "critic": {\n        "model": "sonnet"\n      }\n    }\n  }\n}\n')
  expect(skillsFrom(skillsText(set))).toEqual(set)

  const later = '{ "someLater": { "a": 1 }, "planFiles": false, "agents": { "plan-review": { "critic": { "model": "sonnet" } } } }'
  expect(skillsRest(later)).toEqual({ someLater: { a: 1 } })
  const written = skillsText(withoutAgents(skillsFrom(later)), skillsRest(later))
  expect(JSON.parse(written)).toEqual({ someLater: { a: 1 }, planFiles: false })
  expect(skillsRest('not json')).toEqual({})
  expect(skillsRest('[1]')).toEqual({})
})

test('what a kind of agent runs on: the default until set, and a settings value from before agents existed reads as the defaults', () => {
  for (const d of AGENT_ROLES) expect(agentChoice(DEFAULT_SKILLS, d.script, d.role)).toEqual({ model: d.model, effort: d.effort, isDefault: true })
  const set: SkillsSettings = { planFiles: true, agents: { 'plan-fanout': { critic: { effort: 'medium' } } } }
  expect(agentChoice(set, 'plan-fanout', 'critic')).toEqual({ model: 'opus', effort: 'medium', isDefault: false })
  expect(agentChoice(set, 'plan-review', 'critic')).toEqual({ model: 'opus', effort: 'medium', isDefault: true })
  expect(changedCount(set)).toBe(1)

  const old = { planFiles: true } as SkillsSettings
  expect(agentChoice(old, 'plan-fanout', 'scout')).toEqual({ model: 'sonnet', effort: 'medium', isDefault: true })
  expect(changedCount(old)).toBe(0)
  expect(cycled(old, 'plan-fanout', 'scout', 'model').agents).toEqual({ 'plan-fanout': { scout: { model: 'opus' } } })
  expect(skillsText(old)).toBe('{\n  "planFiles": true\n}\n')
  expect(agentsExplain(old)).toContain('Plan: scouts on sonnet at medium;')
})

test('a press moves a value to the next on its list, wrapping round; back at the default it leaves nothing behind', () => {
  // The scouts' model: sonnet (default), opus, haiku, sonnet.
  const one = cycled(DEFAULT_SKILLS, 'plan-fanout', 'scout', 'model')
  expect(one.agents).toEqual({ 'plan-fanout': { scout: { model: 'opus' } } })
  const two = cycled(one, 'plan-fanout', 'scout', 'model')
  expect(two.agents).toEqual({ 'plan-fanout': { scout: { model: 'haiku' } } })
  expect(cycled(two, 'plan-fanout', 'scout', 'model')).toEqual(DEFAULT_SKILLS)

  // Two values on one row, and another row: each leaves when it is back at its default.
  const both = cycled(cycled(one, 'plan-fanout', 'scout', 'effort'), 'plan-fanout', 'critic', 'effort')
  expect(both.agents).toEqual({ 'plan-fanout': { scout: { model: 'opus', effort: 'high' }, critic: { effort: 'low' } } })
  expect(changedCount(both)).toBe(2)
  expect(agentsExplain(both)).toContain('Plan: scouts on opus at high (changed); Plan: planners on opus at high; Plan: critics on opus at low (changed);')
  expect(withoutAgents({ ...both, planFiles: false })).toEqual({ planFiles: false, agents: {} })

  // A kind of agent the registry doesn't have changes nothing.
  expect(cycled(DEFAULT_SKILLS, 'plan-fanout', 'reader', 'model')).toEqual(DEFAULT_SKILLS)
  expect(cycled(DEFAULT_SKILLS, 'plan-review', 'critic', 'effort').agents).toEqual({ 'plan-review': { critic: { effort: 'high' } } })
})
