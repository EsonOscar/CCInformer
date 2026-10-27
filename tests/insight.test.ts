import { describe, expect, test } from 'claude-code/testing'

import { barSpan, ciOutcome, columnChart, compactionMarks, sessionGroups, stepContext } from '../hooks/insight'
import { mergeRecord, parseHead, projectDirName, runFromRecord, upgradeRun } from '../hooks/records'
import { pruneAgents, taskOf } from '../hooks/rows'
import type { AgentRow, CiCheck, CiSnapshot, SessionBeat, StepRow, WorkflowRun } from '../types'

// The shape Claude Code writes for a finished run (trimmed from a real one).
const RECORD = JSON.stringify({
  runId: 'wf_0a1b2c3d-e4f',
  workflowName: 'plan-fanout',
  status: 'completed',
  startTime: 1000,
  durationMs: 729_605,
  totalTokens: 1_080_790,
  phases: [{ title: 'Scout' }, { title: 'Plan' }, { title: 'Critique' }],
  workflowProgress: [
    { type: 'workflow_phase', index: 3, title: 'Critique' },
    { type: 'workflow_agent', index: 1, label: 'critic:fit', phaseTitle: 'Critique', agentId: 'a1', model: 'claude-opus-5-5', state: 'done', startedAt: 2000, tokens: 143_889, toolCalls: 8, durationMs: 222_185 },
  ],
})

describe('run records', () => {
  test('a record becomes a finished run with its agents and the bar’s own totals', async () => {
    const record = runFromRecord(RECORD, 'rec:wf_0a1b2c3d-e4f', 's-0001')!
    expect([record.run.status, record.run.totalTokens, record.run.endedAt, record.run.phases.length]).toEqual(['completed', 1_080_790, 730_605, 3])
    expect(record.agents.map(a => [a.id, a.phase, a.tokens, a.tools, a.endedAt])).toEqual([['a1', 'Critique', 143_889, 8, 224_185]])
    expect(runFromRecord('not json', 'x', '')).toBeNull()
  })

  test('a record folds into the live rows, keeping their output tokens', async () => {
    const live: AgentRow = {
      id: 'a1', description: 'critic:fit', type: 'workflow', model: 'opus', status: 'running', startedAt: 2000, endedAt: 0,
      toolUseId: 'call', runId: 'wf_0a1b2c3d-e4f', phase: '', tools: 3, tokens: 100, output: 4_200,
    }
    const [merged] = mergeRecord([live], runFromRecord(RECORD, 'call', '')!)
    expect([merged!.status, merged!.phase, merged!.tokens, merged!.output]).toEqual(['done', 'Critique', 143_889, 4_200])
  })

  test('a run recorded before runs had a status is finished once all its agents have ended', async () => {
    const old = { toolUseId: 'call', name: 'plan-fanout', phases: ['Critique'], startedAt: 0 } as unknown as WorkflowRun
    const ended = { toolUseId: 'call', status: 'done', endedAt: 50 } as AgentRow
    expect([upgradeRun(old, [ended]).status, upgradeRun(old, [ended]).endedAt]).toEqual(['completed', 50])
    expect(upgradeRun(old, [{ ...ended, status: 'running' }]).status).toBe('running')
  })

  test('the project folder and the branch are read the way Claude Code and git write them', async () => {
    expect(projectDirName('C:\\Users\\dev\\code\\my-app')).toBe('C--Users-dev-code-my-app')
    expect(parseHead('ref: refs/heads/feat/search\n').branch).toBe('feat/search')
    expect(parseHead('gitdir: C:/repo/.git/worktrees/x').gitdir).toBe('C:/repo/.git/worktrees/x')
    expect(parseHead('a1b2c3d4e5f6').branch).toBe('a1b2c3d')
  })

  test('agents of runs no longer listed are dropped, other subagents kept', async () => {
    const a = (id: string, runId: string, toolUseId: string) => ({ id, runId, toolUseId }) as AgentRow
    const kept = pruneAgents([a('x', 'wf_1', 'gone'), a('y', 'wf_2', 'kept'), a('z', '', 'agent')], [{ toolUseId: 'kept' } as never])
    expect(kept.map(r => r.id)).toEqual(['y', 'z'])
  })
})

const check = (bucket: CiCheck['bucket'], name = 'build'): CiCheck => ({ name, workflow: 'CI', bucket, startedAt: '', completedAt: '', link: '' })
const ci = (checks: CiCheck[], head = 'abc'): CiSnapshot => ({ branch: 'feat/x', head, pr: null, checks, source: 'runs', base: null, at: 0, error: '' })

describe('the CI ping', () => {
  test('fires once the checks of the same commit stop running, saying which failed', async () => {
    expect(ciOutcome(ci([check('pending')]), ci([check('pass'), check('pass', 'lint')]))).toEqual({ isOk: true, text: 'CI passed on feat/x: 2 checks' })
    expect(ciOutcome(ci([check('pending')]), ci([check('fail', 'e2e'), check('pass')]))?.text).toBe('CI failed on feat/x: e2e')
  })

  test('stays quiet while checks run, for a new commit, and when nothing was running', async () => {
    expect(ciOutcome(ci([check('pending')]), ci([check('pending')]))).toBeNull()
    expect(ciOutcome(ci([check('pending')], 'old'), ci([check('pass')]))).toBeNull()
    expect(ciOutcome(ci([check('pass')]), ci([check('pass')]))).toBeNull()
    expect(ciOutcome(null, ci([check('pass')]))).toBeNull()
  })
})

describe('sessions', () => {
  const beat = (id: string, cwd: string, updatedAt: number): SessionBeat => ({
    id, cwd, branch: 'develop', task: '', isBusy: false, model: '', contextPercent: 0, startedAt: 0, updatedAt,
  })

  test('sessions in this folder come first with this one leading; stale ones are left out', async () => {
    const groups = sessionGroups(
      [beat('other', 'C:\\repo\\', 95_000), beat('self', 'C:\\Repo', 0), beat('far', 'C:\\else', 99_000), beat('dead', 'C:\\repo', 1_000)],
      'self',
      'C:\\repo',
      100_000,
    )
    expect(groups.here.map(b => b.id)).toEqual(['self', 'other'])
    expect(groups.elsewhere.map(b => b.id)).toEqual(['far'])
  })

  test("a session's task is the first line of its prompt, shortened", async () => {
    expect(taskOf('  fix the   CI ping\nand more')).toBe('fix the CI ping')
    expect(taskOf('x'.repeat(200)).length).toBe(90)
  })
})

describe('charts', () => {
  const step = (startedAt: number, cacheRead: number): StepRow => ({
    key: String(startedAt), model: '', effort: '', agent: '', startedAt, ms: 1, input: 2, cacheRead, cacheWrite: 8, output: 0, stop: '', window: 100,
  })

  test('the context chart fills its columns against the window, from the top row down', async () => {
    expect(columnChart([0, 50, 100], 100, 2)).toEqual(['  █', ' ██'])
    expect(stepContext(step(0, 90))).toBe(100)
  })

  test('a compaction is marked under the first request after it', async () => {
    expect(compactionMarks([step(0, 1), step(10, 1), step(20, 1)], [{ at: 15, trigger: 'auto', before: 0, after: 0, agent: '' }])).toBe('  ▲')
  })

  test('a timeline bar starts and ends where the agent did, at least one cell long', async () => {
    expect(barSpan(25, 75, 0, 100, 20)).toEqual({ at: 5, length: 10 })
    expect(barSpan(99, 99, 0, 100, 20)).toEqual({ at: 19, length: 1 })
  })
})
