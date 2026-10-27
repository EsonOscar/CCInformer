import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type {
  AgentRow, AgentsView, CiSnapshot, Compaction, DebugView, DiffPreview, FileChange, GitSnapshot, RunSummary, SessionBeat, StepRow, Tab,
  ToolOutcome, ToolRow, WorkflowRun,
} from '../types'
import { collectCi, collectDiff, collectGit } from './collect'
import type { Exec } from './collect'
import { paneTitle, spinner } from './format'
import { ciOutcome, sessionGroups } from './insight'
import { OPERATION_MARKERS, parseWorkflowMeta, previewDiff, previewNewFile } from './parse'
import { isFinished } from './phases'
import { mergeRecord, parseHead, projectDirName, recordKey, runFromRecord, upgradeRun } from './records'
import {
  LISTED_STATES, TOUCHING_TOOLS, capped, contextTokens, endedState, isOver, isPush, pruneAgents, summarize, taskOf, toolLabel,
} from './rows'
import { ACCENT } from './ui'
import type { Kit } from './ui'
import { AgentsView as AgentsPanel } from './view-agents'
import { DebugPanel } from './view-debug'
import { GitView } from './view-git'
import { SessionsView } from './view-sessions'
import { summarizeRun } from './stats'
import { StatsView } from './view-stats'

const PANE = 'ccinformer'
const TITLE = 'CCInformer'
// The command, and a short alias that runs the same handler.
const COMMAND = 'ccinformer'
const ALIAS = 'side'
const ARGUMENT_HINT = '[git|agents|sessions|debug]'
// The pane asks for a quarter of the terminal, never less than this; a width the person drags to wins.
const SHARE = 0.25
const MIN_COLUMNS = 40
const STORE_TAB = 'tab'
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
const RUN_TIMEOUT_MS = 20_000
const FETCH_TIMEOUT_MS = 60_000
const CI_PINGS_KEPT = 20
const BEAT_FORGOTTEN_MS = 24 * 60 * 60_000
const HISTORY_SESSIONS = 12
const HISTORY_RECORDS = 8
const STATS_EVERY_TICKS = 120

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'git', label: 'Git', hotkey: '1' },
  { id: 'agents', label: 'Agents', hotkey: '2' },
  { id: 'sessions', label: 'Sessions', hotkey: '3' },
  { id: 'debug', label: 'Debug', hotkey: '4' },
]
const isTab = (v: unknown): v is Tab => TABS.some(t => t.id === v)

// What the pane draws from. Kept in $.state, so a write redraws the pane and a hot reload keeps it.
const tabAtom = atom({ plugin: 'ccinformer', key: 'tab' } as const, 'git' as Tab)
const debugViewAtom = atom({ plugin: 'ccinformer', key: 'debugView' } as const, 'tools' as DebugView)
const phaseAtom = atom({ plugin: 'ccinformer', key: 'phase' } as const, '')
const runAtom = atom({ plugin: 'ccinformer', key: 'run' } as const, '')
const agentsViewAtom = atom({ plugin: 'ccinformer', key: 'agentsView' } as const, 'runs' as AgentsView)
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
  refresh: (tab: Tab) => Promise<void>
  showTab: (tab: Tab) => Promise<void>
  touched: () => void
  pushed: () => void
  wake: () => Promise<void>
  recordsSoon: () => void
  openDiff: (file: FileChange) => Promise<void>
  fetch: () => Promise<void>
}
let live: Live | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Toggle the CCInformer pane: git and CI, agents and workflows, sessions, debug',
      argumentHint: ARGUMENT_HINT,
      immediate: true,
    })
    await $.command.register({
      name: ALIAS,
      description: `Short for /${COMMAND}: toggle the CCInformer pane`,
      argumentHint: ARGUMENT_HINT,
      immediate: true,
    })
    const tab = await $.store.get(STORE_TAB)
    if (isTab(tab)) await update($, tabAtom, () => tab)
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

    const exec: Exec = argv => $.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS })
    let ticks = 0
    let isGitBusy = false
    let isCiBusy = false
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
    const refreshCi = async () => {
      const git = await read($, gitAtom)
      if (isCiBusy || !git || git.error) return
      isCiBusy = true
      try {
        const prev = await read($, ciAtom)
        const ci = await collectCi(exec, git.branch, git.head, await $.clock.now())
        await update($, ciAtom, () => ci)
        await pingCi(prev, ci)
      } finally {
        isCiBusy = false
      }
    }
    const refreshGit = async () => {
      if (isGitBusy) return
      isGitBusy = true
      try {
        const before = await read($, gitAtom)
        const collected = await collectGit(exec, await $.clock.now())
        const git = collected.gitDir ? { ...collected, ...(await gitFolderFacts(collected.gitDir)) } : collected
        await update($, gitAtom, () => git)
        // An open diff follows its file, and closes once the file is no longer changed (committed, reverted).
        const diff = await read($, diffAtom)
        const changed = diff && !diff.isLoading ? git.files.find(f => f.path === diff.path) : undefined
        if (diff && !diff.isLoading && !changed) await update($, diffAtom, () => null)
        if (changed) void loadDiff(changed, git.root)
        if (!before || before.branch !== git.branch || before.head !== git.head) await refreshCi()
      } finally {
        isGitBusy = false
      }
    }
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
    const tick = async () => {
      const now = await $.clock.now()
      ticks += 1
      const active = isActive(now)
      if ((await read($, isActiveAtom)) !== active) await update($, isActiveAtom, () => active)
      if (ticks % BEAT_EVERY_TICKS === 0) await beat(now)
      if (ticks % RECORDS_EVERY_TICKS === 0) await checkRecords()
      const ci = await read($, ciAtom)
      const isCiLive = now < ciHotUntil || (ci?.checks.some(c => c.bucket === 'pending') ?? false)
      if (isCiLive && ticks % CI_LIVE_EVERY_TICKS === 0) await refreshCi()
      if (!(await read($, isOpenAtom))) return
      await update($, nowAtom, () => now)
      if (ticks % AGENTS_EVERY_TICKS === 0) await pollAgents()
      const tab = await read($, tabAtom)
      if (tab === 'git' && active && ticks % GIT_EVERY_TICKS === 0) await refreshGit()
      if (tab === 'git' && active && !isCiLive && ticks % CI_IDLE_EVERY_TICKS === 0) await refreshCi()
      if (tab === 'agents' && ticks % HISTORY_EVERY_TICKS === 0) await loadHistory()
      if (tab === 'agents' && ticks % STATS_EVERY_TICKS === 0 && (await read($, agentsViewAtom)) === 'stats') await loadStats()
      if (tab === 'sessions' && ticks % SESSIONS_EVERY_TICKS === 0) await readSessions()
    }
    const refresh = async (t: Tab) => {
      if (t === 'git') await refreshGit().then(refreshCi)
      if (t === 'agents') await checkRecords().then(loadHistory)
      if (t === 'agents' && (await read($, agentsViewAtom)) === 'stats') await loadStats()
      if (t === 'sessions') await beat(await $.clock.now()).then(readSessions)
    }

    live = {
      refresh,
      showTab: async t => {
        await update($, tabAtom, () => t)
        await $.store.set(STORE_TAB, t)
        await refresh(t)
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
        if ((await read($, isOpenAtom)) && (await read($, tabAtom)) === 'git') await refreshGit()
      },
      // Pressing a file shows its diff under it; pressing it again hides it.
      openDiff: async file => {
        const shown = await read($, diffAtom)
        if (shown?.path === file.path) {
          await update($, diffAtom, () => null)
          return
        }
        await update($, diffAtom, () => ({ path: file.path, text: '', isLoading: true }))
        await loadDiff(file, (await read($, gitAtom))?.root ?? '.')
      },
      // The person asked for a fetch: refresh what the upstream has, then the tab.
      fetch: async () => {
        $.ui.toast('Fetching…')
        const fetched = await $.process.run(['git', 'fetch', '--quiet'], { timeoutMs: FETCH_TIMEOUT_MS }).catch(() => null)
        $.ui.toast(fetched?.exitCode === 0 ? 'Fetched' : 'Fetch failed: ' + (fetched?.stderr.trim().split('\n')[0] || 'git did not answer'))
        await refreshGit()
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

    // Reopen where it was left; the engine seats a pane opened unasked only in a wide terminal.
    if ((await $.store.get(STORE_OPEN)) === true) {
      const columns = Number(await $.store.get(STORE_COLUMNS)) || MIN_COLUMNS
      await $.ui.open({ id: PANE, title: paneTitle(TITLE, $.plugin.root), columns })
      await update($, isOpenAtom, () => true)
      void refresh(await read($, tabAtom))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear or /resume keeps the session's process; only a real end takes it off the Sessions tab.
    if (selfId && e.reason !== 'clear' && e.reason !== 'resume') await $.store.delete(STORE_SESSION + selfId)
    return next(e)
  })

  // Both names run this; every other command passes through untouched.
  on('command.run', async ($, e, next) => {
    if (e.command !== COMMAND && e.command !== ALIAS) return next(e)
    const arg = e.args.trim().toLowerCase()
    void live?.wake()
    if (isTab(arg)) {
      await update($, tabAtom, () => arg)
      await $.store.set(STORE_TAB, arg)
    }
    if ((await read($, isOpenAtom)) && !isTab(arg)) {
      await $.ui.close({ id: PANE })
      await update($, isOpenAtom, () => false)
      await $.store.set(STORE_OPEN, false)
      return {}
    }
    const columns = Math.max(MIN_COLUMNS, Math.round(e.presentation.columns * SHARE))
    await $.ui.open({ id: PANE, title: paneTitle(TITLE, $.plugin.root), columns })
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    await update($, isOpenAtom, () => true)
    await $.store.set(STORE_OPEN, true)
    await $.store.set(STORE_COLUMNS, columns)
    void live?.refresh(await read($, tabAtom))
    return {}
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
      await update($, runAtom, () => '')
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
    const [tab, view, phase, run, isActive, now, git, ci, agents, runs, tools, steps, compactions, sessions] = await Promise.all([
      read($, tabAtom), read($, debugViewAtom), read($, phaseAtom), read($, runAtom), read($, isActiveAtom), read($, nowAtom),
      read($, gitAtom), read($, ciAtom), read($, agentsAtom), read($, runsAtom), read($, toolsAtom), read($, stepsAtom),
      read($, compactionsAtom), read($, sessionsAtom),
    ])
    const [agentsView, statsName, stats, showAllFiles, diff] = await Promise.all([
      read($, agentsViewAtom), read($, statsNameAtom), read($, statsAtom), read($, showAllFilesAtom), read($, diffAtom),
    ])
    const gitNav = {
      showAll: showAllFiles,
      toggleAll: () => void update($, showAllFilesAtom, v => !v),
      diff,
      openDiff: (f: FileChange) => void live?.openDiff(f),
      fetch: () => void live?.fetch(),
      openDiffPane: () => void $.command.run({ command: 'diff' }),
    }
    const pickAgentsView = (v: AgentsView) => {
      void update($, agentsViewAtom, () => v).then(() => live?.refresh('agents'))
    }
    const width = e.props.bodyColumns
    const busy: Badge = { char: spinner(now), color: ACCENT }
    const othersBusy = sessionGroups(sessions, selfId, cwd, now).here.filter(b => b.id !== selfId && b.isBusy).length
    const badges: Record<Tab, Badge | null> = {
      git: ci?.checks.some(c => c.bucket === 'fail') ? { char: '✗', color: 'error' } : ci?.checks.some(c => c.bucket === 'pending') ? busy : null,
      agents: agents.some(a => a.status === 'running') ? busy : null,
      sessions: othersBusy ? { char: String(othersBusy), color: 'warning' } : null,
      debug: tools.some(t => t.outcome === 'error') ? { char: '•', color: 'error' } : null,
    }
    const nav = {
      phase,
      pickPhase: (t: string) => void update($, phaseAtom, () => t),
      run,
      pickRun: (key: string) => {
        void update($, runAtom, () => key)
        void update($, phaseAtom, () => '')
      },
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
        {Header(k, tab, badges, t => void live?.showTab(t), () => void live?.refresh(tab))}
        <Text color={ACCENT} dimColor>
          {'─'.repeat(Math.max(1, width - 2))}
        </Text>
        {tab === 'git' && GitView(k, git, ci, now, width - 2, !isActive, gitNav)}
        {tab === 'agents' && SubViews(k, agentsView, pickAgentsView)}
        {tab === 'agents' && agentsView === 'runs' && AgentsPanel(k, agents, runs, now, width - 2, nav)}
        {tab === 'agents' && agentsView === 'stats' && StatsView(k, stats, statsName, width - 2, n => void update($, statsNameAtom, () => n))}
        {tab === 'sessions' && SessionsView(k, sessions, selfId, cwd, now)}
        {tab === 'debug' &&
          DebugPanel(k, view, { tools, steps, compactions, agents }, now, width - 2, v => void update($, debugViewAtom, () => v))}
      </Box>
    )
  })
}

type Badge = { char: string; color: typeof ACCENT }

const AGENTS_VIEWS: { id: AgentsView; label: string; hotkey: string }[] = [
  { id: 'runs', label: 'Runs', hotkey: 'w' },
  { id: 'stats', label: 'Stats', hotkey: 's' },
]

// The Agents tab's two views: the runs as they happen, and statistics over every finished run.
const SubViews = (k: Kit, view: AgentsView, pick: (v: AgentsView) => void): JSX.Element => {
  const { Box, Button, Text } = k
  return (
    <Box flexDirection="row" columnGap={2} marginTop={1}>
      {AGENTS_VIEWS.map(v => (
        <Button key={'agents-' + v.id} plain hotkey={v.hotkey} onPress={() => pick(v.id)}>
          <Text color={view === v.id ? ACCENT : 'text'} weight={view === v.id ? 'semibold' : 'regular'} dimColor={view !== v.id}>
            {v.label}
          </Text>
        </Button>
      ))}
    </Box>
  )
}

const Header = (k: Kit, tab: Tab, badges: Record<Tab, Badge | null>, pick: (id: Tab) => void, refresh: () => void): JSX.Element => {
  const { Box, Button, Text } = k
  return (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap">
      {TABS.map(t => {
        const badge = badges[t.id]
        return (
          <Button key={'tab-' + t.id} plain hotkey={t.hotkey} onPress={() => pick(t.id)}>
            <Text color={tab === t.id ? ACCENT : 'text'} weight={tab === t.id ? 'semibold' : 'regular'} dimColor={tab !== t.id}>
              {t.label}
            </Text>
            {badge && <Text color={badge.color}>{' ' + badge.char}</Text>}
          </Button>
        )
      })}
      <Box flexGrow={1} />
      <Button key="refresh" plain hotkey="r" onPress={refresh}>
        <Text dimColor>⟳</Text>
      </Button>
    </Box>
  )
}
