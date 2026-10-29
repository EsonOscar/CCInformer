import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { groupChanges, parseBranches, parsePr, parseStashes, parseStatus, previewDiff, previewNewFile } from '../hooks/parse'

describe('git output, part two', () => {
  test('changes group into conflicts, staged, unstaged and untracked; a file staged and changed again is in both', async () => {
    const files = parseStatus(
      [
        '1 M. N... 1 1 1 a b staged.ts',
        '1 MM N... 1 1 1 a b both.ts',
        '1 .M N... 1 1 1 a b unstaged.ts',
        'u UU N... 1 1 1 1 a b c conflict.ts',
        '? new.ts',
      ].join('\n'),
    ).files
    const g = groupChanges(files)
    expect([g.conflicts, g.staged, g.unstaged, g.untracked].map(list => list.map(f => f.path))).toEqual([
      ['conflict.ts'],
      ['staged.ts', 'both.ts'],
      ['both.ts', 'unstaged.ts'],
      ['new.ts'],
    ])
  })

  test('branches come newest first without the current one, with their ahead/behind', async () => {
    const text = 'feat/x\x1f13 hours ago\x1f\ndevelop\x1f13 hours ago\x1f[behind 9]\nmain\x1f4 weeks ago\x1f[ahead 1, behind 37]\n'
    expect(parseBranches(text, 'feat/x')).toEqual([
      { name: 'develop', age: '13h', track: '↓9' },
      { name: 'main', age: '4w', track: '↑1, ↓37' },
    ])
    expect(parseStashes('stash@{0}\x1fWIP on develop: a1b2c3d Merge\n')).toEqual(['WIP on develop: a1b2c3d Merge'])
  })

  test('a PR carries its review, merge state and size', async () => {
    const pr = parsePr(
      JSON.stringify({ number: 42, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', additions: 120, deletions: 30, changedFiles: 8 }),
    )!
    expect([pr.review, pr.mergeState, pr.additions, pr.deletions, pr.changedFiles]).toEqual(['APPROVED', 'CLEAN', 120, 30, 8])
  })

  test('a diff preview starts at its first hunk and stops after 80 lines; a new file shows as added', async () => {
    const diff = ['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(previewDiff(diff)).toBe('@@ -1 +1 @@\n-old\n+new')
    const long = previewDiff(['@@ -1,100 +1,100 @@', ...Array.from({ length: 100 }, (_, i) => ' ' + i)].join('\n'))
    expect(long.split('\n').length).toBe(81)
    expect(previewNewFile('a\nb')).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
  })
})

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

// A repository on develop with one unstaged file, as git and gh answer for it.
const ANSWERS: [RegExp, string][] = [
  [/^git status/, '# branch.oid abc123\n# branch.head develop\n# branch.upstream origin/develop\n# branch.ab +1 -0\n1 .M N... 1 1 1 a b src/app.ts\n'],
  [/^git diff --numstat/, '3\t1\tsrc/app.ts\n'],
  [/^git diff --no-color/, 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n'],
  [/^git log .*@\{u\}\.\.HEAD/, 'abc123\x1fFix the ping\x1f2 minutes ago\n'],
  [/^git log .*HEAD\.\.@\{u\}/, ''],
  [/^git log/, 'abc123\x1fFix the ping\x1f2 minutes ago\n'],
  [/^git rev-parse/, '/repo/.git\n/repo\n'],
]

// `answers` come first, ahead of ANSWERS.
const engine = (on: Parameters<TestBody>[1], answers: [RegExp, string][] = []) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const answer = [...answers, ...ANSWERS].find(([pattern]) => pattern.test(line))
    const ok = !!answer || line.startsWith('git ')
    return { value: { exitCode: ok ? 0 : 1, stdout: answer?.[1] ?? '', stderr: ok ? '' : 'gh is not set up', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'side' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('Code groups the changes, lists unpushed commits, and shows a file’s diff when it is pressed', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-code' })
  expect(await ui.find({ type: 'Text', text: /Unstaged · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fix the ping/ })).toBeDefined()

  await ui.press({ key: 'file-Unstaged-src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.press({ key: 'file-Unstaged-src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

// The row drawn right above the branch's, and the branch's own.
const shownAboveBranch = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = texts.findIndex(t => t.startsWith('⎇ '))
  return texts.slice(at - 1, at + 1)
}

test("Git names the repository above the branch, a linked worktree's by the repository it belongs to", async ($, on) => {
  engine(on, [[/^git worktree list/, 'worktree /home/me/shop\nHEAD abc123\nbranch refs/heads/main\n\nworktree /tmp/shop-cart\nHEAD def456\nbranch refs/heads/develop\n']])
  await $.session.start({ cwd: '/tmp/shop-cart', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-code' })
  expect(await shownAboveBranch(ui)).toEqual(['shop', '⎇ develop'])
  await ui.unmount()
})

test('without a worktree list, the repository is named by its top folder', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'area-code' })
  expect(await shownAboveBranch(ui)).toEqual(['repo', '⎇ develop'])
  await ui.unmount()
})
