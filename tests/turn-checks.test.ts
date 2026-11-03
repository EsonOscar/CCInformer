import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { createChecks } from '../hooks/checks/run'
import type { CheckDeps } from '../hooks/checks/run'
import { OUTPUT_NOT_WRITTEN } from '../hooks/checks/tools'
import type { CheckSpec, ResolvedPack } from '../hooks/packs/types'
import type { CheckRun, Finding, PackReport } from '../types'

// The checks engine alone, with a hand-built `$` (the repo's files, a clock) and fake deps. A user pack always counts
// as trusted and only a user pack can name a command check, so the trust gate, the per-check queues and a
// whole-project run's clearing are shown here rather than through the pane.
const ROOT = '/repo'
const CFG = '/home/me/.claude/ccinformer'
const PATTERN = '^(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<severity>error|warning|note): (?<message>.*)$'
const GCC: CheckSpec = { id: 'gcc', label: 'gcc', on: ['**/*.c'], analyzer: 'problem-matcher', cost: 'turn', class: 'ci', bin: ['gcc', '-fsyntax-only', '{files}'], options: { pattern: PATTERN } }
// A whole-project command: no {files}.
const MAKE: CheckSpec = { id: 'make', label: 'make check', on: ['**/*.c'], analyzer: 'problem-matcher', cost: 'turn', class: 'ci', bin: ['make', 'check'], options: { pattern: PATTERN } }
const DOTNET: CheckSpec = { id: 'dotnet', label: 'dotnet build', on: ['**/*.cs'], analyzer: 'sarif', cost: 'turn', class: 'ci', bin: ['dotnet', 'build', '-p:ErrorLog={output}%2Cversion=2.1'] }
const ERROR_LINE = 'src/a.c:1:1: error: boom\n'

type Ran = { exitCode: number; stdout: string; stderr: string }
type Script = (argv: string[]) => Ran

const engine = (files: Record<string, string>, opts: { isTrusted?: boolean; failWrite?: string } = {}) => {
  const writes: [string, string][] = []
  let now = 1000
  const $ = {
    fs: {
      stat: async (p: string) => (p in files ? { kind: 'file', size: files[p]!.length, mtimeMs: 1 } : null),
      exists: async (p: string) => p in files,
      read: async (p: string) => {
        if (!(p in files)) throw new Error('missing')
        return files[p]
      },
      write: async (p: string, text: string) => {
        if (opts.failWrite && p.startsWith(opts.failWrite)) throw new Error('EACCES')
        writes.push([p, text])
        files[p] = text
      },
    },
    clock: { now: async () => (now += 1) },
  } as unknown as EngineInterface
  const runs: CheckRun[] = []
  const saved: { check: string; files: string[]; findings: Finding[] }[] = []
  const commands: string[][] = []
  let script: Script = () => ({ exitCode: 0, stdout: '', stderr: '' })
  let isTrusted = opts.isTrusted ?? false
  const pack: ResolvedPack = { id: 'own', processes: [], environments: [], checks: [], budgets: [], noise: [] }
  const report = () => ({ root: ROOT, trust: { isTrusted, by: isTrusted ? 'you' : '', at: 0 } }) as unknown as PackReport
  const deps: CheckDeps = {
    cwd: ROOT,
    emptySuppressions: CFG + '/empty-suppressions.json',
    outputDir: CFG + '/output',
    sessionId: 's1',
    heavy: async argv => {
      commands.push(argv)
      return script(argv)
    },
    pack: async () => pack,
    report,
    reload: async () => report(),
    saveFindings: async (check, list, findings) => {
      saved.push({ check, files: list, findings })
    },
    saveRun: async run => {
      runs.push(run)
    },
    dismissed: async () => [],
    findingFiles: async () => [],
    // The trust question is off, so an untrusted repo simply waits.
    may: id => id !== 'ask.repoTrust',
  }
  const checks = createChecks($, deps)
  const lastRun = (check: string) => runs.filter(r => r.check === check).at(-1)
  return { checks, pack, runs, saved, commands, writes, files, lastRun, setScript: (s: Script) => (script = s), trust: (v: boolean) => (isTrusted = v) }
}

test("without trust and with the question off nothing runs and the run waits; once trusted, the waiting files run at the next turn's end", async () => {
  const e = engine({ '/repo/src/a.c': 'int x;' })
  e.pack.checks.push(GCC)
  await e.checks.checkFile('/repo/src/a.c')
  await e.checks.runChecks()
  expect(e.commands).toEqual([])
  expect(e.runs.map(r => [r.check, r.waitsForTrust, r.files])).toEqual([['gcc', true, 1]])
  e.trust(true)
  e.setScript(() => ({ exitCode: 1, stdout: '', stderr: ERROR_LINE }))
  await e.checks.runChecks()
  expect(e.commands).toEqual([['gcc', '-fsyntax-only', 'src/a.c']])
  expect(e.saved.map(s => [s.check, s.files, s.findings.map(f => [f.file, f.line, f.severity])])).toEqual([['gcc', ['src/a.c'], [['src/a.c', 1, 'error']]]])
  expect(e.lastRun('gcc')).toMatchObject({ check: 'gcc', files: 1, error: '', elsewhere: 0, isRunning: false, waitsForTrust: false })
  // The finding reaches the model with the next typed prompt.
  expect(await e.checks.turnNote()).toContain('src/a.c:1 gcc: boom [CI will fail]')
})

test('a whole-project run clears a file it flagged before once the tool no longer reports it, and counts the rest', async () => {
  const e = engine({ '/repo/src/a.c': 'x', '/repo/src/b.c': 'y', '/repo/src/c.c': 'z' }, { isTrusted: true })
  e.pack.checks.push(MAKE)
  e.setScript(() => ({ exitCode: 1, stdout: '', stderr: ERROR_LINE + 'src/c.c:2:2: error: elsewhere\n' }))
  await e.checks.checkFile('/repo/src/a.c')
  await e.checks.runChecks()
  expect(e.commands).toEqual([['make', 'check']])
  expect(e.saved.at(-1)).toMatchObject({ check: 'make', files: ['src/a.c'] })
  expect(e.saved.at(-1)!.findings.map(f => f.file)).toEqual(['src/a.c'])
  expect(e.lastRun('make')?.elsewhere).toBe(1)
  // The next turn writes only b.c, and the build is clean: a.c's finding goes with the run's save.
  e.setScript(() => ({ exitCode: 0, stdout: '', stderr: '' }))
  await e.checks.checkFile('/repo/src/b.c')
  await e.checks.runChecks()
  expect(e.commands.length).toBe(2)
  expect(e.saved.at(-1)).toEqual({ check: 'make', files: ['src/b.c', 'src/a.c'], findings: [] })
})

test('overflow is queued per check: the 41st file runs in a second pass, while a whole-project check over the same files runs once', async () => {
  const files = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`/repo/src/f${i}.c`, 'x']))
  const e = engine(files, { isTrusted: true })
  e.pack.checks.push(GCC, MAKE)
  for (const path of Object.keys(files)) await e.checks.checkFile(path)
  await e.checks.runChecks()
  expect(e.commands.filter(c => c[0] === 'gcc').map(c => c.length - 2)).toEqual([40, 1])
  expect(e.commands.filter(c => c[0] === 'make').length).toBe(1)
  expect(e.lastRun('gcc')?.files).toBe(1)
  expect(e.lastRun('make')?.files).toBe(41)
})

test("a sarif tool's output file is emptied before the run and after it is read; a clearing write that fails is that run's error, and the next check still runs", async () => {
  const e = engine({ '/repo/src/a.cs': 'x', '/repo/src/a.c': 'y' }, { isTrusted: true })
  e.pack.checks.push(DOTNET, GCC)
  const log = JSON.stringify({ version: '2.1.0', runs: [{ results: [{ ruleId: 'CS0103', level: 'error', message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/a.cs' }, region: { startLine: 3 } } }] }] }] })
  let output = ''
  e.setScript(argv => {
    if (argv[0] !== 'dotnet') return { exitCode: 0, stdout: '', stderr: '' }
    output = argv[2]!.slice('-p:ErrorLog='.length).split('%2C')[0]!
    e.files[output] = log
    return { exitCode: 1, stdout: 'Build FAILED.', stderr: '' }
  })
  await e.checks.checkFile('/repo/src/a.cs')
  await e.checks.checkFile('/repo/src/a.c')
  await e.checks.runChecks()
  expect(output).toMatch(/^\/home\/me\/\.claude\/ccinformer\/output\/dotnet-[0-9a-f]{8}\.sarif$/)
  expect(e.writes.filter(([p]) => p === output)).toEqual([[output, ''], [output, '']])
  expect(e.files[output]).toBe('')
  expect(e.saved.find(s => s.check === 'dotnet')?.findings.map(f => [f.file, f.line, f.rule])).toEqual([['src/a.cs', 3, 'CS0103']])
  expect(e.lastRun('dotnet')).toMatchObject({ error: '', files: 1 })

  const failing = engine({ '/repo/src/a.cs': 'x', '/repo/src/a.c': 'y' }, { isTrusted: true, failWrite: CFG + '/output' })
  failing.pack.checks.push(DOTNET, GCC)
  await failing.checks.checkFile('/repo/src/a.cs')
  await failing.checks.checkFile('/repo/src/a.c')
  await failing.checks.runChecks()
  expect(failing.lastRun('dotnet')?.error).toBe(OUTPUT_NOT_WRITTEN)
  expect(failing.commands.map(c => c[0])).toEqual(['gcc'])
})
