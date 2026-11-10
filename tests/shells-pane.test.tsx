import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 120 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

// A plain repo. A Bash or PowerShell call asked into the background answers with a background task id (`bg-1`,
// `bg-2`, ...), a Monitor with a task id (`mon-1`, ...); `ends: true` on a call marks its command as one its caller's
// final response terminates. A tool named in `refused` is denied.
const engine = (on: Parameters<TestBody>[1]) => {
  const refused: string[] = []
  let background = 0
  let monitors = 0
  const clock = mock.clock(on, { now: 1_000_000 })
  // An install from before 0.24.0 (it ran at the defaults), so every switch keeps its old default.
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: null }) as never)
  on('fs.stat', () => ({ value: null }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', (_, e) => {
    if (refused.includes(String(e.tool))) return { deny: 'refused in this test' } as never
    const call = e as { run_in_background?: boolean; ends?: boolean }
    if (e.tool === 'Monitor') return { result: { taskId: 'mon-' + ++monitors, timeoutMs: 300000 }, text: 'ok' } as never
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return { result: {}, text: 'ok' }
    const id = call.run_in_background ? { backgroundTaskId: 'bg-' + ++background, ...(call.ends ? { backgroundEndsWithFinalResponse: true } : {}) } : {}
    return { result: { stdout: '', stderr: '', interrupted: false, ...id }, text: 'ok' } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="nothing" />
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, refused }
}

const notification = (id: string, status = 'completed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`
const eventLine = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<event>a line it printed</event>\n</task-notification>`
const notify = { origin: { kind: 'task-notification' }, wait: false } as const
const agentEnd = (agentId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId: 't-' + agentId, reason: 'answer', agentId }) as never

const start = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const env = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await env.clock.settle()
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'shells' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  return { ...env, ui }
}

test('/ccinformer shells opens Now › Shells, empty at first; `e` and `h` switch between Env and Shells', async ($, on) => {
  const { ui } = await start($, on)
  expect(await ui.find({ type: 'Text', text: '  No background shell is open in this session.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▍ENDED' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'view-shells' }))?.props.hotkey).toBe('h')

  await ui.press({ key: 'view-env' })
  expect(await ui.find({ type: 'Text', text: '▍STARTED HERE' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▍OPEN' })).toBeUndefined()
  await ui.press({ key: 'view-shells' })
  expect(await ui.find({ type: 'Text', text: '▍OPEN' })).toBeDefined()
  await ui.unmount()
})

test('a background Bash or PowerShell call and a Monitor are listed with their command; a foreground or denied call is not', async ($, on) => {
  const { ui, refused } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(await ui.find({ type: 'Text', text: 'npm run build' })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'npm run dev\necho second line', run_in_background: true })
  await $.tool.call({ tool: 'PowerShell', command: 'Start-Sleep 600', run_in_background: true } as never)
  await $.tool.call({ tool: 'Monitor', description: 'the build log', timeout_ms: 300000, command: 'tail -f build.log' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true, agentId: 'helper-1' } as never)
  expect(await ui.find({ type: 'Text', text: 'npm run dev' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Start-Sleep 600' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'tail -f build.log' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm run watch' })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^Bash · / })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^PowerShell · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Monitor · / })).toBeDefined()
  expect(await ui.find({ text: /second line/ })).toBeUndefined()

  // A Monitor on a WebSocket shows its description: the URL, which can carry a token, is never drawn.
  await $.tool.call({ tool: 'Monitor', description: 'the price feed', timeout_ms: 300000, ws: { url: 'wss://feed.example.test/?token=fake' } } as never)
  expect(await ui.find({ type: 'Text', text: 'the price feed' })).toBeDefined()
  expect(await ui.find({ text: /fake/ })).toBeUndefined()

  refused.push('Bash')
  await $.tool.call({ tool: 'Bash', command: 'npm run refused', run_in_background: true })
  expect(await ui.find({ type: 'Text', text: 'npm run refused' })).toBeUndefined()
  await ui.unmount()
})

test('a shell stays open, counting, until its own notification ends it; an event line or another task ends nothing', async ($, on) => {
  const { ui, clock } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.tool.call({ tool: 'Monitor', description: 'the build log', timeout_ms: 300000, command: 'tail -f build.log' } as never)

  await clock.advance(125_000)
  expect(await ui.find({ type: 'Text', text: 'Bash · 2m05s' })).toBeDefined()

  await $.prompt.submit({ text: eventLine('mon-1'), ...notify })
  await $.prompt.submit({ text: notification('bg-9'), ...notify })
  expect(await ui.find({ type: 'Text', text: /^Monitor · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Bash · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▍ENDED' })).toBeUndefined()

  await $.prompt.submit({ text: notification('bg-1'), ...notify })
  expect(await ui.find({ type: 'Text', text: /^Bash · / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▍ENDED' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'completed · ran 2m05s · just now' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm run dev' })).toBeDefined()

  await $.prompt.submit({ text: notification('mon-1', 'failed'), ...notify })
  expect(await ui.find({ type: 'Text', text: /^failed · ran / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  No background shell is open in this session.' })).toBeDefined()
  await ui.unmount()
})

test('a TaskStop that went through ends its row as killed, and that stands; a denied one leaves the row open', async ($, on) => {
  const { ui, refused } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true })

  refused.push('TaskStop')
  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-1' })
  expect(await ui.findAll({ type: 'Text', text: /^Bash · / })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^killed/ })).toBeUndefined()

  refused.length = 0
  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-1' })
  expect(await ui.findAll({ type: 'Text', text: /^Bash · / })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /^killed · ran / })).toBeDefined()

  await $.prompt.submit({ text: notification('bg-1', 'completed'), ...notify })
  expect(await ui.find({ type: 'Text', text: /^killed · ran / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^completed/ })).toBeUndefined()
  await ui.unmount()
})

test("a command that ends with its agent's final response ends when that agent's turn does; other shells stay", async ($, on) => {
  const { ui } = await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'npm run serve', run_in_background: true, ends: true, agentId: 'helper-1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run watch', run_in_background: true, ends: true, agentId: 'helper-2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, agentId: 'helper-1' } as never)
  expect(await ui.findAll({ type: 'Text', text: /^Bash · / })).toHaveLength(3)

  await $.turn.complete(agentEnd('helper-1'))
  expect(await ui.findAll({ type: 'Text', text: /^Bash · / })).toHaveLength(2)
  expect(await ui.findAll({ type: 'Text', text: /^ended · ran / })).toHaveLength(1)
  await ui.unmount()
})
