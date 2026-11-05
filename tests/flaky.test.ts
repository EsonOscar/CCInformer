import { describe, expect, test } from 'claude-code/testing'

import { addRun, flakedJobs, markFlaky, rerunRuns } from '../hooks/git/flaky'
import type { CiCheck, CiSnapshot } from '../types'

const NOW = Date.parse('2026-01-10T12:00:00Z')
const run = (id: number, attempt: number, createdAt: string, headSha = 'other1') => ({
  databaseId: id,
  attempt,
  headSha,
  createdAt,
  url: `https://github.com/acme/shop/actions/runs/${id}`,
})
const job = (name: string, attempt: number, conclusion: string, workflow = 'CI') => ({ name, workflow_name: workflow, run_attempt: attempt, conclusion })
const check = (name: string, bucket: CiCheck['bucket']): CiCheck => ({ name, workflow: 'CI', bucket, startedAt: '', completedAt: '', link: '' })
const snapshot = (checks: CiCheck[], source: CiSnapshot['source'] = 'pr'): CiSnapshot => ({
  branch: 'feat/cart',
  head: 'head1',
  pr: null,
  checks,
  source,
  base: null,
  at: 0,
  error: '',
})

describe('the runs that were rerun', () => {
  test('a first attempt and a run older than a week are left out; the newest come first, at most ten', async () => {
    const runs = [
      run(1, 1, '2026-01-09T00:00:00Z'),
      run(2, 2, '2026-01-08T00:00:00Z'),
      run(3, 3, '2026-01-09T06:00:00Z'),
      run(4, 2, '2026-01-01T00:00:00Z'),
    ]
    expect(rerunRuns(JSON.stringify(runs), NOW)).toEqual([
      { id: '3', head: 'other1', url: 'https://github.com/acme/shop/actions/runs/3' },
      { id: '2', head: 'other1', url: 'https://github.com/acme/shop/actions/runs/2' },
    ])
    const many = Array.from({ length: 14 }, (_, i) => run(10 + i, 2, `2026-01-09T${String(i).padStart(2, '0')}:00:00Z`))
    expect(rerunRuns(JSON.stringify(many), NOW).map(r => r.id)).toEqual(['23', '22', '21', '20', '19', '18', '17', '16', '15', '14'])
    expect(rerunRuns('not json', NOW)).toEqual([])
  })
})

describe('the jobs that flaked', () => {
  test('failed or timed out, then passed in a later attempt; the job name is kept whole', async () => {
    const jobs = [
      job('e2e', 1, 'failure'),
      job('e2e', 2, 'success'),
      job('test (ubuntu, 18)', 1, 'timed_out'),
      job('test (ubuntu, 18)', 2, 'success'),
      job('lint', 1, 'success'),
      job('lint', 2, 'failure'),
      job('build', 1, 'failure'),
      job('build', 2, 'failure'),
    ]
    expect(flakedJobs(JSON.stringify({ total_count: jobs.length, jobs }))).toEqual(['CI/e2e', 'CI/test (ubuntu, 18)'])
    expect(flakedJobs('{}')).toEqual([])
  })
})

describe('marking failed checks', () => {
  const index = addRun(
    addRun(addRun({}, { id: '7', head: 'other1', url: '' }, ['CI/e2e']), { id: '8', head: 'head1', url: '' }, ['CI/e2e']),
    { id: '7', head: 'other1', url: '' },
    ['CI/e2e'],
  )

  test("a failed PR check counts the distinct other runs its job flaked in; this commit's own runs don't count", async () => {
    expect(index['CI/e2e']).toEqual([
      { id: '7', head: 'other1' },
      { id: '8', head: 'head1' },
    ])
    const ci = snapshot([check('e2e', 'fail'), check('lint', 'fail'), check('build', 'pass')])
    const marked = markFlaky(ci, index)
    expect(marked.checks.map(c => c.flaky)).toEqual([1, undefined, undefined])
    // Unmarked checks are the same objects.
    expect(marked.checks[1]).toBe(ci.checks[1])
  })

  test("a passing check, a branch's runs and nothing to mark leave the snapshot as it was", async () => {
    const passing = snapshot([check('e2e', 'pass')])
    expect(markFlaky(passing, index)).toBe(passing)
    const runs = snapshot([check('e2e', 'fail')], 'runs')
    expect(markFlaky(runs, index)).toBe(runs)
    const plain = snapshot([check('lint', 'fail')])
    expect(markFlaky(plain, index)).toBe(plain)
  })
})
