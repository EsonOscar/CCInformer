import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Approval gates in a session: an invented shop whose user pack lists rules for staging and production.
const PACKS = '/home/test/.claude/ccinformer/packs'
const LEDGER_DIR = '/home/test/.claude/ccinformer/approvals/-repo-git'
const LEDGER = LEDGER_DIR + '/self-session-id.jsonl'
const SENTINEL = 'sk-SENTINEL-4242'
const PACKAGE = JSON.stringify({ scripts: { 'db:migrate:staging': 'node tools/migrate.mjs', 'db:check:staging': 'node tools/check.mjs', test: 'vitest run' } })
const MIGRATE = { id: 'migrate', tool: 'Bash', commandRegex: '^npm run db:migrate:staging\\b', label: 'staging migration', scope: 'once' }
const USER_PACK = JSON.stringify({
  schema: 1,
  id: 'acme-shop',
  version: '1',
  match: { remote: ['github.com/acme/*'] },
  environments: [
    {
      id: 'staging',
      label: 'staging',
      tone: 'shared',
      approvals: [
        MIGRATE,
        { id: 'db-check', tool: 'Bash', commandRegex: '^npm run db:check:staging\\b', label: 'staging check', mode: 'log', scope: 'once' },
        { id: 'load', tool: 'Bash', commandRegex: '^node load\\.mjs\\b', label: 'load run', scope: 'session' },
        { id: 'sql', tool: 'mcp__*__execute_sql', inputRegex: '^project_id=stagingref$', label: 'staging SQL', scope: 'once' },
      ],
    },
    { id: 'prod', label: 'production', tone: 'prod', approvals: [{ id: 'deploy', tool: 'mcp__*__trigger_deploy', label: 'deploy', scope: 'once' }] },
  ],
})
// What the person answers, in order; DISMISS closes the question unanswered.
const DISMISS = '<dismiss>'

const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

type Options = { store?: Record<string, unknown>; packs?: Record<string, string>; hasRemote?: boolean; failTrust?: boolean }

const engine = (on: Parameters<TestBody>[1], opts: Options = {}) => {
  const files: Record<string, string> = {
    '/repo/package.json': PACKAGE,
    ...Object.fromEntries(Object.entries(opts.packs ?? { 'shop.pack.jsonc': USER_PACK }).map(([name, text]) => [PACKS + '/' + name, text])),
  }
  const answers: string[] = []
  const asked: { question: string; options: string[] }[] = []
  const order: string[] = []
  const toasts: string[] = []
  // breakState: state hands the gate a corrupt value once, so its own code throws.
  // failTool: the tool itself throws once it runs, once.
  const flags = { breakState: false, failTool: false, holdWrite: null as Promise<void> | null }
  // Registered first, so it stands outside the store mock.
  if (opts.failTrust)
    on('store.get', { key: /^trust:/ }, () => {
      throw new Error('store unreadable')
    })
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, opts.store ?? { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('state.get', { key: 'sessionApprovals' }, async (_, e, next) => {
    const result = await next(e)
    if (!flags.breakState || !result.value) return result
    flags.breakState = false
    return { value: { ...result.value, value: 5 } }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => ({ value: files[posix(e.path)] ?? null }) as never)
  on('fs.write', async (_, e) => {
    if (flags.holdWrite) await flags.holdWrite
    order.push('write')
    files[posix(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_, e) => ({ value: posix(e.path) in files ? { kind: 'file', size: 1, mtimeMs: 1, isLink: false } : null }) as never)
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    if (!names.length) throw new Error('ENOENT: ' + dir)
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: 1 })) } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return opts.hasRemote === false ? out('', 1) : out('git@github.com:acme/shop.git\n')
    return out('')
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string; options: (string | { label: string })[] }[] }).questions[0]!
      asked.push({ question: q.question, options: q.options.map(o => (typeof o === 'string' ? o : o.label)) })
      const answer = answers.shift()
      if (answer === undefined || answer === DISMISS) throw new Error('dismissed')
      return { result: { questions: [], answers: { [q.question]: answer } }, text: answer } as never
    }
    order.push('ran:' + String(e.tool))
    if (flags.failTool) {
      flags.failTool = false
      throw new Error('the tool broke')
    }
    return { result: {}, text: 'ok' }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'self-session-id' }))
  const events = () => (files[LEDGER] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  return { clock, files, answers, asked, order, toasts, flags, events }
}

const start = async ($: Parameters<TestBody>[0], clock: { settle: () => Promise<void> }) => {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
}
const isDenied = (result: unknown) => typeof result === 'object' && result !== null && 'deny' in result && !!(result as { deny?: unknown }).deny
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool: 'Bash', command, ...extra }) as never

test('a named write is asked first and logged before it runs; only an exact Approve lets it run', async ($, on) => {
  const { clock, answers, asked, order, events } = engine(on)
  await start($, clock)

  answers.push('Approve once')
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(false)
  expect(asked[0]).toEqual({ question: 'Let Claude run this on staging (staging migration)? npm run db:migrate:staging', options: ['Deny', 'Approve once'] })
  expect(order).toEqual(['write', 'ran:Bash'])
  expect(events()).toEqual([{ t: 1_000_000, env: 'staging', rule: 'migrate', tool: 'Bash', script: 'npm run db:migrate:staging', cwd: '/repo', answer: 'approved' }])

  // Deny, free text and a dismissal each refuse it, and each is logged once.
  answers.push('Deny', 'yes but only the first table', DISMISS)
  for (let i = 0; i < 3; i++) expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(true)
  expect(events().map(e => e.answer)).toEqual(['approved', 'denied', 'other', 'no answer'])
  expect(order.filter(o => o === 'ran:Bash').length).toBe(1)
})

test('a gate that fails refuses the call and logs it; a failure after the call ran refuses nothing', async ($, on) => {
  const { clock, flags, order, events } = engine(on)
  await start($, clock)
  flags.breakState = true
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(true)
  await clock.settle()
  expect(events().map(e => e.answer)).toEqual(['error'])
  expect(order.includes('ran:Bash')).toBe(false)

  // A log rule's call ran and then failed beneath the gate: it ran once, and nothing calls it denied.
  flags.failTool = true
  const result = await $.tool.call(bash('npm run db:check:staging')).catch((err: unknown) => ({ error: String(err) }))
  expect(isDenied(result)).toBe(false)
  expect(order.filter(o => o === 'ran:Bash').length).toBe(1)
  expect(events().map(e => e.answer)).toEqual(['error', 'logged'])
})

test('a session approval comes only with a session rule, holds for the rest of the session, and not past /clear', async ($, on) => {
  const { clock, answers, asked, events } = engine(on)
  await start($, clock)
  answers.push('Approve for this session')
  await $.tool.call(bash('node load.mjs --scenario cart'))
  expect(asked[0]!.options).toEqual(['Deny', 'Approve once', 'Approve for this session'])
  await $.tool.call(bash('node load.mjs --scenario search'))
  expect(asked.length).toBe(1)
  expect(events().map(e => e.answer)).toEqual(['approved-session', 'session'])

  await $.session.end({ reason: 'clear', sessionId: 'self-session-id' } as never)
  answers.push('Deny')
  expect(isDenied(await $.tool.call(bash('node load.mjs')))).toBe(true)
  expect(asked.length).toBe(2)
})

test('an MCP write to staging is asked, on whatever the server is called; a read of production is not', async ($, on) => {
  const { clock, answers, asked, events } = engine(on)
  await start($, clock)
  answers.push('Approve once', 'Approve once')
  await $.tool.call({ tool: 'mcp__acmedb__execute_sql', project_id: 'stagingref', query: `select '${SENTINEL}'` } as never)
  await $.tool.call({ tool: 'mcp__0a1b2c3d-e4f5__trigger_deploy', serviceId: 'srv-1' } as never)
  await $.tool.call({ tool: 'mcp__acmedb__execute_sql', project_id: 'otherref', query: 'select 1' } as never)
  expect(asked.map(a => a.question)).toEqual([
    `Let Claude run this on staging (staging SQL)? execute_sql: project_id=stagingref, query=select '${SENTINEL}'`,
    'Let Claude run this on production (deploy)? trigger_deploy: serviceId=srv-1',
  ])
  expect(events().map(e => [e.env, e.rule, e.answer])).toEqual([
    ['staging', 'sql', 'approved'],
    ['prod', 'deploy', 'approved'],
  ])
})

test('the question shows what runs; the log never holds a command, a value or a typed answer', async ($, on) => {
  const { clock, answers, asked, files } = engine(on)
  await start($, clock)
  answers.push('Approve once', `only with ${SENTINEL}`)
  await $.tool.call(bash(`TOKEN=${SENTINEL} npm run db:migrate:staging -- --key ${SENTINEL}`))
  await $.tool.call({ tool: 'mcp__acmedb__execute_sql', project_id: 'stagingref', query: SENTINEL } as never)
  expect(asked.every(a => a.question.includes(SENTINEL))).toBe(true)
  expect(files[LEDGER]!.includes(SENTINEL)).toBe(false)
})

test('a log rule runs with no question and writes one event; AskUserQuestion and routine work are never gated', async ($, on) => {
  const { clock, answers, asked, order, events } = engine(on)
  await start($, clock)
  await $.tool.call(bash('npm run db:check:staging'))
  expect(asked).toEqual([])
  expect(events().map(e => [e.rule, e.answer, e.script])).toEqual([['db-check', 'logged', 'npm run db:check:staging']])

  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call(bash('npm test'))
  await $.tool.call(bash('git status --short'))
  await $.tool.call(bash('git commit -m "run npm run db:migrate:staging later"'))
  answers.push('a')
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which?', header: 'q', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }] } as never)
  expect(asked.map(a => a.question)).toEqual(['Which?'])
  expect(events().length).toBe(1)
  expect(order.filter(o => o.startsWith('ran:'))).toEqual(['ran:Bash', 'ran:Edit', 'ran:Bash', 'ran:Bash', 'ran:Bash'])
})

test('subagents, PowerShell and Monitor meet the same rules, and two calls at once are each asked and logged', async ($, on) => {
  const { clock, answers, asked, events } = engine(on)
  await start($, clock)
  answers.push('Deny', 'Deny', 'Deny')
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging', { agentId: 'helper-1' })))).toBe(true)
  expect(isDenied(await $.tool.call({ tool: 'PowerShell', command: 'npm.cmd run db:migrate:staging' } as never))).toBe(true)
  expect(isDenied(await $.tool.call({ tool: 'Monitor', command: 'FOO=1 npm run db:migrate:staging', description: 'x', timeout_ms: 1000 } as never))).toBe(true)
  expect(asked.length).toBe(3)

  answers.push('Approve once', 'Deny')
  const both = await Promise.all([$.tool.call(bash('npm run db:migrate:staging')), $.tool.call(bash('npm run db:migrate:staging'))])
  expect(both.map(isDenied).sort()).toEqual([false, true])
  expect(asked.length).toBe(5)
  expect(events().length).toBe(5)
})

test('with nothing stored the gates are on; switched off, nothing is asked or logged', async ($, on) => {
  const fresh = engine(on, { store: {} })
  await start($, fresh.clock)
  fresh.answers.push('Deny')
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(true)
  expect(fresh.events().length).toBe(1)
})

test('switched off in Debug › Settings, a named write runs with no question and no event', async ($, on) => {
  const off = engine(on, { store: { permissions: { base: 'defaults', set: { 'safety.approvalGates': false } } } })
  await start($, off.clock)
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(false)
  expect([off.asked.length, off.events().length]).toEqual([0, 0])
})

// Rules a session wrote to state before a hot reload: the module starts over, state keeps them.
const seedRules = (on: Parameters<TestBody>[1]) => {
  const rules = { root: '/repo', ledgerDir: LEDGER_DIR, rules: [{ env: 'staging', envLabel: 'staging', tone: 'shared', rule: MIGRATE }] }
  let isSeeded = true
  on('state.get', async (_, e, next) => {
    const result = await next(e)
    return e.key === 'gateRules' && isSeeded && result.value ? { value: { ...result.value, value: rules } } : result
  })
  on('state.set', (_, e, next) => {
    if (e.key === 'gateRules') isSeeded = false
    return next(e)
  })
}

test('after a reload the rules in state still gate, even when the remote could not be read', async ($, on) => {
  const { clock, answers, asked } = engine(on, { packs: {}, hasRemote: false })
  seedRules(on)
  await start($, clock)
  answers.push('Deny')
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(true)
  expect(asked.length).toBe(1)
})

test("a pack that can't be read at start says so, still gates with the rules it had, and lets routine work run", async ($, on) => {
  const { clock, answers, toasts, order } = engine(on, { failTrust: true })
  seedRules(on)
  await start($, clock)
  expect(toasts).toEqual(["CCInformer couldn't read this repo's pack, so its approval rules don't apply yet (Debug › Pack)."])
  await $.tool.call({ tool: 'Read', file_path: '/repo/package.json' } as never)
  answers.push('Deny')
  expect(isDenied(await $.tool.call(bash('npm run db:migrate:staging')))).toBe(true)
  expect(order).toContain('ran:Read')
})

test('a refused user pack is said once at the first read', async ($, on) => {
  const { clock, toasts } = engine(on, { packs: { 'shop.pack.jsonc': '{ "schema": 1, ' } })
  await start($, clock)
  await $.tool.call({ tool: 'Read', file_path: '/repo/package.json' } as never)
  await clock.settle()
  expect(toasts).toEqual(["A user pack was refused (shop.pack.jsonc), so its approval rules don't apply. Debug › Pack says why."])
})

test('a gate that fails while a log write waits its turn still refuses at once', async ($, on) => {
  const { clock, answers, flags, order } = engine(on)
  await start($, clock)
  let release = () => {}
  flags.holdWrite = new Promise<void>(resolve => (release = resolve))
  answers.push('Approve once')
  const first = $.tool.call(bash('npm run db:migrate:staging'))
  await clock.settle()
  flags.breakState = true
  const second = await $.tool.call(bash('npm run db:check:staging'))
  expect(isDenied(second)).toBe(true)
  expect(order.includes('ran:Bash')).toBe(false)
  flags.holdWrite = null
  release()
  expect(isDenied(await first)).toBe(false)
  await clock.settle()
})
