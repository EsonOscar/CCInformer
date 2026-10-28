import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const BAND = {
  plugin: 'ccinformer',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PACKS = '/home/test/.claude/ccinformer/packs'
const PACKAGE = JSON.stringify({ devDependencies: { vite: '^5.0.0' }, scripts: { dev: 'vite', 'dev:staging': 'vite --mode staging', 'dev:prod': 'vite --mode production' } })
const USER_PACK = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] }, "extends": ["node-vite"],
  "environments": [
    { "id": "staging", "label": "staging", "tone": "shared", "hostPatterns": ["*.staging.example.test"] },
    { "id": "prod", "label": "production", "tone": "prod", "hostPatterns": ["api.example.test"] }
  ] }`

// The engine hands file hooks native paths (C:\repo\x on Windows); the files are keyed as /repo/x.
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A Vite repo with staging and production env files. A Bash call answers after `ms` on the mocked clock, with a
// background task id when it ran in the background. `statuses` collects the status line's text.
const engine = (on: Parameters<TestBody>[1], ms = 0) => {
  const files: Record<string, string> = {
    '/repo/package.json': PACKAGE,
    '/repo/.env.staging': 'VITE_API_URL=https://api.staging.example.test\n',
    '/repo/.env.production': 'VITE_API_URL=https://api.example.test\n',
    [PACKS + '/shop.pack.jsonc']: USER_PACK,
  }
  const statuses: (string | undefined)[] = []
  let background = 0
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
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
    const line = (e as { argv: string[] }).argv.join(' ')
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    return out('')
  })
  on('tool.call', async (_, e) => {
    if (e.tool !== 'Bash') return { result: {}, text: 'ok' }
    const isBackground = (e as { run_in_background?: boolean }).run_in_background
    if (!isBackground) await clock.sleep(ms)
    background += 1
    return { result: { stdout: '', stderr: '', interrupted: false, ...(isBackground ? { backgroundTaskId: 'bg-' + background } : {}) }, text: 'ok' } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="nothing" />
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, statuses }
}

const notification = (id: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`

test('npm run dev:staging in the background shows STAGING above the prompt until its task ends', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ text: /STAGING/ })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'npm run dev:staging', run_in_background: true })
  expect(await band.find({ type: 'Text', text: '⚠ STAGING' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'npm run dev:staging' })).toBeDefined()

  // Another task's end leaves it; its own clears it.
  await $.prompt.submit({ text: notification('bg-9'), origin: { kind: 'task-notification' }, wait: false })
  expect(await band.find({ type: 'Text', text: '⚠ STAGING' })).toBeDefined()
  await $.prompt.submit({ text: notification('bg-1'), origin: { kind: 'task-notification' }, wait: false })
  expect(await band.find({ type: 'Text', text: '⚠ STAGING' })).toBeUndefined()
  await band.unmount()
})

test('a foreground command shows while it runs and clears when its call returns', async ($, on) => {
  const { clock } = engine(on, 5000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  const call = $.tool.call({ tool: 'Bash', command: 'npm run dev:staging' })
  await clock.advance(1000)
  expect(await band.find({ type: 'Text', text: '⚠ STAGING' })).toBeDefined()
  await clock.advance(4000)
  await call
  expect(await band.find({ type: 'Text', text: '⚠ STAGING' })).toBeUndefined()
  await band.unmount()
})

test('the band gives way to a survey, and a plain dev server shows nothing', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  const plain = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await plain.find({ text: /⚠/ })).toBeUndefined()
  await plain.unmount()

  await $.tool.call({ tool: 'Bash', command: 'npm run dev:staging', run_in_background: true })
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect(await survey.find({ text: /STAGING/ })).toBeUndefined()
  await survey.unmount()
})

test('production goes first and onto the status line; TaskStop and × clear rows', async ($, on) => {
  const { clock, statuses } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await $.tool.call({ tool: 'Bash', command: 'npm run dev:staging', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev:prod', run_in_background: true })
  expect(await band.find({ type: 'Text', text: '⚠ PRODUCTION' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '+1 more' })).toBeDefined()
  expect(statuses.at(-1)).toBe('⚠ PROD · npm run dev:prod')

  await $.tool.call({ tool: 'TaskStop', task_id: 'bg-2' })
  expect(await band.find({ type: 'Text', text: '⚠ STAGING' })).toBeDefined()
  expect(statuses.at(-1)).toBeUndefined()

  await band.press({ key: 'band-dismiss' })
  expect(await band.find({ text: /⚠/ })).toBeUndefined()
  await band.unmount()
})
