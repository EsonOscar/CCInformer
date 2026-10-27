import { describe, expect, test } from 'claude-code/testing'

import { runFromRecord } from '../hooks/records'
import { isFull, modelFamily, statsFor, summarizeRun, workflowNames } from '../hooks/stats'

type Agent = { label: string; phase: string; model: string; start: number; ms?: number; tokens?: number }

// A run record in the shape Claude Code writes; an agent without `ms` was replayed from the workflow's cache.
const record = (runId: string, startTime: number, durationMs: number, totalTokens: number, agents: Agent[], name = 'plan-fanout') =>
  JSON.stringify({
    runId,
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
      { family: 'opus', agents: 2, ran: 2, ms: 220_000, tokens: 118_000 },
      { family: 'sonnet', agents: 2, ran: 1, ms: 60_000, tokens: 110_000 },
    ])
  })

  test('workflows are listed by how often they ran, and models by family', async () => {
    const other = summary(record('wf_9', 0, 1, 1, [], 'audit-docs'))
    expect(workflowNames([other, summary(OPUS_RUN), summary(RECHECK)])).toEqual(['plan-fanout', 'audit-docs'])
    expect([modelFamily('claude-opus-5-5'), modelFamily('sonnet'), modelFamily('gpt-x')]).toEqual(['opus', 'sonnet', 'gpt-x'])
  })
})
