import { describe, expect, test } from 'claude-code/testing'

import { runFromRecord } from '../hooks/records'
import { isFull, modelFamily, phaseModels, statsFor, summarizeRun, workflowNames } from '../hooks/stats'
import { agentFacts } from '../hooks/view-agents'
import type { AgentRow, RunSummary } from '../types'

type Agent = { label: string; phase: string; model: string; start: number; ms?: number; tokens?: number }

// A run record in the shape Claude Code writes; an agent without `ms` was replayed from the workflow's cache.
// `result` is what the workflow's script returned, which the record keeps.
const record = (runId: string, startTime: number, durationMs: number, totalTokens: number, agents: Agent[], name = 'plan-fanout', result?: unknown) =>
  JSON.stringify({
    runId,
    ...(result === undefined ? {} : { result }),
    workflowName: name,
    status: 'completed',
    startTime,
    durationMs,
    totalTokens,
    phases: [{ title: 'Scout' }, { title: 'Plan' }, { title: 'Critique' }],
    workflowProgress: agents.map((a, i) => ({
      type: 'workflow_agent',
      index: i + 1,
      label: a.label,
      phaseTitle: a.phase,
      agentId: `${runId}-${i}`,
      model: a.model,
      state: 'done',
      startedAt: a.start,
      ...(a.ms ? { durationMs: a.ms, tokens: a.tokens ?? 0, toolCalls: 3 } : {}),
    })),
  })

const summary = (text: string) => summarizeRun(runFromRecord(text, 'x', '')!)

const OPUS_RUN = record('wf_1', 0, 900_000, 1_500_000, [
  { label: 'scout:a', phase: 'Scout', model: 'claude-opus-5-5', start: 0, ms: 200_000, tokens: 120_000 },
  { label: 'scout:b', phase: 'Scout', model: 'claude-opus-5-5', start: 0, ms: 240_000, tokens: 116_000 },
  { label: 'plan:a', phase: 'Plan', model: 'claude-opus-5-5', start: 240_000, ms: 260_000, tokens: 136_000 },
  { label: 'critic:a', phase: 'Critique', model: 'claude-opus-5-5', start: 500_000, ms: 400_000, tokens: 170_000 },
])
const SONNET_RUN = record('wf_2', 2_000_000, 600_000, 1_200_000, [
  { label: 'scout:a', phase: 'Scout', model: 'claude-sonnet-5-5', start: 2_000_000, ms: 60_000, tokens: 110_000 },
  { label: 'scout:b', phase: 'Scout', model: 'sonnet', start: 2_000_000 },
  { label: 'plan:a', phase: 'Plan', model: 'claude-opus-5-5', start: 2_060_000, ms: 240_000, tokens: 130_000 },
  { label: 'critic:a', phase: 'Critique', model: 'claude-opus-5-5', start: 2_300_000, ms: 300_000, tokens: 160_000 },
])
const RECHECK = record('wf_3', 3_000_000, 400_000, 700_000, [
  { label: 'critic:a', phase: 'Critique', model: 'claude-opus-5-5', start: 3_000_000, ms: 400_000, tokens: 150_000 },
])

describe('workflow statistics', () => {
  test('a record becomes a summary with each phase’s span and an agent sample each', async () => {
    const s = summary(OPUS_RUN)
    expect([s.ms, s.tokens, s.phasesRan.length, isFull(s)]).toEqual([900_000, 1_500_000, 3, true])
    expect(s.spans).toEqual([
      { title: 'Scout', ms: 240_000 },
      { title: 'Plan', ms: 260_000 },
      { title: 'Critique', ms: 400_000 },
    ])
    expect(isFull(summary(RECHECK))).toBe(false)
  })

  test('full runs and partial ones are averaged apart, with each phase’s share of the full runs’ time', async () => {
    const s = statsFor([summary(OPUS_RUN), summary(SONNET_RUN), summary(RECHECK)], 'plan-fanout')
    expect([s.full.runs, s.full.ms, s.partial.runs, s.partial.ms]).toEqual([2, 750_000, 1, 400_000])
    expect(s.trend).toEqual([900_000, 600_000])
    const scout = s.phases.find(p => p.title === 'Scout')!
    expect([scout.ms, Math.round(scout.share * 100)]).toEqual([150_000, 20])
  })

  test('each model is averaged over the agents that ran, the replayed ones counted apart', async () => {
    const s = statsFor([summary(OPUS_RUN), summary(SONNET_RUN)], 'plan-fanout')
    const scout = s.phases.find(p => p.title === 'Scout')!
    expect(scout.models).toEqual([
      { family: 'opus', effort: '', agents: 2, ran: 2, ms: 220_000, tokens: 118_000 },
      { family: 'sonnet', effort: '', agents: 2, ran: 1, ms: 60_000, tokens: 110_000 },
    ])
  })

  test('workflows are listed by how often they ran, and models by family', async () => {
    const other = summary(record('wf_9', 0, 1, 1, [], 'audit-docs'))
    expect(workflowNames([other, summary(OPUS_RUN), summary(RECHECK)])).toEqual(['plan-fanout', 'audit-docs'])
    expect([modelFamily('claude-opus-5-5'), modelFamily('sonnet'), modelFamily('gpt-x')]).toEqual(['opus', 'sonnet', 'gpt-x'])
  })
})

// A run whose record says what each agent's call was given.
const AGENTS: Agent[] = [
  { label: 'scout:a', phase: 'Scout', model: 'claude-sonnet-5-5', start: 0, ms: 100_000, tokens: 100_000 },
  { label: 'scout:b', phase: 'Scout', model: 'claude-opus-5-5', start: 0, ms: 200_000, tokens: 120_000 },
  { label: 'plan:a', phase: 'Plan', model: 'claude-opus-5-5', start: 200_000, ms: 260_000, tokens: 136_000 },
  { label: 'critic:a', phase: 'Critique', model: 'claude-opus-5-5', start: 500_000, ms: 400_000, tokens: 170_000 },
  { label: 'critic:b', phase: 'Critique', model: 'claude-opus-5-5', start: 500_000, ms: 300_000, tokens: 150_000 },
]
const RAN_ON = {
  'scout:a': { model: 'sonnet', effort: 'medium' },
  'scout:b': { model: 'opus', effort: 'high' },
  'plan:a': { model: 'opus', effort: 'medium' },
  'critic:a': { model: 'opus', effort: 'medium' },
  'critic:b': { model: 'opus', effort: 4000 },
}
const withResult = (result: unknown, name = 'plan-fanout') => record('wf_5', 0, 900_000, 1, AGENTS, name, result)
const efforts = (text: string) => runFromRecord(text, 'x', '')!.agents.map(a => a.effort)

describe('effort', () => {
  test('an agent’s effort is what the script’s result says its call was given, by label', async () => {
    expect(efforts(withResult({ ranOnAgents: RAN_ON }))).toEqual(['medium', 'high', 'medium', 'medium', '4000'])
    // The docs audit keeps it under `run`, so its summary stays first.
    expect(efforts(withResult({ summary: {}, run: { ranOnAgents: RAN_ON } }, 'audit-docs-fanout'))).toEqual(['medium', 'high', 'medium', 'medium', '4000'])
  })

  test('a record whose result names no effort for an agent gives it none', async () => {
    const none = ['', '', '', '', '']
    expect(efforts(record('wf_5', 0, 900_000, 1, AGENTS))).toEqual(none)
    expect(efforts(withResult(null))).toEqual(none)
    expect(efforts(withResult('done'))).toEqual(none)
    expect(efforts(withResult({ ranOn: { scout: { model: 'sonnet', effort: 'medium' } } }))).toEqual(none)
    expect(efforts(withResult({ ranOnAgents: 'high' }))).toEqual(none)
    expect(efforts(withResult({ ranOnAgents: { 'scout:a': 'high', 'scout:b': { effort: null }, 'plan:a': { effort: {} } } }))).toEqual(none)
    // Only the agents it names.
    expect(efforts(withResult({ ranOnAgents: { 'plan:a': { effort: 'low' } } }))).toEqual(['', '', 'low', '', ''])
  })

  test('a phase has a row per model and effort; agents of unknown effort share a row per model', async () => {
    const run = summary(withResult({ ranOnAgents: { ...RAN_ON, 'critic:b': { model: 'opus', effort: 'high' } } }))
    const s = statsFor([summary(OPUS_RUN), run], 'plan-fanout')
    expect(s.phases.find(p => p.title === 'Critique')!.models).toEqual([
      { family: 'opus', effort: '', agents: 1, ran: 1, ms: 400_000, tokens: 170_000 },
      { family: 'opus', effort: 'medium', agents: 1, ran: 1, ms: 400_000, tokens: 170_000 },
      { family: 'opus', effort: 'high', agents: 1, ran: 1, ms: 300_000, tokens: 150_000 },
    ])
    // Most agents first, then in the order first seen.
    expect(s.phases.find(p => p.title === 'Scout')!.models).toEqual([
      { family: 'opus', effort: '', agents: 2, ran: 2, ms: 220_000, tokens: 118_000 },
      { family: 'sonnet', effort: 'medium', agents: 1, ran: 1, ms: 100_000, tokens: 100_000 },
      { family: 'opus', effort: 'high', agents: 1, ran: 1, ms: 200_000, tokens: 120_000 },
    ])
  })

  test('a summary from before samples had an effort gives the rows it always did', async () => {
    const now = summary(OPUS_RUN)
    const old = { ...now, agents: now.agents.map(({ effort: _effort, ...rest }) => rest) } as RunSummary
    expect(old.agents.every(a => !('effort' in a))).toBe(true)
    expect(statsFor([old], 'plan-fanout').phases).toEqual(statsFor([now], 'plan-fanout').phases)
    expect(phaseModels(old)).toBe('Scout opus · Plan opus · Critique opus')
  })

  test('the recent list names what every phase that ran ran on', async () => {
    expect(phaseModels(summary(withResult({ ranOnAgents: RAN_ON })))).toBe('Scout sonnet/medium+opus/high · Plan opus/medium · Critique opus/medium+opus/4000')
    expect(phaseModels(summary(SONNET_RUN))).toBe('Scout sonnet · Plan opus · Critique opus')
    expect(phaseModels(summary(RECHECK))).toBe('Critique opus')
    expect(phaseModels(summary(record('wf_9', 0, 1, 1, [])))).toBe('no agents')
  })

  test('an agent’s line names its effort after its model once it is known', async () => {
    const row = { model: 'claude-opus-5-5', tools: 3, tokens: 12_000 } as AgentRow
    expect(agentFacts({ ...row, effort: 'high' }, 'workflow')).toBe('workflow · opus-5-5 · high · 3⚒ · 12k ctx')
    expect(agentFacts({ ...row, effort: '' }, 'workflow')).toBe('workflow · opus-5-5 · 3⚒ · 12k ctx')
    expect(agentFacts(row, 'workflow')).toBe('workflow · opus-5-5 · 3⚒ · 12k ctx')
  })
})
