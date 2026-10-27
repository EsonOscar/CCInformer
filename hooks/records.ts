import type { AgentRow, AgentState, WorkflowRun } from '../types'
import { parseJson } from './parse'

// Claude Code writes a record of each finished workflow run to
// <config>/projects/<project>/<session id>/workflows/<run id>.json. These read it.

// The project folder's name: the working directory with every character but letters and digits made a '-'.
export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export const recordKey = (runId: string): string => 'rec:' + runId

const AGENT_STATES: Record<string, AgentState> = {
  running: 'running',
  queued: 'running',
  done: 'done',
  completed: 'done',
  failed: 'failed',
  error: 'failed',
  killed: 'killed',
  cancelled: 'killed',
  skipped: 'killed',
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export type RunRecord = { run: WorkflowRun; agents: AgentRow[] }

// A record as the pane's run and agent rows. `toolUseId` links the agents to the run: the Workflow call's id when
// this session started it, else `rec:<runId>`. `session` is '' for this session's own runs.
export const runFromRecord = (text: string, toolUseId: string, session: string): RunRecord | null => {
  const j = parseJson(text) as Record<string, unknown> | undefined
  if (!j || typeof j.runId !== 'string') return null
  const runId = j.runId
  const startedAt = num(j.startTime)
  const progress = Array.isArray(j.workflowProgress) ? (j.workflowProgress as Record<string, unknown>[]) : []
  const agents: AgentRow[] = progress
    .filter(e => e.type === 'workflow_agent')
    .map(e => {
      const started = num(e.startedAt) || startedAt
      return {
        id: str(e.agentId) || `${runId}:${num(e.index)}`,
        description: str(e.label),
        type: 'workflow',
        model: str(e.model),
        status: AGENT_STATES[str(e.state)] ?? 'done',
        startedAt: started,
        endedAt: started + num(e.durationMs),
        toolUseId,
        runId,
        phase: str(e.phaseTitle),
        tools: num(e.toolCalls),
        tokens: num(e.tokens),
        output: 0,
      }
    })
  const phases = Array.isArray(j.phases) ? (j.phases as Record<string, unknown>[]).map(p => str(p.title)).filter(Boolean) : []
  const run: WorkflowRun = {
    toolUseId,
    runId,
    name: str(j.workflowName) || 'workflow',
    phases,
    startedAt,
    status: str(j.status) || 'completed',
    endedAt: startedAt + num(j.durationMs),
    totalTokens: num(j.totalTokens),
    session,
  }
  return { run, agents }
}

// Folds a finished run's record into the rows the session recorded live: the record's status, totals and phases
// win; the live rows keep what only they know (output tokens).
export const mergeRecord = (live: AgentRow[], record: RunRecord): AgentRow[] => {
  const byId = new Map(record.agents.map(a => [a.id, a]))
  const merged = live.map(a => {
    const r = byId.get(a.id)
    if (!r) return a.runId === record.run.runId && a.status === 'running' ? { ...a, status: 'done' as AgentState } : a
    byId.delete(a.id)
    return { ...a, status: r.status, phase: r.phase, tokens: r.tokens || a.tokens, tools: r.tools || a.tools, endedAt: r.endedAt || a.endedAt }
  })
  return [...merged, ...byId.values()]
}

// A run recorded before the mod kept a status: finished once all its agents have ended, at the last one's end.
export const upgradeRun = (run: WorkflowRun, agents: AgentRow[]): WorkflowRun => {
  if (typeof run.status === 'string') return run
  const mine = agents.filter(a => a.toolUseId === run.toolUseId)
  const isOver = mine.length > 0 && mine.every(a => a.status !== 'running' && a.status !== 'waiting')
  return {
    ...run,
    runId: run.runId ?? '',
    status: isOver ? 'completed' : 'running',
    endedAt: isOver ? Math.max(...mine.map(a => a.endedAt)) : 0,
    totalTokens: 0,
    session: '',
  }
}

// `.git/HEAD` → the branch (or the short commit when detached); a worktree's `.git` file → the folder holding HEAD.
export const parseHead = (text: string): { branch: string; gitdir: string } => {
  const t = text.trim()
  if (t.startsWith('gitdir:')) return { branch: '', gitdir: t.slice(7).trim() }
  if (t.startsWith('ref: refs/heads/')) return { branch: t.slice(16), gitdir: '' }
  return { branch: t.slice(0, 7), gitdir: '' }
}
