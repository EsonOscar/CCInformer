import type { EngineInterface } from 'claude-code'

import type { AgentRow, RunSummary, WorkflowRun } from '../../types'
import { isFinished } from '../phases'
import { listRecordFiles, readText } from '../read-records'
import { mergeRecord, recordKey, runFromRecord } from '../records'
import { LISTED_STATES, isOver, pruneAgents } from '../rows'
import { summarizeRun } from '../stats'

// How many agents and runs the state keeps.
export const MAX_AGENTS = 300
export const MAX_RUNS = 12
// How many recent sessions, and how many of their records, the run history reads.
const HISTORY_SESSIONS = 12
const HISTORY_RECORDS = 8

// What the runs take from the session: this project's folder under Claude Code's projects, this session's id, and the
// runs and agents as the state holds them (the atoms live in the hooks module, so they're read and written through
// these).
export type RunDeps = {
  projectsDir: string
  selfId: string
  runs: () => Promise<WorkflowRun[]>
  saveRuns: (change: (list: WorkflowRun[]) => WorkflowRun[]) => Promise<unknown>
  saveAgents: (change: (list: AgentRow[]) => AgentRow[]) => Promise<unknown>
  saveStats: (stats: RunSummary[]) => Promise<unknown>
}

export type Runs = {
  // Subagents the session lists; workflow agents aren't listed, their turn.complete and run record end them.
  pollAgents: () => Promise<void>
  // A run this session started is finished once Claude Code has written its record: take its status and totals.
  checkRecords: () => Promise<void>
  // Finished runs from this project's recent sessions, newest first, read once each.
  loadHistory: () => Promise<void>
  // Every finished run in this project, for the Stats view: each record is read once, again only when it changes.
  loadStats: () => Promise<void>
}

// Work › Runs and Stats: the workflow runs and agents, from what the session lists and the run records Claude Code
// writes under this project's sessions.
export function createRuns($: EngineInterface, deps: RunDeps): Runs {
  // Records already read, by path, with the mtime they were read at.
  const readRecords = new Map<string, number>()
  const statsCache = new Map<string, { mtime: number; summary: RunSummary | null }>()
  const sessionOf = (session: string) => (session === deps.selfId ? '' : session.slice(0, 8))

  return {
    pollAgents: async () => {
      const listed = await $.agent.list()
      if (listed.length === 0) return
      const byId = new Map(listed.map(a => [a.id, LISTED_STATES[a.status]]))
      const now = await $.clock.now()
      await deps.saveAgents(list =>
        list.map(a => {
          const status = byId.get(a.id)
          if (!status || status === a.status) return a
          return { ...a, status, endedAt: isOver(status) ? a.endedAt || now : 0 }
        }),
      )
    },
    checkRecords: async () => {
      const runs = await deps.runs()
      for (const run of runs.filter(r => !r.session && r.runId && !isFinished(r))) {
        const path = `${deps.projectsDir}/${deps.selfId}/workflows/${run.runId}.json`
        if (!(await $.fs.exists(path))) continue
        const record = runFromRecord(await readText($, path), run.toolUseId, '')
        if (!record || !isFinished(record.run)) continue
        const done = { ...record.run, phases: record.run.phases.length ? record.run.phases : run.phases }
        await deps.saveRuns(list => list.map(r => (r.toolUseId === run.toolUseId ? done : r)))
        await deps.saveAgents(list => mergeRecord(list, record))
        readRecords.set(path, Number.MAX_SAFE_INTEGER)
      }
    },
    loadHistory: async () => {
      const fresh = (await listRecordFiles($, deps.projectsDir, HISTORY_SESSIONS))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, HISTORY_RECORDS)
        .filter(f => (readRecords.get(f.path) ?? -1) < f.mtime)
      for (const f of fresh) {
        readRecords.set(f.path, f.mtime)
        const runs = await deps.runs()
        const runId = f.path.split('/').pop()?.replace(/\.json$/, '') ?? ''
        if (runs.some(r => r.runId === runId)) continue
        const record = runFromRecord(await readText($, f.path), recordKey(runId), sessionOf(f.session))
        if (!record) continue
        const kept = [...runs, record.run].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_RUNS)
        await deps.saveRuns(() => kept)
        await deps.saveAgents(list => pruneAgents([...list, ...record.agents], kept).slice(-MAX_AGENTS))
      }
    },
    loadStats: async () => {
      let isChanged = false
      for (const f of await listRecordFiles($, deps.projectsDir)) {
        if (statsCache.get(f.path)?.mtime === f.mtime) continue
        const record = runFromRecord(await readText($, f.path), recordKey(f.name.replace(/\.json$/, '')), sessionOf(f.session))
        statsCache.set(f.path, { mtime: f.mtime, summary: record ? summarizeRun(record) : null })
        isChanged = true
      }
      if (!isChanged) return
      const summaries = [...statsCache.values()].flatMap(c => (c.summary ? [c.summary] : []))
      await deps.saveStats(summaries.sort((a, b) => a.startedAt - b.startedAt))
    },
  }
}
