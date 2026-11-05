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

// git as the scene checks call it, over the repo's files in memory and `head`, the last commit's files (repo paths):
// rev-parse, diff --name-only (modified or deleted scenes), show HEAD:<path>, and grep with -l, -o, -F, -E, -w, -e and
// :(top,glob) or :(top,literal) pathspecs, answering exit 1 when nothing matches, as git does.
const fakeGit = (files: Record<string, string>, head: Record<string, string> | null): Script => argv => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  const working = () => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(ROOT + '/')).map(([p, t]) => [p.slice(ROOT.length + 1), t]))
  if (argv[1] === 'rev-parse') return head ? ok('c0ffee\n') : { exitCode: 128, stdout: '', stderr: 'fatal: ambiguous argument HEAD' }
  if (argv.includes('diff')) {
    const now = working()
    return ok(Object.keys(head ?? {}).filter(p => p.endsWith('.tscn') && now[p] !== head![p]).map(p => p + '\n').join(''))
  }
  if (argv[1] === 'show') {
    const path = argv[2]!.slice('HEAD:'.length)
    return head && path in head ? ok(head[path]!) : { exitCode: 128, stdout: '', stderr: 'fatal: path not in HEAD' }
  }
  if (!argv.includes('grep')) return { exitCode: 2, stdout: '', stderr: 'unknown' }
  const sep = argv.indexOf('--')
  const opts = argv.slice(argv.indexOf('grep') + 1, sep)
  const specs = argv.slice(sep + 1)
  const patterns = opts.flatMap((o, i) => (o === '-e' ? [opts[i + 1]!] : []))
  const isWord = opts.includes('-w')
  const toRegex = (p: string) => {
    const body = opts.includes('-E') ? p.replace(/\[\[:space:\]\]/g, '\\s') : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(isWord ? `(?<![\\w])(?:${body})(?![\\w])` : body, 'g')
  }
  const takes = (path: string) =>
    specs.some(s => (s.startsWith(':(top,literal)') ? path === s.slice(':(top,literal)'.length) : path.endsWith(s.slice(':(top,glob)**/*'.length))))
  const out: string[] = []
  const listed = new Set<string>()
  for (const [path, text] of Object.entries(working()).filter(([p]) => takes(p)))
    text.split('\n').forEach((line, i) => {
      for (const p of patterns)
        for (const m of line.matchAll(toRegex(p))) {
          if (opts.includes('-l')) listed.add(path)
          else out.push(`${path}\0${i + 1}\0${opts.includes('-o') ? m[0] : line}`)
          if (!opts.includes('-o')) return
        }
    })
  const stdout = opts.includes('-l') ? [...listed].map(p => p + '\0').join('') : out.map(l => l + '\n').join('')
  return stdout ? ok(stdout) : { exitCode: 1, stdout: '', stderr: '' }
}

// `missing`: the programs this machine lacks, by name, with the reason the lookup gives.
// `head`: the last commit's files for the fake git (null: no commit yet); `git` answers a git command first when it
// returns one (a failure, a throw); `sizes` overrides a file's size.
const engine = (
  files: Record<string, string>,
  opts: { isTrusted?: boolean; failWrite?: string; missing?: Record<string, string>; head?: Record<string, string> | null; git?: (argv: string[]) => Ran | undefined; sizes?: Record<string, number> } = {},
) => {
  const writes: [string, string][] = []
  const mtimes: Record<string, number> = {}
  let now = 1000
  const $ = {
    fs: {
      stat: async (p: string) => (p in files ? { kind: 'file', size: opts.sizes?.[p] ?? files[p]!.length, mtimeMs: mtimes[p] ?? 1 } : null),
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
  const gitCommands: string[][] = []
  const git = fakeGit(files, opts.head === undefined ? {} : opts.head)
  let script: Script = () => ({ exitCode: 0, stdout: '', stderr: '' })
  let isTrusted = opts.isTrusted ?? false
  const pack: ResolvedPack = { id: 'own', processes: [], environments: [], checks: [], budgets: [], noise: [] }
  const report = () => ({ root: ROOT, trust: { isTrusted, by: isTrusted ? 'you' : '', at: 0 } }) as unknown as PackReport
  const deps: CheckDeps = {
    cwd: ROOT,
    hasProgram: async bin => opts.missing?.[bin[0] ?? ''] ?? '',
    emptySuppressions: CFG + '/empty-suppressions.json',
    outputDir: CFG + '/output',
    sessionId: 's1',
    heavy: async argv => {
      commands.push(argv)
      return script(argv)
    },
    light: async argv => {
      gitCommands.push(argv)
      const answer = opts.git?.(argv)
      return answer ?? git(argv)
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
    findingFiles: async check => [...new Set(saved.filter(s => s.check === check).flatMap(s => s.findings.map(f => f.file)))],
    // The trust question is off, so an untrusted repo simply waits.
    may: id => id !== 'ask.repoTrust',
  }
  const checks = createChecks($, deps)
  const lastRun = (check: string) => runs.filter(r => r.check === check).at(-1)
  // A file changed as an editor would: new text and a new modified time.
  const change = (path: string, text: string | null) => {
    if (text === null) delete files[path]
    else files[path] = text
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  return { checks, pack, runs, saved, commands, gitCommands, writes, files, lastRun, change, setScript: (s: Script) => (script = s), trust: (v: boolean) => (isTrusted = v) }
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

test("a program this machine lacks skips its check: no run, no wait for trust, nothing for the model, and the run line says why", async () => {
  const e = engine({ '/repo/src/a.c': 'int x;' }, { missing: { gcc: "gcc isn't installed" } })
  e.pack.checks.push(GCC)
  await e.checks.checkFile('/repo/src/a.c')
  await e.checks.runChecks()
  expect(e.commands).toEqual([])
  expect(e.runs.map(r => [r.check, r.skipped, r.waitsForTrust, r.isRunning])).toEqual([['gcc', "gcc isn't installed", false, false]])
  expect(await e.checks.turnNote()).toBe('')
  // Nothing is kept waiting: once trusted, a later turn with no new writes runs nothing.
  e.trust(true)
  await e.checks.runChecks()
  expect(e.commands).toEqual([])
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

// Godot scenes: an invented lobby with a side bar holding a gauge, and its C# script on a base class of the repo's.
const SCENE_ON = ['**/*.tscn', '**/*.cs']
const CONNECTIONS: CheckSpec = { id: 'scene-connections', label: 'Scene connections', on: SCENE_ON, analyzer: 'tscn-connections', cost: 'turn', class: 'advise' }
const NODEPATHS: CheckSpec = { id: 'scene-nodepaths', label: 'Scene node paths', on: SCENE_ON, analyzer: 'tscn-nodepaths', cost: 'turn', class: 'advise' }
const GAUGE = '[node name="Gauge" type="ProgressBar" parent="Sidebar"]'
const lobby = (method: string, extra = '') =>
  [
    '[gd_scene format=3]',
    '[ext_resource type="Script" path="res://atrium/Lobby.cs" id="1_a"]',
    '[node name="Lobby" type="Control"]',
    'script = ExtResource("1_a")',
    '[node name="Sidebar" type="VBoxContainer" parent="."]',
    extra,
    '[node name="PlayButton" type="Button" parent="."]',
    `[connection signal="pressed" from="PlayButton" to="." method="${method}"]`,
    '',
  ].join('\n')
const LOBBY_CS = 'public partial class Lobby : LobbyBase\n{\n    public void OnPlayPressed() { }\n    public override void _Ready()\n    {\n        GetNode<ProgressBar>("Sidebar/Gauge");\n    }\n}\n'
const BASE_CS = (body = '') => `public partial class LobbyBase : Control\n{\n${body}}\n`
const godot = (scene: string, extra: Record<string, string> = {}) => ({
  '/repo/project.godot': '[application]\n',
  '/repo/atrium/lobby.tscn': scene,
  '/repo/atrium/Lobby.cs': LOBBY_CS,
  '/repo/atrium/LobbyBase.cs': BASE_CS(),
  ...extra,
})
const sceneSaves = (e: ReturnType<typeof engine>, check: string) => e.saved.filter(s => s.check === check).map(s => [s.files, s.findings.map(f => `${f.file}:${f.line} ${f.message}`)])

test('a connection to a method the script lacks is flagged in its scene; a fix in the base class clears it', async () => {
  const e = engine(godot(lobby('OnLeavePressed')))
  e.pack.checks.push(CONNECTIONS)
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  expect(sceneSaves(e, 'scene-connections')).toEqual([
    [['atrium/lobby.tscn'], ['atrium/lobby.tscn:8 connection "pressed" from PlayButton calls OnLeavePressed, which atrium/Lobby.cs doesn\'t declare']],
  ])
  expect(e.lastRun('scene-connections')).toMatchObject({ files: 1, error: '', isRunning: false, waitsForTrust: false })
  expect(await e.checks.turnNote()).toContain('atrium/lobby.tscn:8 missing-method')
  // The method lands in the base class: no scene was written, but the scene holding the finding is looked at again.
  e.change('/repo/atrium/LobbyBase.cs', BASE_CS('    public void OnLeavePressed() { }\n'))
  await e.checks.checkFile('/repo/atrium/LobbyBase.cs')
  await e.checks.runChecks()
  expect(sceneSaves(e, 'scene-connections').at(-1)).toEqual([['atrium/lobby.tscn'], []])
})

test('a node removed from a scene is flagged where a script still names it, told once, and cleared once it is back', async () => {
  const e = engine(godot(lobby('OnPlayPressed')), { head: { 'atrium/lobby.tscn': lobby('OnPlayPressed', GAUGE) } })
  e.pack.checks.push(NODEPATHS)
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  const flagged = 'atrium/Lobby.cs:6 GetNode path "Sidebar/Gauge" names Gauge, a node removed from atrium/lobby.tscn'
  expect(sceneSaves(e, 'scene-nodepaths')).toEqual([[['atrium/Lobby.cs'], [flagged]]])
  expect(await e.checks.turnNote()).toContain('atrium/Lobby.cs:6 removed-node')
  // A turn that writes only another script reads no scene from git and keeps the finding in the unwritten script.
  const before = e.gitCommands.length
  e.change('/repo/atrium/Marquee.cs', 'public partial class Marquee : Label\n{\n}\n')
  await e.checks.checkFile('/repo/atrium/Marquee.cs')
  await e.checks.runChecks()
  expect(e.gitCommands.slice(before).some(c => c[1] === 'show')).toBe(false)
  expect(sceneSaves(e, 'scene-nodepaths').at(-1)).toEqual([['atrium/Marquee.cs'], []])
  // A scene written again finds the same thing, and the model isn't told twice.
  e.change('/repo/atrium/lobby.tscn', lobby('OnPlayPressed') + '\n')
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  expect(sceneSaves(e, 'scene-nodepaths').at(-1)).toEqual([['atrium/Lobby.cs'], [flagged]])
  expect(await e.checks.turnNote()).toBe('')
  // The node comes back: git grep finds nothing (exit 1), a complete answer that clears the finding.
  e.change('/repo/atrium/lobby.tscn', lobby('OnPlayPressed', GAUGE))
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  expect(sceneSaves(e, 'scene-nodepaths').at(-1)).toEqual([['atrium/Lobby.cs'], []])
})

test('a name another scene still has is not removed; a scene with no commit yet compares with nothing', async () => {
  const hud = `[node name="Hud" type="Control"]\n${GAUGE.replace('"Sidebar"', '"."')}\n`
  const still = engine(godot(lobby('OnPlayPressed'), { '/repo/atrium/hud.tscn': hud }), { head: { 'atrium/lobby.tscn': lobby('OnPlayPressed', GAUGE) } })
  still.pack.checks.push(NODEPATHS)
  await still.checks.checkFile('/repo/atrium/lobby.tscn')
  await still.checks.runChecks()
  expect(sceneSaves(still, 'scene-nodepaths')).toEqual([[[], []]])
  const fresh = engine(godot(lobby('OnPlayPressed')), { head: null })
  fresh.pack.checks.push(NODEPATHS)
  await fresh.checks.checkFile('/repo/atrium/lobby.tscn')
  await fresh.checks.runChecks()
  expect([fresh.saved, fresh.lastRun('scene-nodepaths')?.error]).toEqual([[], ''])
})

test('the scene checks need no trust: with the question off and a tool check waiting, they still run', async () => {
  const e = engine({ ...godot(lobby('OnLeavePressed')), '/repo/src/a.c': 'int x;' })
  e.pack.checks.push(GCC, CONNECTIONS)
  await e.checks.checkFile('/repo/src/a.c')
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  expect(e.lastRun('gcc')?.waitsForTrust).toBe(true)
  expect(sceneSaves(e, 'scene-connections')[0]![1]).toHaveLength(1)
  expect(e.commands).toEqual([])
})

test('nothing covered written, no git; a git failure is an error line that keeps the findings; a throwing lane spares the tool checks', async () => {
  const idle = engine({ ...godot(lobby('OnPlayPressed')), '/repo/notes.txt': 'x' })
  idle.pack.checks.push(CONNECTIONS, NODEPATHS)
  await idle.checks.checkFile('/repo/notes.txt')
  await idle.checks.runChecks()
  expect(idle.gitCommands).toEqual([])

  let isBroken = false
  const e = engine(godot(lobby('OnPlayPressed')), {
    head: { 'atrium/lobby.tscn': lobby('OnPlayPressed', GAUGE) },
    git: argv => (isBroken && argv.includes('grep') ? { exitCode: 2, stdout: '', stderr: 'fatal: bad pattern' } : undefined),
  })
  e.pack.checks.push(NODEPATHS)
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  isBroken = true
  e.change('/repo/atrium/lobby.tscn', lobby('OnPlayPressed') + '\n')
  await e.checks.checkFile('/repo/atrium/lobby.tscn')
  await e.checks.runChecks()
  expect(sceneSaves(e, 'scene-nodepaths')).toHaveLength(1)
  expect(e.lastRun('scene-nodepaths')?.error).toBe('git could not read the scenes')

  const throwing = engine(
    { ...godot(lobby('OnLeavePressed')), '/repo/src/a.c': 'int x;' },
    {
      isTrusted: true,
      git: () => {
        throw new Error('git is gone')
      },
    },
  )
  throwing.pack.checks.push(CONNECTIONS, GCC)
  await throwing.checks.checkFile('/repo/atrium/lobby.tscn')
  await throwing.checks.checkFile('/repo/src/a.c')
  await throwing.checks.runChecks()
  expect(throwing.commands.map(c => c[0])).toEqual(['gcc'])
})

test('a scene over 4 MiB is skipped and counted; past 20 scenes the rest run in a second pass', async () => {
  const big = engine(godot(lobby('OnLeavePressed')), { sizes: { '/repo/atrium/lobby.tscn': 5 * 1024 * 1024 } })
  big.pack.checks.push(CONNECTIONS)
  await big.checks.checkFile('/repo/atrium/lobby.tscn')
  await big.checks.runChecks()
  expect(big.lastRun('scene-connections')).toMatchObject({ files: 0, error: '', note: '1 scene too large' })

  const many: Record<string, string> = {}
  for (let i = 0; i < 21; i++) many[`/repo/atrium/room${i}.tscn`] = `[node name="Room${i}" type="Node3D"]\n`
  const e = engine(godot(lobby('OnPlayPressed'), many))
  e.pack.checks.push(CONNECTIONS)
  for (let i = 0; i < 21; i++) await e.checks.checkFile(`/repo/atrium/room${i}.tscn`)
  await e.checks.runChecks()
  expect(e.runs.filter(r => r.check === 'scene-connections').map(r => r.files)).toEqual([20, 1])
})
