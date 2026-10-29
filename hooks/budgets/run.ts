import type { EngineInterface } from 'claude-code'

import type { BudgetReading, BudgetState, PackReport } from '../../types'
import type { Ran } from '../collect'
import type { Lane } from '../core/lanes'
import type { BudgetSpec, ResolvedPack, Source } from '../packs/types'
import { readText } from '../read-records'
import { atPointer, isFresh, limitOf, parseValue, pickReading } from './gauge'
import type { SourceResult } from './gauge'

// A build may take minutes (one here took over two), so it gets process.run's ceiling rather than the heavy lane's.
const BUILD_TIMEOUT_MS = 600_000
const WAITS_FOR_TRUST = "waits until this repo's own tools may run (Debug › Pack, a)"

// What the budgets take from the session: the lanes, its pack and report, when Claude last wrote a file, and where
// their state goes (the atom lives in the hooks module).
export type BudgetDeps = {
  light: Lane
  heavy: Lane
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  lastWriteAt: () => number
  save: (state: BudgetState) => Promise<unknown>
}

export type Budgets = {
  // Read every budget from its sources, in the pack's order.
  refresh: () => Promise<void>
  // Build first (each command source's `build`), then read: what `m` does.
  measure: () => Promise<void>
}

type Head = { sha: string; at: number; branch: string }
type CiRun = { databaseId: number; headSha: string; status?: string }

// The pack's budgets. A command source runs the repo's own report (repo trust needed) and counts as fresh only when
// its `freshAfter` file is newer than HEAD's commit and Claude's last write; a CI log source reads the same line from
// the newest CI run of HEAD, else of the branch (stale). A finished job's log never changes, so each is fetched once.
export function createBudgets($: EngineInterface, deps: BudgetDeps): Budgets {
  let state: BudgetState = { readings: [], doing: '', at: 0, error: '' }
  let isBusy = false
  const jobs = new Map<string, number | null>()
  const logs = new Map<number, string>()

  const set = async (patch: Partial<BudgetState>) => {
    state = { ...state, ...patch }
    await deps.save(state)
  }
  const run = (lane: Lane, argv: string[], root: string, timeoutMs?: number): Promise<Ran> =>
    lane(argv, timeoutMs, root).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const firstLine = (text: string) => text.trim().split('\n').find(l => l.trim())?.trim() ?? ''

  const headOf = async (root: string): Promise<Head> => {
    const log = await run(deps.light, ['git', 'log', '-1', '--format=%H %ct'], root)
    const branch = await run(deps.light, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root)
    const [sha = '', seconds = '0'] = log.exitCode === 0 ? log.stdout.trim().split(' ') : []
    return { sha, at: Number(seconds) * 1000, branch: branch.exitCode === 0 ? branch.stdout.trim() : '' }
  }

  const readCommand = async (
    source: Extract<Source, { kind: 'command' }>,
    root: string,
    head: Head,
    outputs: Map<string, Ran>,
  ): Promise<SourceResult> => {
    const at = await $.clock.now()
    const none = (error: string): SourceResult => ({ kind: 'command', value: null, staleWhy: '', error, at })
    if (!deps.report()?.trust.isTrusted) return none(WAITS_FOR_TRUST)
    const built = source.freshAfter ? await $.fs.stat(`${root}/${source.freshAfter}`).catch(() => null) : null
    if (source.freshAfter && !built) return none(`${source.freshAfter} isn't there: build first (m)`)
    const key = source.argv.join('\u0000')
    const ran = outputs.get(key) ?? (await run(deps.heavy, source.argv, root))
    outputs.set(key, ran)
    // A report that finds the budget broken exits 1 and still prints its reading.
    const value = parseValue(ran.stdout, source.parse, source.scale)
    if (value === null) return none(firstLine(ran.stderr) || 'its output held no reading')
    const lastWrite = deps.lastWriteAt()
    const staleWhy =
      built && !isFresh(built.mtimeMs, head.at, lastWrite) ? `${source.freshAfter} is older than ${built.mtimeMs < head.at ? 'HEAD' : 'the last change'}` : ''
    return { kind: 'command', value, staleWhy, error: '', at }
  }

  // The job of that name in a CI run, by id; remembered per run.
  const jobOf = async (runId: number, name: string, root: string): Promise<number | null> => {
    const key = runId + '\u0000' + name
    if (jobs.has(key)) return jobs.get(key) ?? null
    const ran = await run(deps.light, ['gh', 'run', 'view', String(runId), '--json', 'jobs'], root)
    let id: number | null = null
    try {
      id = (JSON.parse(ran.stdout) as { jobs: { databaseId: number; name: string }[] }).jobs.find(j => j.name === name)?.databaseId ?? null
    } catch {
      return null
    }
    jobs.set(key, id)
    return id
  }
  const runsOf = async (argv: string[], root: string): Promise<CiRun[]> => {
    const ran = await run(deps.light, argv, root)
    try {
      return (JSON.parse(ran.stdout) as CiRun[]).filter(r => !r.status || r.status === 'completed')
    } catch {
      return []
    }
  }
  const readCiLog = async (source: Extract<Source, { kind: 'ci-log' }>, root: string, head: Head): Promise<SourceResult> => {
    const at = await $.clock.now()
    const fields = ['--json', 'databaseId,headSha,status', '--limit', '10']
    const ofHead = head.sha ? await runsOf(['gh', 'run', 'list', '--commit', head.sha, ...fields], root) : []
    const ofBranch = ofHead.length || !head.branch ? [] : await runsOf(['gh', 'run', 'list', '--branch', head.branch, '--status', 'completed', ...fields], root)
    for (const ci of [...ofHead, ...ofBranch]) {
      const job = await jobOf(ci.databaseId, source.job, root)
      if (job === null) continue
      let log = logs.get(job)
      if (log === undefined) {
        const ran = await run(deps.light, ['gh', 'run', 'view', '--job', String(job), '--log'], root)
        if (ran.exitCode !== 0) continue
        log = ran.stdout
        logs.set(job, log)
      }
      const value = parseValue(log, source.parse, source.scale)
      if (value !== null) return { kind: 'ci-log', value, staleWhy: ci.headSha === head.sha ? '' : `CI's run of ${ci.headSha.slice(0, 7)}, not HEAD`, error: '', at }
    }
    return { kind: 'ci-log', value: null, staleWhy: '', error: `no CI run of HEAD or ${head.branch || 'this branch'} has its "${source.step}" reading`, at }
  }

  const baselineOf = async (spec: BudgetSpec, root: string): Promise<number | null> =>
    typeof spec.limit === 'object' && spec.limit.baseline.kind === 'json'
      ? atPointer(await readText($, `${root}/${spec.limit.baseline.path}`), spec.limit.baseline.pointer)
      : null

  // Each budget's sources in order, stopping at the first fresh value; both budgets of one report share its run.
  const readAll = async () => {
    const pack = await deps.pack()
    const root = deps.report()?.root ?? ''
    if (!pack || !root) return
    // The last error stays until this read replaces it, so the view doesn't drop a line and draw it again.
    await set({ doing: 'reading' })
    const head = await headOf(root)
    const outputs = new Map<string, Ran>()
    const readings: BudgetReading[] = []
    for (const spec of pack.budgets) {
      const results: SourceResult[] = []
      for (const source of spec.sources) {
        const result =
          source.kind === 'command'
            ? await readCommand(source, root, head, outputs)
            : source.kind === 'ci-log'
              ? await readCiLog(source, root, head)
              : { kind: source.kind, value: null, staleWhy: '', error: `"${source.kind}" sources aren't read yet`, at: await $.clock.now() }
        results.push(result)
        if (result.value !== null && !result.staleWhy) break
      }
      readings.push(pickReading(spec, results, limitOf(spec, await baselineOf(spec, root))))
    }
    await set({ readings, doing: '', at: await $.clock.now(), error: '' })
  }

  const alone = async (job: () => Promise<void>) => {
    if (isBusy) return
    isBusy = true
    try {
      await job()
    } finally {
      isBusy = false
      if (state.doing) await set({ doing: '' })
    }
  }

  return {
    refresh: () => alone(readAll),
    measure: () =>
      alone(async () => {
        const pack = await deps.pack()
        const root = deps.report()?.root ?? ''
        if (!pack || !root) return
        if (!deps.report()?.trust.isTrusted) return void (await set({ error: `A build ${WAITS_FOR_TRUST}.` }))
        const builds = new Map<string, string[]>()
        for (const s of pack.budgets.flatMap(b => b.sources)) if (s.kind === 'command' && s.build) builds.set(s.build.join('\u0000'), s.build)
        for (const argv of builds.values()) {
          await set({ doing: 'building' })
          const ran = await run(deps.heavy, argv, root, BUILD_TIMEOUT_MS)
          if (ran.exitCode !== 0) return void (await set({ error: `The build failed: ${firstLine(ran.stderr) || 'exit ' + ran.exitCode}` }))
        }
        await readAll()
      }),
  }
}
