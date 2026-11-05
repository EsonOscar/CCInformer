import { describe, expect, test } from 'claude-code/testing'

import { expandParts } from '../hooks/env/classify'
import {
  answerOf,
  appended,
  askFor,
  couldApply,
  eventLine,
  eventScript,
  gateCall,
  gateRulesOf,
  latestSegment,
  ledgerName,
  pickGate,
  ruleMatches,
  sessionKey,
} from '../hooks/gates/match'
import type { GateRule } from '../hooks/gates/match'
import { mergeLayers } from '../hooks/packs/merge'
import type { ApprovalRule, PackManifest, Tone } from '../hooks/packs/types'

const SCRIPTS = { 'db:migrate:staging': 'node tools/migrate.mjs --target staging', 'db:check:prod': 'node tools/check.mjs prod', test: 'vitest run' }
const rule = (id: string, fields: Partial<ApprovalRule>): ApprovalRule => ({ id, tool: 'Bash', label: id, scope: 'once', ...fields })
const gate = (env: string, tone: Tone, r: ApprovalRule): GateRule => ({ env, envLabel: env, tone, rule: r })
const shell = (command: string, tool = 'Bash') => gateCall(tool, { command }, SCRIPTS, '/repo')
const MIGRATE = rule('migrate', { commandRegex: '^npm run db:migrate:staging\\b' })

describe('what a rule reads', () => {
  test('a shell command is split into its commands, each with a normalised runner line and the script it runs', async () => {
    expect(expandParts('FOO=1 npm.cmd --prefix api run -s db:migrate:staging', SCRIPTS).map(l => l.text)).toEqual([
      'FOO=1 npm.cmd --prefix api run -s db:migrate:staging',
      'npm run db:migrate:staging',
      'node tools/migrate.mjs --target staging',
    ])
    expect(expandParts('echo a & npm run test\nnpx dotenv -e .env.staging -- yarn db:check:prod', SCRIPTS).map(l => l.text)).toEqual([
      'echo a',
      'npm run test',
      'npm run test',
      'vitest run',
      'npx dotenv -e .env.staging -- yarn db:check:prod',
      'yarn run db:check:prod',
      'node tools/check.mjs prod',
    ])
    // Every line keeps the label of the command it came from.
    expect(expandParts('npm run db:check:prod', SCRIPTS).map(l => l.label)).toEqual(['npm run db:check:prod', 'npm run db:check:prod', 'npm run db:check:prod'])
  })

  test('an anchored command rule meets every way of running the script, and never a command that only names it', async () => {
    for (const command of [
      'npm run db:migrate:staging',
      'FOO=1 npm run db:migrate:staging',
      'npm.cmd run db:migrate:staging',
      '& npm run db:migrate:staging',
      'npm -s run db:migrate:staging',
      'npx dotenv -e .env -- npm run db:migrate:staging',
      'npm run build && npm run db:migrate:staging',
      'npm run build\nnpm run db:migrate:staging',
      'npm run build & npm run db:migrate:staging',
    ])
      expect([command, ruleMatches(MIGRATE, shell(command))]).toEqual([command, true])
    expect(ruleMatches(MIGRATE, shell('git commit -m "run npm run db:migrate:staging later"'))).toBe(false)
    expect(ruleMatches(MIGRATE, shell('grep -r db:migrate:staging .'))).toBe(false)
    // A rule on the script's body meets the body run directly.
    expect(ruleMatches(rule('body', { commandRegex: '--target staging\\b' }), shell('node tools/migrate.mjs --target staging'))).toBe(true)
  })

  test('a Bash rule meets the same command through PowerShell and Monitor, and an empty command never matches', async () => {
    expect(ruleMatches(MIGRATE, shell('npm run db:migrate:staging', 'PowerShell'))).toBe(true)
    expect(ruleMatches(MIGRATE, shell('npm run db:migrate:staging', 'Monitor'))).toBe(true)
    expect(ruleMatches(rule('any', { tool: '*', commandRegex: '.*' }), gateCall('Read', { file_path: '/repo/a.ts' }, {}, '/repo'))).toBe(false)
    expect(ruleMatches(rule('any', { commandRegex: '.*' }), shell(''))).toBe(false)
  })

  test("an MCP rule reads the input as key=value lines, on any server's name, without case", async () => {
    const sql = rule('sql', { tool: 'mcp__*__execute_sql', inputRegex: '^project_id=stagingref$' })
    const call = (tool: string, input: Record<string, unknown>) => gateCall(tool, input, {}, '/repo')
    expect(ruleMatches(sql, call('mcp__acmedb__execute_sql', { project_id: 'stagingref', query: 'delete from t' }))).toBe(true)
    expect(ruleMatches(sql, call('mcp__0a1b2c3d-e4f5-4a6b-8c9d-0e1f2a3b4c5d__Execute_SQL', { project_id: 'stagingref' }))).toBe(true)
    expect(ruleMatches(sql, call('mcp__acmedb__execute_sql', { project_id: 'prodref' }))).toBe(false)
    // A value can't forge a line of its own.
    expect(ruleMatches(sql, call('mcp__acmedb__execute_sql', { project_id: 'prodref', query: 'select 1\nproject_id=stagingref' }))).toBe(false)
    // The engine's own keys aren't input.
    expect(call('mcp__acmedb__x', { tool: 'y', tool_use_id: 'z', consent: 'yes', a: 1, b: { c: 2 } }).inputText).toBe('a=1')
  })

  test('a path rule reads the repo path: .. and backslashes resolved, Windows without case, nothing outside the repo', async () => {
    const migrations = rule('migrations', { tool: 'Edit', pathGlob: 'db/migrations/**' })
    const edit = (file: string, root = '/repo') => gateCall('Edit', { file_path: file }, {}, root)
    expect(ruleMatches(migrations, edit('/repo/src/../db/migrations/001.sql'))).toBe(true)
    expect(ruleMatches(migrations, edit('C:\\Repo\\DB\\Migrations\\001.sql', 'c:/repo'))).toBe(true)
    expect(ruleMatches(migrations, edit('/elsewhere/db/migrations/001.sql'))).toBe(false)
    expect(ruleMatches(rule('all', { tool: 'Edit', pathGlob: '**' }), gateCall('Edit', {}, {}, '/repo'))).toBe(false)
  })

  test('a rule could apply only to a call that has what it reads', async () => {
    expect(couldApply(MIGRATE, 'Read', { file_path: '/repo/a' })).toBe(false)
    expect(couldApply(MIGRATE, 'PowerShell', { command: 'ls' })).toBe(true)
    expect(couldApply(rule('p', { tool: '*', pathGlob: 'db/**' }), 'Edit', { old_string: 'x' })).toBe(false)
    expect(couldApply(rule('m', { tool: 'mcp__*__trigger_deploy' }), 'AskUserQuestion', {})).toBe(false)
  })
})

describe('which rule decides', () => {
  const ask = gate('staging', 'shared', rule('ask', { commandRegex: 'migrate' }))
  const log = gate('staging', 'shared', rule('log', { commandRegex: 'migrate', mode: 'log' }))
  const prod = gate('prod', 'prod', rule('prod', { commandRegex: 'migrate' }))
  const session = gate('staging', 'shared', rule('perf', { commandRegex: 'migrate', scope: 'session' }))
  const call = shell('npm run db:migrate:staging')

  test('asking beats logging, prod beats shared, the first on a tie', async () => {
    expect(pickGate([log, ask], call, new Set())?.gate).toBe(ask)
    expect(pickGate([ask, prod], call, new Set())?.gate).toBe(prod)
    expect(pickGate([log], call, new Set())?.gate).toBe(log)
    expect(pickGate([ask], shell('npm test'), new Set())).toBeNull()
  })

  test("a session approval doesn't hide a once rule, nor hold once its rule changes", async () => {
    const approved = new Set([sessionKey(session)])
    expect(pickGate([session, ask], call, approved)).toEqual({ gate: ask, isSessionApproved: false })
    expect(pickGate([session], call, approved)).toEqual({ gate: session, isSessionApproved: true })
    const widened = gate('staging', 'shared', { ...session.rule, commandRegex: 'migr' })
    expect(pickGate([widened], call, approved)?.isSessionApproved).toBe(false)
    const once = gate('staging', 'shared', { ...session.rule, scope: 'once' })
    expect(pickGate([once], call, new Set([sessionKey(once)]))?.isSessionApproved).toBe(false)
  })

  test('a built-in rule the user pack switches off is gone; the built-in alone keeps it', async () => {
    const builtin: PackManifest = {
      schema: 1,
      id: 'base',
      version: '1',
      environments: [{ id: 'prod', label: 'production', tone: 'prod', approvals: [rule('x', { commandRegex: 'migrate' })] }],
    }
    const user: PackManifest = { schema: 1, id: 'mine', version: '1', disable: ['x'] }
    const off = gateRulesOf(mergeLayers([{ layer: 'built-in', pack: builtin }, { layer: 'user', pack: user }]).pack, '/repo', '')
    expect(pickGate(off.rules, call, new Set())).toBeNull()
    const on = gateRulesOf(mergeLayers([{ layer: 'built-in', pack: builtin }]).pack, '/repo', '')
    expect(pickGate(on.rules, call, new Set())?.gate.rule.id).toBe('x')
  })
})

describe('the question and the answer', () => {
  test('the session option comes only with a session rule; the question shows the whole command', async () => {
    const once = gate('prod', 'prod', rule('p', { commandRegex: 'x', label: 'prod writes' }))
    const ask = askFor(once, shell('npm run build && npm run db:migrate:staging'))
    expect(ask.options).toEqual(['Deny', 'Approve once'])
    expect(ask.header).toBe('CCInformer')
    expect(ask.question).toBe('Let Claude run this on prod (prod writes)? npm run build && npm run db:migrate:staging')
    expect(askFor(gate('s', 'shared', rule('s', { scope: 'session' })), shell('x')).options).toEqual(['Deny', 'Approve once', 'Approve for this session'])
    expect(askFor(once, shell('x'.repeat(400))).question.endsWith('x…')).toBe(true)
  })

  test('only an exact label approves; free text is "other", nothing or blank is "no answer"', async () => {
    const options = ['Deny', 'Approve once']
    expect(answerOf('Approve once', options)).toBe('approved')
    expect(answerOf('Deny', options)).toBe('denied')
    expect(answerOf('approve once', options)).toBe('other')
    expect(answerOf('Approve for this session', options)).toBe('other')
    expect(answerOf('Approve for this session', [...options, 'Approve for this session'])).toBe('approved-session')
    expect(answerOf(null, options)).toBe('no answer')
    expect(answerOf('  ', options)).toBe('no answer')
  })
})

describe('the log', () => {
  const SENTINEL = 'sk-SENTINEL-1234'

  test("an event names the script that matched, never the command, an argument, an input value or a typed answer", async () => {
    const r = rule('migrate', { commandRegex: '--target staging' })
    const call = shell(`TOKEN=${SENTINEL} npm run build && npm run db:migrate:staging -- --key ${SENTINEL}`)
    expect(eventScript(call, r)).toBe('npm run db:migrate:staging')
    expect(eventScript(shell(`/home/someone/bin/push.sh --target staging ${SENTINEL}`), r)).toBe('push.sh')
    expect(eventScript(shell(`"C:\\Users\\someone\\x y.exe" --target staging`), r)).toBeUndefined()
    const line = eventLine({ t: 1, env: 'staging', rule: 'migrate', tool: 'Bash', script: eventScript(call, r), cwd: '/repo', head: 'feat/x', answer: 'other' })
    expect(line).toBe('{"t":1,"env":"staging","rule":"migrate","tool":"Bash","script":"npm run db:migrate:staging","cwd":"/repo","head":"feat/x","answer":"other"}\n')
    expect(line.includes(SENTINEL)).toBe(false)
    // The question shows it; only the log never holds it.
    expect(askFor(gate('staging', 'shared', r), call).question.includes(SENTINEL)).toBe(true)
    const mcp = gateCall('mcp__acmedb__execute_sql', { project_id: 'p', query: SENTINEL }, {}, '/repo')
    expect(eventLine({ t: 1, env: 'e', rule: 'r', tool: mcp.tool, script: eventScript(mcp, rule('r', { tool: 'mcp__*' })), cwd: '/repo', answer: 'approved' }).includes(SENTINEL)).toBe(false)
  })

  test('a session writes one file, a new segment past the limit', async () => {
    expect(ledgerName('abc', 0)).toBe('abc.jsonl')
    expect(ledgerName('abc', 2)).toBe('abc-2.jsonl')
    expect(latestSegment(['abc.jsonl', 'abc-1.jsonl', 'abc-3.jsonl', 'abcd-9.jsonl', 'other.jsonl'], 'abc')).toBe(3)
    expect(latestSegment([], 'abc')).toBe(0)
    expect(appended({ segment: 0, text: 'aaaa\n' }, 'bb\n', 7)).toEqual({ segment: 1, text: 'bb\n' })
    expect(appended({ segment: 0, text: 'aaaa\n' }, 'bb\n', 8)).toEqual({ segment: 0, text: 'aaaa\nbb\n' })
    expect(appended({ segment: 0, text: 'aaaa\n' }, 'bb\n', 100)).toEqual({ segment: 0, text: 'aaaa\nbb\n' })
    expect(appended({ segment: 0, text: '' }, 'x'.repeat(20) + '\n', 10)).toEqual({ segment: 0, text: 'x'.repeat(20) + '\n' })
  })
})
