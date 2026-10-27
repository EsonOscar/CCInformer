import type { AgentSample, RunSummary } from '../types'
import type { RunRecord } from './records'

// Workflow statistics over the run records: plain functions, so the tests can feed them runs.

// opus / sonnet / haiku / fable, else the model as named.
export const modelFamily = (model: string): string => /opus|sonnet|haiku|fable/.exec(model)?.[0] ?? (model || 'unknown')

// A record boiled down to what the statistics need: the run, how long each phase took, and each agent as a sample.
export const summarizeRun = (record: RunRecord): RunSummary => {
  const { run, agents } = record
  const phasesRan = run.phases.filter(p => agents.some(a => a.phase === p))
  const spans = phasesRan.map(title => {
    const mine = agents.filter(a => a.phase === title)
    return { title, ms: Math.max(...mine.map(a => a.endedAt)) - Math.min(...mine.map(a => a.startedAt)) }
  })
  const samples: AgentSample[] = agents.map(a => ({
    phase: a.phase,
    family: modelFamily(a.model),
    // An agent replayed from the workflow's cache has no time of its own.
    ms: a.endedAt > a.startedAt ? a.endedAt - a.startedAt : 0,
    tokens: a.tokens,
    tools: a.tools,
  }))
  return {
    runId: run.runId,
    name: run.name,
    session: run.session,
    startedAt: run.startedAt,
    ms: run.endedAt - run.startedAt,
    tokens: run.totalTokens,
    status: run.status,
    phases: run.phases,
    phasesRan,
    spans,
    agents: samples,
  }
}

// A run that ran all its phases; the rest (a plan-fanout re-check runs only its critics) are counted apart.
export const isFull = (r: RunSummary): boolean => r.phasesRan.length > 0 && r.phasesRan.length === r.phases.length

const mean = (values: number[]): number => (values.length ? values.reduce((n, v) => n + v, 0) / values.length : 0)

// `agents` counts every agent; `ran` those that ran rather than being replayed from the workflow's cache, which
// alone give `ms` and `tokens` (a replayed agent has neither).
export type ModelStats = { family: string; agents: number; ran: number; ms: number; tokens: number }
export type PhaseStats = { title: string; ms: number; share: number; agents: number; models: ModelStats[] }
export type GroupStats = { runs: number; ms: number; tokens: number; agents: number }
export type WorkflowStats = {
  name: string
  runs: RunSummary[]
  full: GroupStats
  partial: GroupStats
  // The full runs' durations, oldest first.
  trend: number[]
  phases: PhaseStats[]
}

const group = (runs: RunSummary[]): GroupStats => ({
  runs: runs.length,
  ms: mean(runs.map(r => r.ms)),
  tokens: mean(runs.map(r => r.tokens)),
  agents: mean(runs.map(r => r.agents.length)),
})

// Per agent and per model, averaged over the agents that ran.
const modelStats = (samples: AgentSample[]): ModelStats[] => {
  const families = [...new Set(samples.map(s => s.family))]
  return families
    .map(family => {
      const mine = samples.filter(s => s.family === family)
      const ran = mine.filter(s => s.ms > 0)
      return { family, agents: mine.length, ran: ran.length, ms: mean(ran.map(s => s.ms)), tokens: mean(ran.map(s => s.tokens)) }
    })
    .sort((a, b) => b.agents - a.agents)
}

// One workflow's runs summed up: full runs and partial ones apart, each phase of the full runs with its share of
// their time, and per phase how each model's agents did (all runs, since a re-check's critics are critics too).
export const statsFor = (summaries: RunSummary[], name: string): WorkflowStats => {
  const runs = summaries.filter(r => r.name === name && r.status === 'completed').sort((a, b) => a.startedAt - b.startedAt)
  const full = runs.filter(isFull)
  const titles = [...new Set(runs.flatMap(r => r.phases))]
  const fullTime = full.reduce((n, r) => n + r.ms, 0)
  const phases = titles.map(title => {
    const spans = full.map(r => r.spans.find(s => s.title === title)?.ms ?? 0)
    const samples = runs.flatMap(r => r.agents.filter(a => a.phase === title))
    return {
      title,
      ms: mean(spans),
      share: fullTime ? spans.reduce((n, v) => n + v, 0) / fullTime : 0,
      agents: mean(full.map(r => r.agents.filter(a => a.phase === title).length)),
      models: modelStats(samples),
    }
  })
  return { name, runs, full: group(full), partial: group(runs.filter(r => !isFull(r))), trend: full.map(r => r.ms), phases }
}

// The workflows with runs, most runs first.
export const workflowNames = (summaries: RunSummary[]): string[] => {
  const counts = new Map<string, number>()
  for (const r of summaries) counts.set(r.name, (counts.get(r.name) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}
