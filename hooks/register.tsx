import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type {
  AgentRow, Area, CiSnapshot, Compaction, DebugView, DiffPreview, FileChange, GitSnapshot, PackReport, RunSummary, SessionBeat, StepRow,
  ToolOutcome, ToolRow, WorkView, WorkflowRun,
} from '../types'
import { areaDef, areaFor, areaNames } from './areas'
import { collectCi, collectDiff, collectGit } from './collect'
import type { Exec } from './collect'
import { createLanes, createSolo } from './core/lanes'
import { paneTitle, spinner } from './format'
import { ciOutcome, sessionGroups } from './insight'
import { OPERATION_MARKERS, parseWorkflowMeta, previewDiff, previewNewFile } from './parse'
import { isFinished } from './phases'
import { askTrust, forgetTrust, loadPack, packSignature } from './packs/load'
import { mergeRecord, parseHead, projectDirName, recordKey, runFromRecord, upgradeRun } from './records'
import {
  LISTED_STATES, TOUCHING_TOOLS, capped, contextTokens, endedState, isOver, isPush, pruneAgents, summarize, taskOf, toolLabel,
} from './rows'
import { ACCENT, AreaBar, ViewBar } from './ui'
import type { Badge, Kit } from './ui'
import { AgentsView as AgentsPanel } from './view-agents'
import { DebugPanel, debugCounts } from './view-debug'
import { PackView } from './view-pack'
import { GitView } from './view-git'
import { SessionsView } from './view-sessions'
import { summarizeRun } from './stats'
import { StatsView } from './view-stats'

const PANE = 'ccinformer'
const TITLE = 'CCInformer'
// The command, and a short alias that runs the same handler.
const COMMAND = 'ccinformer'
const ALIAS = 'side'
const ARGUMENT_HINT = '[' + areaNames().join('|') + ']'
// The pane asks for a quarter of the terminal, never less than this; a width the person drags to wins.
const SHARE = 0.25
const MIN_COLUMNS = 40
const STORE_AREA = 'area'
// Where versions before the areas kept the tab; read when there's no area yet.
const STORE_OLD_TAB = 'tab'
const STORE_OPEN = 'isOpen'
const STORE_COLUMNS = 'columns'
const STORE_CI_PINGED = 'ciPinged'
const STORE_SESSION = 'session:'

// Everything below counts in ticks of a second.
const TICK_MS = 1000
const GIT_EVERY_TICKS = 5
const AGENTS_EVERY_TICKS = 2
// CI is polled fast while checks run and for a while after a push (even with the pane closed, for the ping),
// slowly while the Git tab shows, and not at all otherwise.
const CI_LIVE_EVERY_TICKS = 8
const CI_IDLE_EVERY_TICKS = 60
const CI_HOT_MS = 3 * 60_000
const RECORDS_EVERY_TICKS = 10
const HISTORY_EVERY_TICKS = 60
const BEAT_EVERY_TICKS = 15
const SESSIONS_EVERY_TICKS = 5
// A session counts as active while a turn runs and this long after one, or after the person used the pane.
// Mods can't tell whether the terminal is in front, so this stands in for it: git is polled only while active.
const ACTIVE_MS = 3 * 60_000
const TOUCH_SETTLE_MS = 400
const RECORD_SETTLE_MS = 3000
const FETCH_TIMEOUT_MS = 60_000
const CI_PINGS_KEPT = 20
const BEAT_FORGOTTEN_MS = 24 * 60 * 60_000
const HISTORY_SESSIONS = 12
const HISTORY_RECORDS = 8
const STATS_EVERY_TICKS = 120

// What the pane draws from. Kept in $.state, so a write redraws the pane and a hot reload keeps it.
const areaAtom = atom({ plugin: 'ccinformer', key: 'area' } as const, 'code' as Area)
const debugViewAtom = atom({ plugin: 'ccinformer', key: 'debugView' } as const, 'tools' as DebugView)
const workViewAtom = atom({ plugin: 'ccinformer', key: 'workView' } as const, 'runs' as WorkView)
const NOTHING_SELECTED: Record<Area, string> = { now: '', code: '', work: '', timeline: '', debug: '' }
const selectedAtom = atom({ plugin: 'ccinformer', key: 'selected' } as const, NOTHING_SELECTED)
const phaseAtom = atom({ plugin: 'ccinformer', key: 'phase' } as const, '')
const statsNameAtom = atom({ plugin: 'ccinformer', key: 'statsName' } as const, '')
const statsAtom = atom({ plugin: 'ccinformer', key: 'stats' } as const, [] as RunSummary[])
const showAllFilesAtom = atom({ plugin: 'ccinformer', key: 'showAllFiles' } as const, false)
const diffAtom = atom({ plugin: 'ccinformer', key: 'diff' } as const, null as DiffPreview | null)
const isOpenAtom = atom({ plugin: 'ccinformer', key: 'isOpen' } as const, false)
const isActiveAtom = atom({ plugin: 'ccinformer', key: 'isActive' } as const, true)
// The clock elapsed times and spinners draw from, ticked once a second while the pane is open.
const nowAtom = atom({ plugin: 'ccinformer', key: 'now' } as const, 0)
const gitAtom = atom({ plugin: 'ccinformer', key: 'git' } as const, null as GitSnapshot | null)
const ciAtom = atom({ plugin: 'ccinformer', key: 'ci' } as const, null as CiSnapshot | null)
const agentsAtom = atom({ plugin: 'ccinformer', key: 'agents' } as const, [] as AgentRow[])
const runsAtom = atom({ plugin: 'ccinformer', key: 'runs' } as const, [] as WorkflowRun[])
const toolsAtom = atom({ plugin: 'ccinformer', key: 'tools' } as const, [] as ToolRow[])
const stepsAtom = atom({ plugin: 'ccinformer', key: 'steps' } as const, [] as StepRow[])
const compactionsAtom = atom({ plugin: 'ccinformer', key: 'compactions' } as const, [] as Compaction[])
const sessionsAtom = atom({ plugin: 'ccinformer', key: 'sessions' } as const, [] as SessionBeat[])
const packAtom = atom({ plugin: 'ccinformer', key: 'pack' } as const, null as PackReport | null)

const MAX_AGENTS = 300
const MAX_RUNS = 12
const MAX_TOOLS = 150
const MAX_STEPS = 200
const MAX_COMPACTIONS = 30

// What the hooks learn about this session as it goes. Module variables: a hot reload starts them over.
let selfId = ''
let cwd = ''
let lastActive = 0
let isTurnRunning = false
let lastTask = ''
let lastModel = ''
let contextWindow = 0

// The background work, built in session.start over that hook's $; the other hooks reach it here.
type Live = {
  refresh: (area: Area) => Promise<void>
  showArea: (target: { area: Area; view?: string }) => Promise<void>
  touched: () => void
  pushed: () => void
  wake: () => Promise<void>
  recordsSoon: () => void
  openDiff: (file: FileChange) => Promise<void>
  fetch: () => Promise<void>
  checkPack: () => Promise<void>
  setTrust: (isAllowed: boolean) => Promise<string>
}
let live: Live | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Toggle the CCInformer pane: sessions, git and CI, workflows, debug',
      argumentHint: ARGUMENT_HINT,
      immediate: true,
    })
    await $.command.register({
      name: ALIAS,
      description: `Short for /${COMMAND}: toggle the CCInformer pane`,
      argumentHint: ARGUMENT_HINT,
      immediate: true,
    })
    const stored = (await $.store.get(STORE_AREA)) ?? (await $.store.get(STORE_OLD_TAB))
    const restored = typeof stored === 'string' ? areaFor(stored) : null
    if (restored) await update($, areaAtom, () => restored.area)
    // Runs this session recorded with an older version of the mod get a status now.
    const recorded = await read($, agentsAtom)
    await update($, runsAtom, list => list.map(r => upgradeRun(r, recorded)))
    selfId = await $.session.id()
    cwd = await $.session.cwd()
    const startedAt = await $.clock.now()
    lastActive = startedAt
    const configDir =
      (await $.env.get('CLAUDE_CONFIG_DIR')) || ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '') + '/.claude'
    const projectsDir = configDir + '/projects/' + projectDirName(cwd)

    // The one place the mod runs commands: everything else goes through a lane (a CI check holds this).
    const lanes = createLanes((argv, timeoutMs) => $.process.run(argv, { timeoutMs }))
    const exec: Exec = lanes.light
    // Each poll below runs alone: one that comes due while its last run is busy is skipped.
    const solo = createSolo()
    // The pack: read at start, and again when a file it comes from has changed. A reload asked for while one
    // runs joins it. The latest report is kept here too: a hook reads state as it stood when its event began, so
    // one that waited for a load reads the load's result from here.
    let packStamp = ''
    let packReport: PackReport | null = null
    let packLoad: Promise<PackReport> | null = null
    const reloadPack = (): Promise<PackReport> =>
      (packLoad ??= (async () => {
        const { report } = await loadPack($, exec, cwd, configDir)
        packReport = report
        await update($, packAtom, () => report)
        packStamp = await packSignature($, report.root, configDir)
        return report
      })().finally(() => {
        packLoad = null
      }))
    let ticks = 0
    let isGitQueued = false
    let isRecordQueued = false
    let ciHotUntil = 0
    // Records already read, by path, with the mtime they were read at.
    const readRecords = new Map<string, number>()

    const isActive = (now: number) => isTurnRunning || now - lastActive < ACTIVE_MS

    // Tells the person once when this commit's checks finish; one session pings for all of them.
    const pingCi = async (prev: CiSnapshot | null, ci: CiSnapshot) => {
      const outcome = ciOutcome(prev, ci)
      if (!outcome) return
      const pinged = await $.store.get(STORE_CI_PINGED)
      const list = Array.isArray(pinged) ? (pinged as string[]) : []
      if (list.includes(ci.head)) return
      await $.store.set(STORE_CI_PINGED, [...list, ci.head].slice(-CI_PINGS_KEPT))
      $.ui.toast((outcome.isOk ? '✓ ' : '✗ ') + outcome.text)
      await $.ui.notify(outcome.text, { title: outcome.isOk ? 'CI passed' : 'CI failed' })
    }
    const refreshCi = () =>
      solo('ci', async () => {
        const git = await read($, gitAtom)
        if (!git || git.error) return
        const prev = await read($, ciAtom)
        const ci = await collectCi(exec, git.branch, git.head, await $.clock.now())
        await update($, ciAtom, () => ci)
        await pingCi(prev, ci)
      })
    const refreshGit = () =>
      solo('git', async () => {
        const before = await read($, gitAtom)
        const collected = await collectGit(exec, await $.clock.now())
        const git = collected.gitDir ? { ...collected, ...(await gitFolderFacts(collected.gitDir)) } : collected
        await update($, gitAtom, () => git)
        // An open diff follows its file, and closes once the file is no longer changed (committed, reverted).
        const diff = await read($, diffAtom)
        const changed = diff && !diff.isLoading ? git.files.find(f => f.path === diff.path) : undefined
        if (diff && !diff.isLoading && !changed) {
          await update($, diffAtom, () => null)
          await update($, selectedAtom, s => ({ ...s, code: '' }))
        }
        if (changed) void loadDiff(changed, git.root)
        if (!before || before.branch !== git.branch || before.head !== git.head) await refreshCi()
      })
    // What the git folder itself says: an operation in the middle (rebase, merge, ...) and when it last fetched.
    const gitFolderFacts = async (gitDir: string): Promise<{ operation: string; fetchedAt: number }> => {
      let operation = ''
      for (const m of OPERATION_MARKERS) if (!operation && (await $.fs.exists(`${gitDir}/${m.file}`))) operation = m.name
      const fetched = await $.fs.stat(`${gitDir}/FETCH_HEAD`).catch(() => null)
      return { operation, fetchedAt: fetched?.mtimeMs ?? 0 }
    }
    // A file's diff for the preview: against HEAD, or an untracked file's first lines as added.
    const loadDiff = async (file: FileChange, root: string) => {
      const text = file.code === '??' ? previewNewFile(await readText(`${root}/${file.path}`)) : previewDiff(await collectDiff(exec, file.path))
      const shown = await read($, diffAtom)
      if (shown?.path === file.path) await update($, diffAtom, () => ({ path: file.path, text, isLoading: false }))
    }
    // Subagents the session lists; workflow agents aren't listed, their turn.complete and run record end them.
    const pollAgents = async () => {
      const listed = await $.agent.list()
      if (listed.length === 0) return
      const byId = new Map(listed.map(a => [a.id, LISTED_STATES[a.status]]))
      const now = await $.clock.now()
      await update($, agentsAtom, list =>
        list.map(a => {
          const status = byId.get(a.id)
          if (!status || status === a.status) return a
          return { ...a, status, endedAt: isOver(status) ? a.endedAt || now : 0 }
        }),
      )
    }
    const readText = async (path: string): Promise<string> => {
      const text = await $.fs.read(path).catch(() => '')
      return typeof text === 'string' ? text : ''
    }
    // A run this session started is finished once Claude Code has written its record: take its status and totals.
    const checkRecords = async () => {
      const runs = await read($, runsAtom)
      for (const run of runs.filter(r => !r.session && r.runId && !isFinished(r))) {
        const path = `${projectsDir}/${selfId}/workflows/${run.runId}.json`
        if (!(await $.fs.exists(path))) continue
        const record = runFromRecord(await readText(path), run.toolUseId, '')
        if (!record || !isFinished(record.run)) continue
        const done = { ...record.run, phases: record.run.phases.length ? record.run.phases : run.phases }
        await update($, runsAtom, list => list.map(r => (r.toolUseId === run.toolUseId ? done : r)))
        await update($, agentsAtom, list => mergeRecord(list, record))
        readRecords.set(path, Number.MAX_SAFE_INTEGER)
      }
    }
    // Finished runs from this project's recent sessions, newest first, read once each.
    const loadHistory = async () => {
      const sessions = (await $.fs.list(projectsDir).catch(() => []))
        .filter(d => d.kind === 'dir')
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, HISTORY_SESSIONS)
      const found: { path: string; mtime: number; session: string }[] = []
      for (const dir of sessions) {
        const files = await $.fs.list(`${projectsDir}/${dir.name}/workflows`).catch(() => [])
        for (const f of files.filter(f => f.kind === 'file' && /^wf_.*\.json$/.test(f.name)))
          found.push({ path: `${projectsDir}/${dir.name}/workflows/${f.name}`, mtime: f.mtimeMs, session: dir.name })
      }
      const fresh = found
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, HISTORY_RECORDS)
        .filter(f => (readRecords.get(f.path) ?? -1) < f.mtime)
      for (const f of fresh) {
        readRecords.set(f.path, f.mtime)
        const runs = await read($, runsAtom)
        const runId = f.path.split('/').pop()?.replace(/\.json$/, '') ?? ''
        if (runs.some(r => r.runId === runId)) continue
        const record = runFromRecord(await readText(f.path), recordKey(runId), f.session === selfId ? '' : f.session.slice(0, 8))
        if (!record) continue
        const kept = [...runs, record.run].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_RUNS)
        await update($, runsAtom, () => kept)
        await update($, agentsAtom, list => pruneAgents([...list, ...record.agents], kept).slice(-MAX_AGENTS))
      }
    }
    // Every finished run in this project, for the Stats view: each record is read once, again only when it changes.
    const statsCache = new Map<string, { mtime: number; summary: RunSummary | null }>()
    const loadStats = async () => {
      const sessions = (await $.fs.list(projectsDir).catch(() => [])).filter(d => d.kind === 'dir')
      let isChanged = false
      for (const dir of sessions) {
        const files = await $.fs.list(`${projectsDir}/${dir.name}/workflows`).catch(() => [])
        for (const f of files.filter(f => f.kind === 'file' && /^wf_.*\.json$/.test(f.name))) {
          const path = `${projectsDir}/${dir.name}/workflows/${f.name}`
          if (statsCache.get(path)?.mtime === f.mtimeMs) continue
          const record = runFromRecord(await readText(path), recordKey(f.name.replace(/\.json$/, '')), dir.name === selfId ? '' : dir.name.slice(0, 8))
          statsCache.set(path, { mtime: f.mtimeMs, summary: record ? summarizeRun(record) : null })
          isChanged = true
        }
      }
      if (!isChanged) return
      const summaries = [...statsCache.values()].flatMap(c => (c.summary ? [c.summary] : []))
      await update($, statsAtom, () => summaries.sort((a, b) => a.startedAt - b.startedAt))
    }
    const readBranch = async (): Promise<string> => {
      const dotGit = await $.fs.stat('.git').catch(() => null)
      if (!dotGit) return ''
      if (dotGit.kind === 'dir') return parseHead(await readText('.git/HEAD')).branch
      const { gitdir } = parseHead(await readText('.git'))
      return gitdir ? parseHead(await readText(gitdir + '/HEAD')).branch : ''
    }
    // Tells the other sessions what this one is doing, through the store they all share.
    const beat = async (now: number) => {
      const usage = await $.session.usage()
      contextWindow = usage.context.window || contextWindow
      const row: SessionBeat = {
        id: selfId,
        cwd,
        branch: (await readBranch()) || (await read($, gitAtom))?.branch || '',
        task: lastTask,
        isBusy: isTurnRunning,
        model: lastModel,
        contextPercent: Math.round(usage.context.percent ?? 0),
        startedAt,
        updatedAt: now,
      }
      await $.store.set(STORE_SESSION + selfId, row)
    }
    const readSessions = async () => {
      const now = await $.clock.now()
      const beats: SessionBeat[] = []
      for (const key of (await $.store.keys()).filter(k => k.startsWith(STORE_SESSION))) {
        const b = (await $.store.get(key)) as SessionBeat | undefined
        if (!b || typeof b.updatedAt !== 'number') continue
        if (now - b.updatedAt > BEAT_FORGOTTEN_MS) await $.store.delete(key)
        else beats.push(b)
      }
      await update($, sessionsAtom, () => beats)
    }
    // Once a second: keep this session's beat and CI pings going, and while the pane is open, poll what it shows.
    // Git and CI run commands, so the tick starts them without waiting: a slow gh call never holds up the next tick.
    const tick = async () => {
      const now = await $.clock.now()
      ticks += 1
      const active = isActive(now)
      if ((await read($, isActiveAtom)) !== active) await update($, isActiveAtom, () => active)
      if (ticks % BEAT_EVERY_TICKS === 0) await beat(now)
      if (ticks % RECORDS_EVERY_TICKS === 0) await checkRecords()
      const ci = await read($, ciAtom)
      const isCiLive = now < ciHotUntil || (ci?.checks.some(c => c.bucket === 'pending') ?? false)
      const isOpen = await read($, isOpenAtom)
      const area = await read($, areaAtom)
      const isOnCode = isOpen && active && area === 'code'
      const isGitDue = isOnCode && ticks % GIT_EVERY_TICKS === 0
      const isCiDue = isCiLive ? ticks % CI_LIVE_EVERY_TICKS === 0 : isOnCode && ticks % CI_IDLE_EVERY_TICKS === 0
      // When both are due, git goes first, so CI reads the branch git just found.
      if (isGitDue) void refreshGit().then(() => (isCiDue ? refreshCi() : undefined))
      else if (isCiDue) void refreshCi()
      if (!isOpen) return
      await update($, nowAtom, () => now)
      if (ticks % AGENTS_EVERY_TICKS === 0) await pollAgents()
      if (area === 'work' && ticks % HISTORY_EVERY_TICKS === 0) await loadHistory()
      if (area === 'work' && ticks % STATS_EVERY_TICKS === 0 && (await read($, workViewAtom)) === 'stats') await loadStats()
      if (area === 'now' && ticks % SESSIONS_EVERY_TICKS === 0) await readSessions()
    }
    const refresh = async (area: Area) => {
      if (area === 'code') await refreshGit().then(refreshCi)
      if (area === 'work') await checkRecords().then(loadHistory)
      if (area === 'work' && (await read($, workViewAtom)) === 'stats') await loadStats()
      if (area === 'now') await beat(await $.clock.now()).then(readSessions)
    }

    live = {
      refresh,
      // An area, and one of its views when one is named; the area is kept for the next session.
      showArea: async ({ area, view }) => {
        await update($, areaAtom, () => area)
        if (view === 'runs' || view === 'stats') await update($, workViewAtom, () => view)
        if (view === 'tools' || view === 'requests' || view === 'context' || view === 'pack') await update($, debugViewAtom, () => view)
        await $.store.set(STORE_AREA, area)
        await refresh(area)
      },
      // The main loop changed files: refresh git once the burst of edits settles.
      touched: () => {
        if (isGitQueued) return
        isGitQueued = true
        $.clock.after(TOUCH_SETTLE_MS, () => {
          isGitQueued = false
          void refreshGit()
        })
      },
      // A push or a PR: CI is about to start, so poll it fast for a while.
      pushed: () => {
        void $.clock.now().then(now => {
          ciHotUntil = now + CI_HOT_MS
        })
        void refreshGit().then(refreshCi)
      },
      // Something happened in this session: after a pause, bring the Git tab up to date at once.
      wake: async () => {
        const now = await $.clock.now()
        const wasActive = isActive(now)
        lastActive = now
        if (wasActive) return
        await update($, isActiveAtom, () => true)
        if ((await read($, isOpenAtom)) && (await read($, areaAtom)) === 'code') await refreshGit()
      },
      // Pressing a file selects it and shows its diff under it; pressing it again hides it.
      openDiff: async file => {
        const shown = await read($, diffAtom)
        if (shown?.path === file.path) {
          await update($, diffAtom, () => null)
          await update($, selectedAtom, s => ({ ...s, code: '' }))
          return
        }
        await update($, selectedAtom, s => ({ ...s, code: file.path }))
        await update($, diffAtom, () => ({ path: file.path, text: '', isLoading: true }))
        await loadDiff(file, (await read($, gitAtom))?.root ?? '.')
      },
      // The person asked for a fetch: refresh what the upstream has, then the tab.
      fetch: async () => {
        $.ui.toast('Fetching…')
        const fetched = await lanes.heavy(['git', 'fetch', '--quiet'], FETCH_TIMEOUT_MS).catch(() => null)
        $.ui.toast(fetched?.exitCode === 0 ? 'Fetched' : 'Fetch failed: ' + (fetched?.stderr.trim().split('\n')[0] || 'git did not answer'))
        await refreshGit()
      },
      // A main turn starts: read the pack again if a file it comes from changed.
      checkPack: async () => {
        if (packReport && (await packSignature($, packReport.root, configDir)) !== packStamp) await reloadPack()
      },
      // Lets the repo's own tools run (asking first) or stops them; says how it went.
      setTrust: async isAllowed => {
        const report = packReport ?? (await reloadPack())
        if (report.trust.by === 'user pack') return 'A user pack matches this repo, so its tools may run; change that in the pack.'
        if (isAllowed && !(await askTrust($, report))) return "Not allowed: the repo's own tools still wait."
        if (!isAllowed) await forgetTrust($, report)
        await reloadPack()
        return isAllowed ? "The repo's own tools may run here." : "The repo's own tools wait again until you allow them."
      },
      // An agent ended: its run's record may be written now, so look for it shortly.
      recordsSoon: () => {
        if (isRecordQueued) return
        isRecordQueued = true
        $.clock.after(RECORD_SETTLE_MS, () => {
          isRecordQueued = false
          void checkRecords()
        })
      },
    }
    $.clock.every(TICK_MS, () => void tick())
    void beat(startedAt)
    void reloadPack()

    // Reopen where it was left; the engine seats a pane opened unasked only in a wide terminal.
    if ((await $.store.get(STORE_OPEN)) === true) {
      const columns = Number(await $.store.get(STORE_COLUMNS)) || MIN_COLUMNS
      await $.ui.open({ id: PANE, title: paneTitle(TITLE, $.plugin.root), columns })
      await update($, isOpenAtom, () => true)
      void refresh(await read($, areaAtom))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear or /resume keeps the session's process; only a real end takes it off the Sessions tab.
    if (selfId && e.reason !== 'clear' && e.reason !== 'resume') await $.store.delete(STORE_SESSION + selfId)
    return next(e)
  })

  // Both names run this; every other command passes through untouched. Bare, it toggles the pane; with an
  // argument it opens the pane, on that area when it names one (or an old tab), and never closes it.
  on('command.run', async ($, e, next) => {
    if (e.command !== COMMAND && e.command !== ALIAS) return next(e)
    const arg = e.args.trim().toLowerCase()
    void live?.wake()
    if (!arg && (await read($, isOpenAtom))) {
      await $.ui.close({ id: PANE })
      await update($, isOpenAtom, () => false)
      await $.store.set(STORE_OPEN, false)
      return {}
    }
    const [name = '', sub = ''] = arg.split(/\s+/)
    const target = name ? areaFor(name) : null
    // The area is set before the pane opens, so its first drawing is the right one.
    if (target) await update($, areaAtom, () => target.area)
    const columns = Math.max(MIN_COLUMNS, Math.round(e.presentation.columns * SHARE))
    await $.ui.open({ id: PANE, title: paneTitle(TITLE, $.plugin.root), columns })
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    await update($, isOpenAtom, () => true)
    await $.store.set(STORE_OPEN, true)
    await $.store.set(STORE_COLUMNS, columns)
    if (target) void live?.showArea(target)
    else void live?.refresh(await read($, areaAtom))
    if (!target) return arg ? { text: `CCInformer has no area "${name}". Try: ${areaNames().join(', ')}.` } : {}
    if (name === 'pack' && (sub === 'trust' || sub === 'untrust')) return { text: (await live?.setTrust(sub === 'trust')) ?? '' }
    return sub ? { text: `/${COMMAND} ${name} takes no "${sub}"` + (name === 'pack' ? ': try trust or untrust.' : '.') } : {}
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isOpenAtom, () => false)
      await $.store.set(STORE_OPEN, false)
    }
    return next(e)
  })

  // Using the pane counts as activity, so a paused Git tab wakes up.
  on('ui.press', async ($, e, next) => {
    void live?.wake()
    return next(e)
  }).catch(($, e, next) => next(e))
  on('ui.focus', async ($, e, next) => {
    void live?.wake()
    return next(e)
  }).catch(($, e, next) => next(e))
  on('ui.scroll', async ($, e, next) => {
    void live?.wake()
    return next(e)
  }).catch(($, e, next) => next(e))

  // The recorders below watch an event and pass it on unchanged; if one fails, the event goes on without it.

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      isTurnRunning = true
      if (e.text) lastTask = taskOf(e.text)
      void live?.wake()
      void live?.checkPack()
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const startedAt = await $.clock.now()
    const row: ToolRow = {
      id: e.tool_use_id ?? tool + startedAt,
      tool: toolLabel(tool),
      summary: summarize(tool, input),
      agent: e.agentId ?? '',
      startedAt,
      ms: 0,
      outcome: 'running',
    }
    await update($, toolsAtom, list => capped(list, row, MAX_TOOLS))
    if (e.agentId) await update($, agentsAtom, list => list.map(a => (a.id === e.agentId ? { ...a, tools: a.tools + 1 } : a)))
    if (tool === 'Workflow' && e.tool_use_id) {
      const toolUseId = e.tool_use_id
      const path = typeof input.scriptPath === 'string' ? input.scriptPath : ''
      const file = path ? await $.fs.read(path).catch(() => '') : ''
      const script = typeof file === 'string' && file ? file : typeof input.script === 'string' ? input.script : ''
      const meta = script ? parseWorkflowMeta(script) : { name: typeof input.name === 'string' ? input.name : 'workflow', phases: [] }
      const run: WorkflowRun = { toolUseId, runId: '', ...meta, startedAt, status: 'running', endedAt: 0, totalTokens: 0, session: '' }
      await update($, runsAtom, list => capped(list.filter(r => r.toolUseId !== toolUseId), run, MAX_RUNS))
      // A new run: show it, and follow its live phase.
      await update($, phaseAtom, () => '')
      await update($, selectedAtom, s => ({ ...s, work: '' }))
    }

    const result = await next(e)

    // From the call to its result, so a wait for the person's approval counts too. Claude Code's PostToolUse event has
    // the tool's own time, but a team-org account's built-in security plugin skips other plugins' classic hooks.
    const ms = (await $.clock.now()) - startedAt
    const outcome: ToolOutcome = 'deny' in result && result.deny ? 'denied' : result.isError ? 'error' : 'ok'
    await update($, toolsAtom, list => list.map(r => (r.id === row.id ? { ...r, ms, outcome } : r)))
    if (!e.agentId && TOUCHING_TOOLS.includes(tool)) live?.touched()
    if (!e.agentId && isPush(input.command)) live?.pushed()
    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const result = await next(e)
    if (!('agentId' in result) || !result.agentId) return result
    const runId = e.workflow?.runId ?? ''
    const row: AgentRow = {
      id: result.agentId,
      description: e.description,
      type: e.subagentType,
      model: result.model || e.model || e.parentModel,
      status: 'running',
      startedAt,
      endedAt: 0,
      toolUseId: e.tool_use_id,
      runId,
      phase: '',
      tools: 0,
      tokens: 0,
      output: 0,
    }
    await update($, agentsAtom, list => capped(list.filter(a => a.id !== row.id), row, MAX_AGENTS))
    if (runId) await update($, runsAtom, list => list.map(r => (r.toolUseId === e.tool_use_id && !r.runId ? { ...r, runId } : r)))
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const endedAt = await $.clock.now()
      const status = endedState(e.reason)
      await update($, agentsAtom, list => list.map(a => (a.id === e.agentId ? { ...a, status, endedAt } : a)))
      live?.recordsSoon()
    } else {
      isTurnRunning = false
      void live?.wake()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const key = e.turnId + ':' + e.index
    const effort = e.effort === undefined ? '' : String(e.effort)
    const agent = e.agentId ?? ''
    if (!agent) lastModel = e.model
    const row: StepRow = {
      key, model: e.model, effort, agent, startedAt, ms: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, stop: '', window: contextWindow,
    }
    await update($, stepsAtom, list => capped(list, row, MAX_STEPS))
    const result = yield* next(e)
    const ms = (await $.clock.now()) - startedAt
    const usage = result.usage
    const done = {
      ms,
      model: usage?.model ?? e.model,
      input: usage?.input_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      stop: result.stopReason ?? '',
    }
    await update($, stepsAtom, list => list.map(r => (r.key === key ? { ...r, ...done } : r)))
    // An agent's tokens are its latest request's context, as the workflow bar counts them (summing every request
    // would count the cached conversation again on each one); its output is summed, as nothing re-reads it.
    if (e.agentId && usage) {
      const context = contextTokens(usage)
      await update($, agentsAtom, list =>
        list.map(a => (a.id === e.agentId ? { ...a, tokens: context, output: (a.output || 0) + usage.output_tokens } : a)),
      )
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (result.skip === undefined) {
      const at = await $.clock.now()
      const row: Compaction = { at, trigger: e.trigger, before: result.tokensBefore ?? 0, after: result.tokensAfter ?? 0, agent: e.agentId ?? '' }
      await update($, compactionsAtom, list => capped(list, row, MAX_COMPACTIONS))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const k = $.ui.resolve(e) as unknown as Kit
    const { Box, Text } = k
    const [area, debugView, workView, selected, phase, isActive, now, git, ci, agents, runs, tools, steps, compactions, sessions] =
      await Promise.all([
        read($, areaAtom), read($, debugViewAtom), read($, workViewAtom), read($, selectedAtom), read($, phaseAtom), read($, isActiveAtom),
        read($, nowAtom), read($, gitAtom), read($, ciAtom), read($, agentsAtom), read($, runsAtom), read($, toolsAtom), read($, stepsAtom),
        read($, compactionsAtom), read($, sessionsAtom),
      ])
    const [statsName, stats, showAllFiles, diff, pack] = await Promise.all([
      read($, statsNameAtom), read($, statsAtom), read($, showAllFilesAtom), read($, diffAtom), read($, packAtom),
    ])
    const gitNav = {
      showAll: showAllFiles,
      toggleAll: () => void update($, showAllFilesAtom, v => !v),
      diff,
      openDiff: (f: FileChange) => void live?.openDiff(f),
      fetch: () => void live?.fetch(),
      openDiffPane: () => void $.command.run({ command: 'diff' }),
    }
    const width = e.props.bodyColumns
    const busy: Badge = { char: spinner(now), color: ACCENT }
    const isPackBroken = !!pack?.layers.some(l => l.state === 'refused' || l.state === 'broken')
    const othersBusy = sessionGroups(sessions, selfId, cwd, now).here.filter(b => b.id !== selfId && b.isBusy).length
    const badges: Record<Area, Badge | null> = {
      now: othersBusy ? { char: String(othersBusy), color: 'warning' } : null,
      code: ci?.checks.some(c => c.bucket === 'fail') ? { char: '✗', color: 'error' } : ci?.checks.some(c => c.bucket === 'pending') ? busy : null,
      work: agents.some(a => a.status === 'running') ? busy : null,
      timeline: null,
      debug: tools.some(t => t.outcome === 'error') || isPackBroken ? { char: '•', color: 'error' } : null,
    }
    const nav = {
      phase,
      pickPhase: (t: string) => void update($, phaseAtom, () => t),
      run: selected.work,
      pickRun: (key: string) => {
        void update($, selectedAtom, s => ({ ...s, work: key }))
        void update($, phaseAtom, () => '')
      },
    }
    const def = areaDef(area)
    const debugData = { tools, steps, compactions, agents }
    const views: Record<Area, string> = { now: 'sessions', code: 'git', work: workView, timeline: '', debug: debugView }
    const pickView = (view: string) => {
      if (area === 'work') void update($, workViewAtom, () => view as WorkView).then(() => live?.refresh('work'))
      if (area === 'debug') void update($, debugViewAtom, () => view as DebugView)
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        {/* Claude Code draws a pane's title only as a tab beside other panes, so the pane names itself. */}
        <Box key="title" flexDirection="row">
          <Text color={ACCENT} weight="bold">
            ✻{' '}
          </Text>
          <Text dimColor>{paneTitle(TITLE, $.plugin.root)}</Text>
        </Box>
        {AreaBar(k, area, badges, a => void live?.showArea({ area: a }), () => void live?.refresh(area))}
        <Text color={ACCENT} dimColor>
          {'─'.repeat(Math.max(1, width - 2))}
        </Text>
        {def.views.length > 1 && ViewBar(k, def.views, views[area], pickView, area === 'debug' ? debugCounts(debugData) : {})}
        {area === 'now' && SessionsView(k, sessions, selfId, cwd, now)}
        {area === 'code' && GitView(k, git, ci, now, width - 2, !isActive, gitNav)}
        {area === 'work' && workView === 'runs' && AgentsPanel(k, agents, runs, now, width - 2, nav)}
        {area === 'work' && workView === 'stats' && StatsView(k, stats, statsName, width - 2, n => void update($, statsNameAtom, () => n))}
        {area === 'debug' && debugView !== 'pack' && DebugPanel(k, debugView, debugData, now, width - 2)}
        {area === 'debug' && debugView === 'pack' && PackView(k, pack, now, { toggleTrust: () => void live?.setTrust(!pack?.trust.isTrusted) })}
      </Box>
    )
  })
}
