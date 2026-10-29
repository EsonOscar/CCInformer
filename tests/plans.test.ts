import { describe, expect, test } from 'claude-code/testing'

import {
  archiveDirFor,
  archivePath,
  archiveQuestion,
  isReminderDue,
  markdownLinks,
  moveOwnLinks,
  reminderText,
  removeCommand,
  rewriteRefs,
} from '../hooks/plans/archive'
import { isFinished, mergedPrs, mergedToast, mergedWarnings, prState, prsToAsk } from '../hooks/plans/drift'
import { leadingIds, parsePlan } from '../hooks/plans/parse'
import type { PlanCheckpoint, PlanFile, PlanStatus } from '../types'

const board = (text: string, spec = {}) => parsePlan(text, spec).checkpoints.map(c => [c.id, c.status, c.title, c.prs])

describe('plan shapes', () => {
  test('stage headings carry their status; mentions and prose labels are not checkpoints', async () => {
    const plan = [
      '# Shop backend: the plan',
      '## Status',
      '| Stage | State | Notes |',
      '|---|---|---|',
      '| R1, hosting move | ✅ 2026-10-16 | #12, #13 |',
      '| R2, the API | 🟡 | **R2a ✅ done** (#20); R2b next |',
      '| R3\u2013R5, later | ⬜ | |',
      '## Stages',
      '### R1: hosting move \u2014 ✅ DONE 2026-10-16',
      '**R1 done when** the smoke test passes.',
      '### R2: the API \u2014 🟡 PARTLY',
      '- **R2a** `/me` and `/bootstrap` (#20).',
      '- **R2b** board writes.',
      '### R3: reports \u2014 ⬜ TODO (after tenant CP5)',
      '### R4: webshop \u2014 ⬜ TODO',
      '### R5: lockdown \u2014 dropped 2026-10-20',
      '### Track A: security \u2014 ✅',
      '1. **R2 before R3 was a gate.** Still holds.',
      '| R3 waits for CP5 | noted |',
    ].join('\n')
    expect(board(plan)).toEqual([
      ['R1', 'done', 'hosting move', [12, 13]],
      // Its own cells say 🟡; the notes about R2a don't make R2 done.
      ['R2', 'partly', 'the API', [20]],
      // A range's shared name gives way to each stage's own heading.
      ['R3', 'open', 'reports', []],
      ['R4', 'open', 'webshop', []],
      ['R5', 'dropped', 'lockdown', []],
      ['R2a', 'open', '/me and /bootstrap (#20)', [20]],
      ['R2b', 'open', 'board writes', []],
    ])
    expect(parsePlan(plan, {}).title).toBe('Shop backend: the plan')
  })

  test('PR headings: "merged as #N" is done, a section label that only starts with an id is not one', async () => {
    const plan = [
      '# Editor speed (October)',
      '### PR 1, previews v2 \u2014 merged as #353',
      '### PR 2, lazy tiles (#4, plan mode)',
      '**PR 2 planning counts, after the backfill:**',
      '### PR 3, fonts',
      '| A risk | how it is handled |',
      '| R5a (server signing) changes storage later | the seams stay |',
    ].join('\n')
    expect(board(plan)).toEqual([
      ['PR 1', 'done', 'previews v2', [353]],
      ['PR 2', 'open', 'lazy tiles (#4, plan mode)', [4]],
      ['PR 3', 'open', 'fonts', []],
    ])
  })

  test('bold labels: ranges and lists expand, repeats are one checkpoint, results labels are not definitions', async () => {
    const plan = [
      '# PR 4: the screen renderer',
      '## 4a checkpoints',
      '**CP0, facts** ⚠ OK (read-only SQL):',
      '**CP0 results (2026-10-21, staging):**',
      '- **CP1\u2013CP3, CP1b:** storage, engine, resolver.',
      '**CP4, checks:**',
      '## 4b checkpoints',
      '- **CP1, shared geometry:** passed (#362)',
      '- **CP1\u2013CP4 results (2026-10-22):**',
    ].join('\n')
    expect(board(plan)).toEqual([
      ['CP0', 'open', 'facts', []],
      // The second series' CP1 is the same checkpoint: its "passed" makes it done, and as its first name came from a
      // range, its own definition names it.
      ['CP1', 'done', 'shared geometry', [362]],
      ['CP2', 'open', 'storage, engine, resolver', []],
      ['CP3', 'open', 'storage, engine, resolver', []],
      ['CP1b', 'open', 'storage, engine, resolver', []],
      ['CP4', 'open', 'checks', []],
    ])
  })

  test('table rows: the first two cells set the status; a struck-through id is done; superseded is dropped', async () => {
    const plan = [
      '# Development plan',
      '| CP | PR (`type(scope)`) | Done when |',
      '|---|---|---|',
      '| C1 | `chore(repo): leak guard` \u2014 **merged as #8 (2026-10-27)** | a seeded word blocks a commit |',
      '| C2 | `refactor(pane): lanes` | all tests pass; done when the CI step fails on run |',
      '| ~~C3~~ | `feat(pane): areas` | |',
      '| C10a | `feat(plans): merged, archive?` | |',
      '| C11 | superseded by C12 | |',
    ].join('\n')
    // A first cell that holds only the id takes its name from the second.
    expect(board(plan)).toEqual([
      ['C1', 'done', 'chore(repo): leak guard', [8]],
      ['C2', 'open', 'refactor(pane): lanes', []],
      ['C3', 'done', 'feat(pane): areas', []],
      ['C10a', 'open', 'feat(plans): merged, archive?', []],
      ['C11', 'dropped', 'superseded by C12', []],
    ])
  })

  test("titles leave out a plan's emoji, keeping the warning sign", async () => {
    const plan = ['# T', '| C18 | `feat(packs): godot` ⏸️ the game\'s path |', '### R6: ⚠ risky 🚀 launch'].join('\n')
    expect(board(plan)).toEqual([
      ['C18', 'open', "feat(packs): godot the game's path", []],
      ['R6', 'open', '⚠ risky launch', []],
    ])
  })

  test('nothing inside a code fence counts, and a pack can name its own ids and done marker', async () => {
    expect(board('# T\n```md\n### R9: in a fence\n```\n### R1: real')).toEqual([['R1', 'open', 'real', []]])
    const spec = { checkpoint: 'K\\d+', done: ['\\[x\\]'] }
    expect(board('# T\n- **K1** [x] login\n- **K2** [ ] logout\n### R1: not an id here', spec)).toEqual([
      ['K1', 'done', '[x] login', []],
      ['K2', 'open', '[ ] logout', []],
    ])
  })
})

test('the ids a definition starts with', async () => {
  const id = '(?:CP|C|R|PR ?)\\d+[a-z]?'
  expect(leadingIds('CP8\u2013CP10, CP8a', id)).toEqual(['CP8', 'CP9', 'CP10', 'CP8a'])
  expect(leadingIds('R7\u2013R12, M, R13', id)).toEqual(['R7', 'R8', 'R9', 'R10', 'R11', 'R12'])
  expect(leadingIds('CP0 / M0', id)).toEqual(['CP0'])
  expect(leadingIds('PR 4a, zones', id)).toEqual(['PR 4a'])
  expect(leadingIds('R5a (server signing)', id)).toEqual([])
  expect(leadingIds('Requirements', id)).toEqual([])
})

describe('where a plan and GitHub disagree', () => {
  const checkpoint = (id: string, status: PlanStatus, prs: number[]): PlanCheckpoint => ({ id, title: '', status, prs, line: 1 })
  const plan = (...checkpoints: PlanCheckpoint[]): PlanFile => ({ path: 'p.md', title: '', checkpoints })

  test("only an open or partly checkpoint's PRs are asked about, once each, until their state is final", async () => {
    const plans = [
      plan(checkpoint('C1', 'done', [1]), checkpoint('C2', 'open', [3, 2]), checkpoint('C3', 'dropped', [4])),
      plan(checkpoint('C1', 'partly', [2, 5, 6, 7])),
    ]
    const known = new Map([
      [5, 'MERGED'],
      [6, 'CLOSED'],
      [7, 'OPEN'],
    ])
    expect(prsToAsk(plans, known)).toEqual([2, 3, 7])
    // The poll asks only about PRs not asked about yet: the open #7 waits for a recheck.
    expect(prsToAsk(plans, known, false)).toEqual([2, 3])
  })

  test('a merged PR is warned about on a checkpoint that still reads open, never on a done or dropped one', async () => {
    const merged = new Set([2, 3])
    expect(mergedPrs(checkpoint('C1', 'open', [1, 2, 3]), merged)).toEqual([2, 3])
    expect(mergedPrs(checkpoint('C1', 'partly', [2]), merged)).toEqual([2])
    expect(mergedPrs(checkpoint('C1', 'done', [2]), merged)).toEqual([])
    expect(mergedPrs(checkpoint('C1', 'dropped', [2]), merged)).toEqual([])
  })

  test('a plan is finished when every checkpoint is done or dropped', async () => {
    expect(isFinished(plan(checkpoint('C1', 'done', []), checkpoint('C2', 'dropped', [])))).toBe(true)
    expect(isFinished(plan(checkpoint('C1', 'done', []), checkpoint('C2', 'partly', [])))).toBe(false)
    expect(isFinished(plan())).toBe(false)
  })

  test('a toast for PRs seen to turn from open to merged under an open checkpoint, one per PR', async () => {
    const plans = [plan(checkpoint('C1', 'open', [2]), checkpoint('C2', 'partly', [2, 3]), checkpoint('C3', 'done', [4]))]
    const after = new Map([
      [2, 'MERGED'],
      [3, 'MERGED'],
      [4, 'MERGED'],
    ])
    // Already merged when first asked about: badge only. #4's checkpoint is done: nothing.
    expect(mergedToast(plans, new Map(), after)).toBeNull()
    expect(mergedToast(plans, new Map([[4, 'OPEN']]), after)).toBeNull()
    expect(mergedToast(plans, new Map([[2, 'OPEN']]), after)).toBe('PR #2 merged, but C1 in p.md still reads open')
    expect(
      mergedToast(
        plans,
        new Map([
          [2, 'OPEN'],
          [3, 'OPEN'],
        ]),
        after,
      ),
    ).toBe('2 PRs merged while their checkpoints still read open: see Work › Plans')
    expect(mergedWarnings(plans, new Set([2, 4]))).toEqual([
      { pr: 2, id: 'C1', path: 'p.md' },
      { pr: 2, id: 'C2', path: 'p.md' },
    ])
  })

  test("a PR's state, read from gh's JSON", async () => {
    expect(prState('{"state":"MERGED"}\n')).toBe('MERGED')
    expect(prState('')).toBeNull()
    expect(prState('{"number":4}')).toBeNull()
    expect(prState('GraphQL: Could not resolve to a PullRequest')).toBeNull()
  })
})

describe('archiving a plan', () => {
  const FROM = '.local/plans/x.md'
  const TO = '.local/plans/archive/x.md'

  test('a plan in .local/plans is archived beside it; a pack plan only where the pack says', async () => {
    expect(archiveDirFor(FROM, undefined)).toBe('.local/plans/archive')
    expect(archiveDirFor('docs/plans/y.md', { archiveDir: 'docs/plans/archive/' })).toBe('docs/plans/archive')
    expect(archiveDirFor('docs/plans/y.md', {})).toBeNull()
    expect(archivePath(FROM, '.local/plans/archive')).toBe(TO)
  })

  test('links that lead to the plan, from any folder, lead to the archive copy', async () => {
    expect(rewriteRefs('See [the plan](plans/x.md#cp2).', '.local', FROM, TO)).toBe('See [the plan](plans/archive/x.md#cp2).')
    expect(rewriteRefs('[x](../plans/x.md "title")', '.local/notes', FROM, TO)).toBe('[x](../plans/archive/x.md "title")')
    // Another file, a URL and an anchor stay as they are.
    const others = '[y](plans/y.md) [web](https://example.com/plans/x.md) [here](#plans)'
    expect(rewriteRefs(others, '.local', FROM, TO)).toBe(others)
  })

  test('plain mentions of the path move too, only where the whole path is named', async () => {
    expect(rewriteRefs('plan in `.local/plans/x.md`, done', '.local', FROM, TO)).toBe('plan in `.local/plans/archive/x.md`, done')
    expect(rewriteRefs('C:/repo/.local/plans/x.md', null, FROM, TO)).toBe('C:/repo/.local/plans/archive/x.md')
    const untouched = '.local/plans/archive/x.md, foo.local/plans/x.md, .local/plans/x.md5'
    expect(rewriteRefs(untouched, '.local', FROM, TO)).toBe(untouched)
    // A note outside the repo has no links to work out, only mentions.
    expect(rewriteRefs('[n](x.md) and .local/plans/x.md', null, FROM, TO)).toBe('[n](x.md) and .local/plans/archive/x.md')
  })

  test("the moved plan's own links lead where they did before", async () => {
    const text = '[dev](../DEV-PLAN.md) [sibling](y.md#cp1) [web](https://example.com)'
    expect(moveOwnLinks(text, '.local/plans', '.local/plans/archive')).toBe('[dev](../../DEV-PLAN.md) [sibling](../y.md#cp1) [web](https://example.com)')
    expect(markdownLinks(text)).toEqual(['../DEV-PLAN.md', 'y.md'])
  })

  test('removing a file: PowerShell with the path quoted, or rm', async () => {
    expect(removeCommand('windows', "C:/repo/.local/plans/it's.md").at(-1)).toBe("Remove-Item -LiteralPath 'C:/repo/.local/plans/it''s.md' -ErrorAction Stop")
    expect(removeCommand('posix', '/repo/.local/plans/x.md')).toEqual(['rm', '--', '/repo/.local/plans/x.md'])
  })

  test('the reminder comes at most once a day; the words', async () => {
    const hour = 60 * 60_000
    expect(isReminderDue(null, 0)).toBe(true)
    expect(isReminderDue(0, 23 * hour)).toBe(false)
    expect(isReminderDue(0, 24 * hour)).toBe(true)
    expect(reminderText(1)).toBe('1 finished plan: archive it in Work › Plans (select it, then a)')
    expect(reminderText(2)).toBe('2 finished plans: archive them in Work › Plans (select one, then a)')
  })

  test('the dialog names the move, the files it changes and what is still open', async () => {
    expect(archiveQuestion(FROM, TO, [], 0)).toBe('Move .local/plans/x.md to .local/plans/archive/x.md?')
    expect(archiveQuestion(FROM, TO, ['.local/DEV-PLAN.md'], 1)).toBe(
      'Move .local/plans/x.md to .local/plans/archive/x.md and update references in 1 file (.local/DEV-PLAN.md)? 1 checkpoint is still open.',
    )
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(f => f + '.md')
    expect(archiveQuestion(FROM, TO, files, 3)).toBe(
      'Move .local/plans/x.md to .local/plans/archive/x.md and update references in 8 files (a.md, b.md, c.md, d.md, e.md, f.md, and 2 more)? 3 checkpoints are still open.',
    )
  })
})
