import { describe, expect, test } from 'claude-code/testing'

import { phaseElapsed, phasesOf, shownPhase, shownRun, totalsOf } from '../hooks/phases'
import type { AgentRow, AgentState, WorkflowRun } from '../types'

const RUN: WorkflowRun = {
  toolUseId: 'wf',
  runId: 'wf_1',
  name: 'plan-fanout',
  phases: ['Scout', 'Plan', 'Critique'],
  startedAt: 0,
  status: 'running',
  endedAt: 0,
  totalTokens: 0,
  session: '',
}
const FINISHED: WorkflowRun = { ...RUN, status: 'completed', endedAt: 40, totalTokens: 999 }

const agent = (description: string, status: AgentState, startedAt: number, endedAt: number, tok = 0, output = 0): AgentRow => ({
  id: description,
  description,
  type: 'workflow',
  model: 'claude-sonnet-5-5',
  status,
  startedAt,
  endedAt,
  toolUseId: 'wf',
  runId: 'wf_1',
  phase: '',
  tools: 2,
  tokens: tok,
  output,
})

describe('workflow phases', () => {
  test('agents group under their phase, with each phase summed up', async () => {
    const phases = phasesOf(RUN, [
      agent('scout:git', 'done', 1000, 41_000, 30_000),
      agent('scout:db', 'done', 1000, 61_000, 20_000),
      agent('plan:ui', 'running', 62_000, 0, 0),
    ])
    expect(phases.map(p => [p.title, p.state, p.agents.length])).toEqual([
      ['Scout', 'done', 2],
      ['Plan', 'running', 1],
      ['Critique', 'pending', 0],
    ])
    const scout = phases[0]!
    expect([scout.tokens, scout.tools, phaseElapsed(scout, 99_000)]).toEqual([50_000, 4, 60_000])
    expect(phaseElapsed(phases[1]!, 92_000)).toBe(30_000)
  })

  test("the run record's phase wins over the label", async () => {
    const phases = phasesOf(RUN, [{ ...agent('odd-label', 'done', 0, 5), phase: 'Plan' }])
    expect(phases[1]!.agents.map(a => a.id)).toEqual(['odd-label'])
  })

  test('the detail follows the running phase until one is pinned', async () => {
    const phases = phasesOf(RUN, [agent('scout:git', 'done', 0, 10), agent('plan:ui', 'running', 11, 0)])
    expect(shownPhase(phases, '')).toBe(1)
    expect(shownPhase(phases, 'Critique')).toBe(2)
    expect(shownPhase(phases, 'Gone')).toBe(1)
  })

  test('a running run waits between phases; its record says when it is done', async () => {
    const between = totalsOf(RUN, phasesOf(RUN, [agent('scout:git', 'done', 0, 10, 5)]))
    expect(between.state).toBe('waiting')
    const done = totalsOf(FINISHED, phasesOf(FINISHED, [agent('scout:git', 'done', 0, 10, 5, 1), agent('plan:ui', 'done', 11, 20, 7, 2)]))
    expect([done.state, done.tokens, done.output, done.agents, done.endedAt]).toEqual(['done', 999, 3, 2, 40])
  })

  test('a finished re-check that ran only its critics is done, without its unrun phases', async () => {
    const phases = phasesOf(FINISHED, [agent('critic:fit', 'done', 0, 10), agent('critic:gaps', 'done', 0, 12)])
    expect(phases.map(p => p.title)).toEqual(['Critique'])
    expect(totalsOf(FINISHED, phases).state).toBe('done')
  })

  test('an agent no phase claims goes under Other, and a failure shows', async () => {
    const phases = phasesOf(RUN, [agent('verify:x', 'failed', 0, 5, 1)])
    expect(phases.map(p => p.title)).toEqual(['Scout', 'Plan', 'Critique', 'Other'])
    expect(phases[3]!.state).toBe('failed')
  })

  test('the tab shows the picked run, else the running one, and none once all have finished', async () => {
    expect(shownRun([FINISHED, { ...RUN, toolUseId: 'live' }], '')?.toolUseId).toBe('live')
    expect(shownRun([FINISHED], '')).toBeNull()
    expect(shownRun([FINISHED], 'wf')?.status).toBe('completed')
  })
})
