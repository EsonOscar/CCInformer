import { describe, expect, test } from 'claude-code/testing'

import { duration, manifestVersion, paneTitle, shortModel, tokens } from '../hooks/format'
import { parseChecks, parseLog, parseNumstat, parseRuns, parseStatus, parseWorkflowMeta, parseWorktrees, phaseOf, withNumstat } from '../hooks/parse'
import { contextTokens, isPush, summarize } from '../hooks/rows'

describe('git output', () => {
  test('status reads the branch, its upstream, ahead/behind and each kind of change', async () => {
    const status = parseStatus(
      [
        '# branch.oid a1b2c3d4e5',
        '# branch.head develop',
        '# branch.upstream origin/develop',
        '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 aaa bbb src/routes.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 docs/new name.md\tdocs/old.md',
        '? notes.txt',
      ].join('\n'),
    )
    expect(status.branch).toBe('develop')
    expect(status.upstream).toBe('origin/develop')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(1)
    expect(status.head).toBe('a1b2c3d4e5')
    expect(status.files.map(f => [f.code, f.path])).toEqual([
      [' M', 'src/routes.ts'],
      ['R ', 'docs/new name.md'],
      ['??', 'notes.txt'],
    ])
  })

  test('numstat adds line counts to the matching files, and a binary file counts zero', async () => {
    const files = parseStatus('1 .M N... 1 1 1 a b src/a.ts\n1 .M N... 1 1 1 a b logo.png').files
    const merged = withNumstat(files, parseNumstat('12\t3\tsrc/a.ts\n-\t-\tlogo.png'))
    expect(merged.map(f => [f.added, f.removed])).toEqual([
      [12, 3],
      [0, 0],
    ])
  })

  test('log and worktrees parse their porcelain', async () => {
    expect(parseLog('a1b2c3d\x1fMerge pull request #12\x1f3 hours ago')).toEqual([
      { sha: 'a1b2c3d', subject: 'Merge pull request #12', age: '3h' },
    ])
    const trees = parseWorktrees('worktree C:/x/my-app\nHEAD abc\nbranch refs/heads/develop\n\nworktree C:/x/fix\nHEAD def\ndetached\n')
    expect(trees).toEqual([
      { path: 'C:/x/my-app', branch: 'develop' },
      { path: 'C:/x/fix', branch: '(detached)' },
    ])
  })
})

describe('CI output', () => {
  test('PR checks keep gh buckets and treat an unknown one as pending', async () => {
    const checks = parseChecks(JSON.stringify([{ name: 'build', bucket: 'pass' }, { name: 'e2e', bucket: 'weird' }]))
    expect(checks.map(c => c.bucket)).toEqual(['pass', 'pending'])
    expect(parseChecks('not json')).toEqual([])
  })

  test('runs are those of the checked-out commit, mapped to buckets', async () => {
    const runs = JSON.stringify([
      { workflowName: 'CI', status: 'completed', conclusion: 'failure', headSha: 'old', createdAt: 'x', updatedAt: 'y' },
      { workflowName: 'CI', status: 'in_progress', conclusion: '', headSha: 'head', createdAt: 'x', updatedAt: 'y' },
      { workflowName: 'DB', status: 'completed', conclusion: 'success', headSha: 'head', createdAt: 'x', updatedAt: 'y' },
    ])
    expect(parseRuns(runs, 'head').map(c => [c.name, c.bucket])).toEqual([
      ['CI', 'pending'],
      ['DB', 'pass'],
    ])
  })

  test('with no run for the checked-out commit, the newest commit with runs is shown', async () => {
    const runs = JSON.stringify([{ workflowName: 'CI', status: 'completed', conclusion: 'cancelled', headSha: 'old' }])
    expect(parseRuns(runs, 'head').map(c => c.bucket)).toEqual(['cancel'])
  })
})

describe('workflows', () => {
  const script = `export const meta = {
  name: 'plan-fanout',
  description: 'x',
  phases: [
    { title: 'Scout', detail: 'a', model: 'sonnet' },
    { title: 'Plan', detail: 'b' },
    { title: 'Critique', detail: 'c' },
  ],
}
phase('Scout')`

  test('the meta block gives the name and the phases', async () => {
    expect(parseWorkflowMeta(script)).toEqual({ name: 'plan-fanout', phases: ['Scout', 'Plan', 'Critique'] })
  })

  test('agent labels map to the phase they belong to', async () => {
    const phases = ['Scout', 'Plan', 'Critique']
    expect(phaseOf('scout:git', phases)).toBe('Scout')
    expect(phaseOf('plan:ui', phases)).toBe('Plan')
    expect(phaseOf('critic:fit', phases)).toBe('Critique')
    expect(phaseOf('verify:x', phases)).toBe('')
  })
})

describe('formatting and summaries', () => {
  test('durations, token counts and model names read short', async () => {
    expect([duration(400), duration(12_000), duration(62_000), duration(3_900_000)]).toEqual(['0.4s', '12s', '1m02s', '1h05m'])
    expect([tokens(812), tokens(12_345), tokens(1_200_000)]).toEqual(['812', '12k', '1.2M'])
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
  })

  test('the installed release is named plainly, a working copy says dev', async () => {
    expect(paneTitle('CCInformer', 'C:\\Users\\me\\.claude\\plugins\\cache\\ccinformer\\ccinformer\\0.3.0')).toBe('CCInformer')
    expect(paneTitle('CCInformer', '/home/me/.claude/plugins/cache/ccinformer/ccinformer/0.3.0')).toBe('CCInformer')
    expect(paneTitle('CCInformer', '/home/me/code/CCInformer/.claude/worktrees/some-task')).toBe('CCInformer · dev')
  })

  test("the version is plugin.json's, or nothing when it names none or doesn't parse", async () => {
    expect(manifestVersion('{ "name": "ccinformer", "version": "1.2.3" }')).toBe('1.2.3')
    expect(manifestVersion('{ "name": "ccinformer" }')).toBe('')
    expect(manifestVersion('{ "version": 3 }')).toBe('')
    expect(manifestVersion('')).toBe('')
    expect(manifestVersion('{ not json')).toBe('')
  })

  test('a tool call is summed up by its file, command or MCP server', async () => {
    expect(summarize('Read', { file_path: 'C:\\repo\\src\\App.tsx' })).toBe('App.tsx')
    expect(summarize('Bash', { command: 'git status\ngit log' })).toBe('git status')
    expect(summarize('mcp__claude_ai_Example__run_query', {})).toBe('claude_ai_Example')
  })

  test("an agent's tokens are its last request's context, within a few tokens of the workflow bar", async () => {
    // A scout's last request from a real run, which the workflow bar showed as 137,060 tokens.
    const usage = { input_tokens: 2, cache_read_input_tokens: 136_483, cache_creation_input_tokens: 571, output_tokens: 4_264 }
    expect(contextTokens(usage)).toBe(137_056)
  })

  test('a push or a PR is noticed, other commands are not', async () => {
    expect(isPush('git push -u origin feat/x')).toBe(true)
    expect(isPush('gh pr create --base develop')).toBe(true)
    expect(isPush('git status')).toBe(false)
  })
})
