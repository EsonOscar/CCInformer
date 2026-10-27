import type { AgentRow, WorkflowRun } from '../types'
import { phaseOf } from './parse'

// A workflow run grouped into its phases, with what each one cost. Plain functions, so the tests can feed them rows.

export const OTHER_PHASE = 'Other'

export type PhaseState = 'pending' | 'running' | 'done' | 'failed'
export type Phase = {
  title: string
  agents: AgentRow[]
  state: PhaseState
  startedAt: number
  endedAt: number
  tokens: number
  output: number
  tools: number
}
export type RunTotals = {
  state: 'running' | 'waiting' | 'done' | 'failed'
  agents: number
  tokens: number
  output: number
  tools: number
  endedAt: number
}

export const isLive = (a: AgentRow): boolean => a.status === 'running' || a.status === 'waiting'
export const isFinished = (run: WorkflowRun): boolean => run.status !== '' && run.status !== 'running'

// A count an older row lacks (one recorded before the mod counted it) adds nothing.
const sum = (agents: AgentRow[], pick: (a: AgentRow) => number) => agents.reduce((n, a) => n + (pick(a) || 0), 0)

const stateOf = (agents: AgentRow[]): PhaseState =>
  agents.length === 0 ? 'pending' : agents.some(isLive) ? 'running' : agents.some(a => a.status === 'failed') ? 'failed' : 'done'

const phase = (title: string, agents: AgentRow[]): Phase => {
  const state = stateOf(agents)
  return {
    title,
    agents,
    state,
    startedAt: agents.length ? Math.min(...agents.map(a => a.startedAt)) : 0,
    endedAt: state === 'done' || state === 'failed' ? Math.max(...agents.map(a => a.endedAt)) : 0,
    tokens: sum(agents, a => a.tokens),
    output: sum(agents, a => a.output),
    tools: sum(agents, a => a.tools),
  }
}

export const agentsOf = (agents: AgentRow[], run: WorkflowRun): AgentRow[] => agents.filter(a => a.toolUseId === run.toolUseId)

// The script's phases in order, each with its agents: by the run record's phase where it has one, else by the label.
// A finished run leaves out phases nothing ran in (a re-check runs only its critics); agents no phase claims go under Other.
export const phasesOf = (run: WorkflowRun, agents: AgentRow[]): Phase[] => {
  const groups = run.phases.map(title => ({ title, agents: [] as AgentRow[] }))
  const other: AgentRow[] = []
  for (const a of agents) {
    const title = a.phase && run.phases.includes(a.phase) ? a.phase : phaseOf(a.description, run.phases)
    const group = groups.find(g => g.title === title)
    if (group) group.agents.push(a)
    else other.push(a)
  }
  const ran = isFinished(run) ? groups.filter(g => g.agents.length) : groups
  const phases = ran.map(g => phase(g.title, g.agents))
  return other.length ? [...phases, phase(OTHER_PHASE, other)] : phases
}

// How long a phase has run, or ran.
export const phaseElapsed = (p: Phase, now: number): number => (p.startedAt ? (p.endedAt || now) - p.startedAt : 0)

// The run as a whole. Its record, once written, says how it ended and what it cost; until then: running while an
// agent runs, waiting between phases.
export const totalsOf = (run: WorkflowRun, phases: Phase[]): RunTotals => {
  const agents = phases.flatMap(p => p.agents)
  const counts = { agents: agents.length, tokens: sum(agents, a => a.tokens), output: sum(agents, a => a.output), tools: sum(agents, a => a.tools) }
  if (isFinished(run)) {
    const isOk = run.status === 'completed' && !phases.some(p => p.state === 'failed')
    return { ...counts, state: isOk ? 'done' : 'failed', tokens: run.totalTokens || counts.tokens, endedAt: run.endedAt }
  }
  return { ...counts, state: phases.some(p => p.state === 'running') ? 'running' : 'waiting', endedAt: 0 }
}

// The phase the detail shows: the pinned one while the run has it, else the running one, else the last one that ran.
export const shownPhase = (phases: Phase[], pinned: string): number => {
  const pin = pinned ? phases.findIndex(p => p.title === pinned) : -1
  if (pin >= 0) return pin
  const running = phases.findIndex(p => p.state === 'running')
  if (running >= 0) return running
  return Math.max(0, phases.map(p => p.state !== 'pending').lastIndexOf(true))
}

// The run the Agents tab shows in full: the one picked, else the newest still running; none once all have finished.
export const shownRun = (runs: WorkflowRun[], picked: string): WorkflowRun | null =>
  runs.find(r => r.toolUseId === picked) ?? [...runs].reverse().find(r => !isFinished(r)) ?? null
