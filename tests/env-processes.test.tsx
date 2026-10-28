import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// These drive minutes of mocked time, a tick at a time: on a busy machine that takes longer than the default limit
// in real time, which says nothing about the mod.
const CLOCK_HEAVY = { timeoutMs: 20_000 }

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

const PACKS = '/home/test/.claude/ccinformer/packs'
const PACKAGE = JSON.stringify({ devDependencies: { vite: '^5.0.0' }, scripts: { 'dev:staging': 'vite --mode staging', e2e: 'playwright test' } })
const USER_PACK = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] }, "extends": ["node-vite"],
  "environments": [{ "id": "staging", "label": "staging", "tone": "shared", "hostPatterns": ["*.staging.example.test"], "argRegex": "--mode[= ]staging\\\\b" }] }`

// The engine hands file hooks native paths (C:\repo\x on Windows); the files are keyed as /repo/x.
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo on a machine whose process list and free memory the test sets. `calls` counts the process and memory
// queries; `machine` is what they answer.
const engine = (on: Parameters<TestBody>[1], os: 'windows' | 'posix', isRecording = false) => {
  const files: Record<string, string> = {
    '/repo/package.json': PACKAGE,
    '/repo/.env.staging': 'VITE_API_URL=https://api.staging.example.test\nSECRET_KEY=SENTINEL_ENV_456\n',
    [PACKS + '/shop.pack.jsonc']: USER_PACK,
  }
  const calls = { processes: 0, memory: 0 }
  const toasts: string[] = []
  // Every value written to state or the store, as text.
  const kept: string[] = []
  if (isRecording)
    on('state.set', (_, e, next) => {
      kept.push(JSON.stringify(e))
      return next(e)
    })
  // The store, in memory and written down: mock.store would hide what it holds.
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    kept.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }) as never)
  const machine = {
    windows: JSON.stringify({ procs: { pid: 4242, ws: 104857600, m: 'vite-dev', e: 'staging' }, freeKb: 8388608, totalKb: 16777216 }),
    freeKb: 8388608,
    ps: '  4242 102400 node node_modules/.bin/vite --mode staging --api-key SENTINEL_CMD_123\n',
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, os === 'windows' ? { HOME: '/home/test', OS: 'Windows_NT' } : { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: files[posix(e.path)] ?? null }) as never)
  on('fs.stat', (_, e) => ({ value: posix(e.path) in files ? { kind: 'file', size: 1, mtimeMs: 1, isLink: false } : null }) as never)
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    return { value: Object.keys(files).filter(p => p.startsWith(dir)).map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: 1 })) } as never
  })
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const line = argv.join(' ')
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (argv[0] === 'powershell.exe' && line.includes('Win32_Process')) {
      calls.processes += 1
      return out(machine.windows)
    }
    if (argv[0] === 'powershell.exe') {
      calls.memory += 1
      return out(JSON.stringify({ FreePhysicalMemory: machine.freeKb, TotalVisibleMemorySize: 16777216 }))
    }
    if (argv[0] === 'ps') {
      calls.processes += 1
      return out(machine.ps)
    }
    if (line === 'cat /proc/meminfo') {
      calls.memory += 1
      return out(`MemTotal: 16777216 kB\nMemAvailable: ${machine.freeKb} kB\n`)
    }
    return out('')
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'Bash') return { result: {}, text: 'ok' }
    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' }, text: 'ok' } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="nothing" />
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, calls, machine, toasts, kept }
}

test('Now › Env lists the processes the pack knows and the free memory, read every 30 s only while it shows', CLOCK_HEAVY, async ($, on) => {
  const { clock, calls } = engine(on, 'windows')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(calls.processes).toBe(0)

  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'env' })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(calls).toEqual({ processes: 1, memory: 0 })
  expect(await ui.find({ type: 'Text', text: 'Vite dev server' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'pid 4242' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'staging' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '100 MB' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '8.0 GB free' })).toBeDefined()

  // A drawn pane redraws on every tick; the rest needs no drawing.
  await ui.unmount()
  await clock.advance(30_000)
  expect(calls.processes).toBe(2)
  // On Sessions, Env isn't read.
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'sessions' })
  await clock.advance(60_000)
  expect(calls.processes).toBe(2)
})

test('the memory probe runs every 30 s only while a heavy task of this session runs, pane closed or not', CLOCK_HEAVY, async ($, on) => {
  const { clock, calls } = engine(on, 'windows')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(90_000)
  expect(calls.memory).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'npm run e2e', run_in_background: true })
  await clock.advance(60_000)
  expect(calls.memory).toBe(2)

  await $.prompt.submit({ text: '<task-notification><task-id>bg-1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' }, wait: false })
  await clock.advance(90_000)
  expect(calls.memory).toBe(2)
})

test('low memory toasts once, and again only after it recovered', CLOCK_HEAVY, async ($, on) => {
  const { clock, machine, toasts } = engine(on, 'windows')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run e2e', run_in_background: true })
  machine.freeKb = 900 * 1024
  await clock.advance(60_000)
  expect(toasts).toEqual(['Memory is low: 0.9 GB free'])
  machine.freeKb = 4096 * 1024
  await clock.advance(30_000)
  machine.freeKb = 800 * 1024
  await clock.advance(30_000)
  expect(toasts).toEqual(['Memory is low: 0.9 GB free', 'Memory is low: 0.8 GB free'])
})

test('a secret in a command line or an env file reaches neither state nor the store', async ($, on) => {
  const { clock, kept } = engine(on, 'posix', true)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'env' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev:staging', run_in_background: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'pid 4242' })).toBeDefined()
  expect(await ui.find({ text: /SENTINEL/ })).toBeUndefined()
  await ui.unmount()

  // The writes happened (the task's label, the process's pid), and none carried a secret.
  expect(kept.join('\n')).toMatch(/npm run dev:staging/)
  expect(kept.join('\n')).toMatch(/"pid":4242/)
  expect(kept.join('\n')).not.toMatch(/SENTINEL/)
})
