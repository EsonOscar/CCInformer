import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// These drive minutes of mocked time, a tick at a time: on a busy machine that takes longer than the default limit
// in real time, which says nothing about the mod.
const CLOCK_HEAVY = { timeoutMs: 20_000 }

import type { Ran } from '../hooks/collect'
import { HEAVY_TIMEOUT_MS, LIGHT_SLOTS, LIGHT_TIMEOUT_MS, createLanes, createSolo } from '../hooks/core/lanes'

const OK: Ran = { exitCode: 0, stdout: '', stderr: '' }

// Lets every promise that can move, move.
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// A command runner that answers only when the test says so, and remembers what it was asked.
const heldRun = () => {
  const started: { argv: string[]; timeoutMs: number }[] = []
  const answers = new Map<string, { ok: (r: Ran) => void; fail: (e: Error) => void }>()
  const run = (argv: string[], timeoutMs: number) => {
    started.push({ argv, timeoutMs })
    return new Promise<Ran>((ok, fail) => answers.set(argv.join(' '), { ok, fail }))
  }
  const answer = async (line: string) => {
    answers.get(line)?.ok(OK)
    await flush()
  }
  const fail = async (line: string) => {
    answers.get(line)?.fail(new Error('could not start'))
    await flush()
  }
  const lines = () => started.map(s => s.argv.join(' '))
  return { run, started, lines, answer, fail }
}

describe('exec lanes', () => {
  test('the light lane runs a few commands at once; the next waits for a free slot, first come first served', async () => {
    const r = heldRun()
    const { light } = createLanes(r.run)
    const names = Array.from({ length: LIGHT_SLOTS + 2 }, (_, i) => 'git c' + i)
    for (const name of names) void light(name.split(' '))
    await flush()
    expect(r.lines()).toEqual(names.slice(0, LIGHT_SLOTS))

    await r.answer('git c1')
    expect(r.lines()).toEqual(names.slice(0, LIGHT_SLOTS + 1))
    await r.answer('git c0')
    expect(r.lines()).toEqual(names)
  })

  test('the heavy lane runs one job at a time, and the light lane goes on beside it', async () => {
    const r = heldRun()
    const { light, heavy } = createLanes(r.run)
    void heavy(['git', 'fetch'])
    void heavy(['npm', 'build'])
    void light(['git', 'status'])
    await flush()
    expect(r.lines()).toEqual(['git fetch', 'git status'])

    await r.answer('git fetch')
    expect(r.lines()).toEqual(['git fetch', 'git status', 'npm build'])
  })

  test('a freed slot goes to the job that waited, not to one that arrives just after', async () => {
    const r = heldRun()
    const { heavy } = createLanes(r.run)
    void heavy(['git', 'fetch'])
    void heavy(['npm', 'build'])
    await flush()
    await r.answer('git fetch')
    void heavy(['npm', 'test'])
    await flush()
    expect(r.lines()).toEqual(['git fetch', 'npm build'])
  })

  test('each lane has its own timeout, and a caller’s own wins', async () => {
    const r = heldRun()
    const { light, heavy } = createLanes(r.run)
    void light(['git', 'status'])
    void heavy(['git', 'fetch'])
    void light(['gh', 'pr'], 5000)
    await flush()
    expect(r.started.map(s => s.timeoutMs)).toEqual([LIGHT_TIMEOUT_MS, HEAVY_TIMEOUT_MS, 5000])
  })

  test('a command that fails to start rejects to its caller and frees its slot', async () => {
    const r = heldRun()
    const { heavy } = createLanes(r.run)
    const first = heavy(['gh', 'run'])
    void heavy(['git', 'fetch'])
    await flush()
    await r.fail('gh run')
    expect(await first.catch((err: Error) => err.message)).toBe('could not start')
    expect(r.lines()).toEqual(['gh run', 'git fetch'])
  })

  test('a job is skipped while its last run is busy, runs again once it ends, and other jobs run beside it', async () => {
    const solo = createSolo()
    const ends: Record<string, () => void> = {}
    const ran: string[] = []
    const job = (name: string) => () => {
      ran.push(name)
      return new Promise<void>(end => (ends[name] = end))
    }
    void solo('git', job('git'))
    void solo('git', job('git again'))
    void solo('ci', job('ci'))
    await flush()
    expect(ran).toEqual(['git', 'ci'])

    ends.git?.()
    await flush()
    void solo('git', job('git later'))
    await flush()
    expect(ran).toEqual(['git', 'ci', 'git later'])
  })

  test('a job that throws frees its key', async () => {
    const solo = createSolo()
    await solo('git', async () => {
      throw new Error('boom')
    }).catch(() => undefined)
    let ran = false
    await solo('git', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const STATUS = '# branch.oid abc123\n# branch.head develop\n# branch.upstream origin/develop\n# branch.ab +0 -0\n'

// A repository where `git status` and `git fetch` take as long as the test says, on the mocked clock. `calls` holds
// each command line as it starts, `started` the same with the time, and `done` each line as it answers.
const engine = (on: Parameters<TestBody>[1], ms: { status: number; fetch: number }) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const calls: string[] = []
  const started: { line: string; at: number }[] = []
  const done: string[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', async (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    calls.push(line)
    started.push({ line, at: clock.now() })
    if (line.startsWith('git status')) await clock.sleep(ms.status)
    if (line.startsWith('git fetch')) await clock.sleep(ms.fetch)
    done.push(line)
    const stdout = line.startsWith('git status') ? STATUS : line.startsWith('git rev-parse') ? '/repo/.git\n/repo\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'side' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  const count = (list: string[], prefix: string) => list.filter(l => l.startsWith(prefix)).length
  return { clock, calls, started, done, count }
}

test('a git refresh that takes 3 s runs once however often it is asked for meanwhile, then again', CLOCK_HEAVY, async ($, on) => {
  const w = engine(on, { status: 3000, fetch: 0 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'area-code' })
  for (let i = 0; i < 2; i++) {
    await w.clock.advance(1000)
    await ui.press({ key: 'refresh' })
  }
  expect(w.count(w.calls, 'git status')).toBe(1)

  await w.clock.advance(1000)
  expect(w.count(w.done, 'git status')).toBe(1)
  await ui.press({ key: 'refresh' })
  await w.clock.settle()
  expect(w.count(w.calls, 'git status')).toBe(2)
  // Nothing is left running when the test ends.
  await w.clock.advance(3000)
  await ui.unmount()
})

test('git keeps refreshing while a 20 s fetch holds the heavy lane, and a second fetch waits its turn', CLOCK_HEAVY, async ($, on) => {
  const w = engine(on, { status: 0, fetch: 20_000 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'area-code' })
  await w.clock.settle()
  await ui.press({ key: 'git-fetch' })
  await ui.press({ key: 'git-fetch' })
  await w.clock.settle()
  expect(w.count(w.calls, 'git fetch')).toBe(1)

  // A second in, the fetch still runs, and a refresh reads git at once.
  await w.clock.advance(1000)
  const before = w.count(w.done, 'git status')
  await ui.press({ key: 'refresh' })
  await w.clock.settle()
  expect(w.count(w.done, 'git status')).toBe(before + 1)
  expect(w.count(w.done, 'git fetch')).toBe(0)

  // Once the first fetch ends, the second one starts.
  await w.clock.advance(19_000)
  expect(w.count(w.done, 'git fetch')).toBe(1)
  expect(w.count(w.calls, 'git fetch')).toBe(2)
  await w.clock.advance(20_000)
  await ui.unmount()
})

test('when git and CI come due on the same tick, CI waits for git, so it reads the branch git just found', CLOCK_HEAVY, async ($, on) => {
  const w = engine(on, { status: 3000, fetch: 0 })
  const start = w.clock.now()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
  await $.command.run({ ...typed, command: 'ccinformer', args: 'git' })
  // A push keeps CI live for a while, polled every 8 ticks; git is polled every 5, so both come due on tick 40.
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  const tick40 = start + 40_000
  const ghSince40 = () => w.started.filter(s => s.line.startsWith('gh ') && s.at >= tick40)
  await w.clock.advance(40_000)
  expect(w.started.find(s => s.line.startsWith('git status') && s.at === tick40)).toBeDefined()
  await w.clock.advance(2000)
  expect(ghSince40()).toEqual([])
  await w.clock.advance(1000)
  expect(ghSince40().length).toBeGreaterThan(0)
  await w.clock.settle()
})
