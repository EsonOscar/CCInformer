import type { Color } from 'claude-code'

import type { AgentRow, WorkflowRun } from '../types'
import { ago, duration, shortModel, spinner, tokens } from './format'
import { barSpan } from './insight'
import { agentsOf, isFinished, isLive, phaseElapsed, phasesOf, shownPhase, shownRun, totalsOf } from './phases'
import type { Phase, PhaseState, RunTotals } from './phases'
import { ACCENT, Empty, Line, Section, agentGlyph } from './ui'
import type { Glyph, Kit } from './ui'

const SUBAGENTS_SHOWN = 10
const RUNS_SHOWN = 8
const TIMELINE_ROWS = 24
const PHASE_COLORS: Color[] = [ACCENT, 'suggestion', 'success', 'warning', 'permission', 'planMode', 'ide']

// What the person picked on the tab ('' follows what runs), and how to change it.
export type AgentsNav = { phase: string; pickPhase: (title: string) => void; run: string; pickRun: (key: string) => void }

export const AgentsView = (k: Kit, agents: AgentRow[], runs: WorkflowRun[], now: number, width: number, nav: AgentsNav): JSX.Element => {
  const { Box } = k
  const loose = agents.filter(a => !a.runId && !runs.some(r => r.toolUseId === a.toolUseId))
  const shown = shownRun(runs, nav.run)
  const listed = [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, RUNS_SHOWN)
  return (
    <Box flexDirection="column">
      {shown ? Run(k, shown, agentsOf(agents, shown), now, width, nav) : Section(k, 'Workflow')}
      {!shown && Empty(k, runs.length ? 'No workflow running. Pick a run below to see it.' : 'No workflow has run yet.')}
      {listed.length > 0 && Section(k, 'Runs', String(runs.length))}
      {listed.map(r => RunRow(k, r, agentsOf(agents, r), now, r === shown, nav))}
      {Section(k, 'Subagents', loose.length ? String(loose.length) : '')}
      {loose.length === 0 && Empty(k, 'No subagents yet.')}
      {loose
        .slice(-SUBAGENTS_SHOWN)
        .reverse()
        .map(a => Agent(k, a, now, a.type))}
    </Box>
  )
}

const PHASE_LOOK: Record<PhaseState, { char: string; color: Color }> = {
  pending: { char: '○', color: 'inactive' },
  running: { char: '', color: ACCENT },
  done: { char: '✓', color: 'success' },
  failed: { char: '✗', color: 'error' },
}

const phaseGlyph = (state: PhaseState, now: number): Glyph => {
  const look = PHASE_LOOK[state]
  return { char: look.char || spinner(now), color: look.color }
}

const runGlyph = (totals: RunTotals, now: number): Glyph =>
  totals.state === 'done'
    ? { char: '✓', color: 'success' }
    : totals.state === 'failed'
      ? { char: '✗', color: 'error' }
      : { char: totals.state === 'running' ? spinner(now) : '◌', color: ACCENT }

const runElapsed = (run: WorkflowRun, totals: RunTotals, now: number) => (totals.endedAt || now) - run.startedAt

type Cost = { agents: number; tokens: number; output: number; tools: number }

// "4 agents · 1.2M ctx · ↓48k out · 214⚒": context as the workflow bar counts it, then what the agents generated.
const costLine = (c: Cost) =>
  [
    c.agents ? `${c.agents} agent${c.agents === 1 ? '' : 's'}` : '',
    c.tokens ? tokens(c.tokens) + ' ctx' : '',
    c.output ? '↓' + tokens(c.output) + ' out' : '',
    c.tools ? c.tools + '⚒' : '',
  ]
    .filter(Boolean)
    .join(' · ')

const where = (run: WorkflowRun) => (run.session ? 'session ' + run.session : 'this session')

const Run = (k: Kit, run: WorkflowRun, agents: AgentRow[], now: number, width: number, nav: AgentsNav): JSX.Element => {
  const { Box, Button, Text } = k
  const phases = phasesOf(run, agents)
  const totals = totalsOf(run, phases)
  const glyph = runGlyph(totals, now)
  const note = (
    <Box flexDirection="row" columnGap={1}>
      <Text color={glyph.color}>{glyph.char + ' ' + duration(runElapsed(run, totals, now))}</Text>
      {nav.run && (
        <Button key="run-close" plain hotkey="x" onPress={() => nav.pickRun('')}>
          <Text dimColor>×</Text>
        </Button>
      )}
    </Box>
  )
  const state = totals.state === 'done' ? 'done' : totals.state === 'failed' ? run.status || 'failed' : ''
  return (
    <Box flexDirection="column">
      {Section(k, 'Workflow · ' + run.name, note)}
      <Text dimColor wrap="truncate-end">
        {'  ' + [costLine(totals) || 'starting…', state, isFinished(run) ? where(run) : ''].filter(Boolean).join(' · ')}
      </Text>
      {phases.length > 0 ? PhaseBrowser(k, run, phases, now, width, nav) : agents.map(a => Agent(k, a, now, ''))}
    </Box>
  )
}

// The phases as chips to pick from, the run's timeline, then the picked phase in full.
const PhaseBrowser = (k: Kit, run: WorkflowRun, phases: Phase[], now: number, width: number, nav: AgentsNav): JSX.Element => {
  const { Box, Button, Text } = k
  const index = shownPhase(phases, nav.phase)
  const shown = phases[index] as Phase
  const step = (by: number) => {
    const next = phases[Math.min(phases.length - 1, Math.max(0, index + by))]
    if (next) nav.pickPhase(next.title)
  }
  const glyph = phaseGlyph(shown.state, now)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {phases.map((p, i) => PhaseChip(k, p, i, i === index, now, nav.pickPhase))}
      </Box>
      {Timeline(k, run, phases, index, now, width)}
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key="phase-prev" plain hotkey="p" onPress={() => step(-1)}>
          <Text color={index > 0 ? ACCENT : 'inactive'}>‹</Text>
        </Button>
        <Text color={glyph.color}>{glyph.char}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text weight="semibold" wrap="truncate-end">
            {`${shown.title} · ${index + 1}/${phases.length}`}
          </Text>
        </Box>
        {nav.phase && (
          <Button key="phase-live" plain hotkey="l" onPress={() => nav.pickPhase('')}>
            <Text dimColor>live</Text>
          </Button>
        )}
        <Button key="phase-next" plain hotkey="n" onPress={() => step(1)}>
          <Text color={index < phases.length - 1 ? ACCENT : 'inactive'}>›</Text>
        </Button>
      </Box>
      {PhaseDetail(k, shown, now)}
    </Box>
  )
}

const PhaseChip = (k: Kit, p: Phase, i: number, isShown: boolean, now: number, pick: (title: string) => void): JSX.Element => {
  const { Button, Text } = k
  const glyph = phaseGlyph(p.state, now)
  const live = p.agents.filter(isLive).length
  const count = p.agents.length === 0 ? '' : live ? ` ${p.agents.length - live}/${p.agents.length}` : ` ${p.agents.length}`
  return (
    <Button key={'phase-' + i} plain onPress={() => pick(p.title)}>
      <Text color={PHASE_COLORS[i % PHASE_COLORS.length]}>■</Text>
      <Text color={glyph.color}>{' ' + glyph.char + ' '}</Text>
      <Text
        color={isShown ? ACCENT : 'text'}
        weight={isShown ? 'semibold' : 'regular'}
        underline={isShown}
        dimColor={!isShown && p.state === 'pending'}
      >
        {p.title + count}
      </Text>
    </Button>
  )
}

// One bar per agent across the run's time, in its phase's colour; the shown phase bright, the rest dim.
const Timeline = (k: Kit, run: WorkflowRun, phases: Phase[], shownIndex: number, now: number, width: number): JSX.Element => {
  const { Box, Text } = k
  const cells = Math.max(10, width - 4)
  const agents = phases.flatMap((p, i) => p.agents.map(a => ({ a, i })))
  if (agents.length === 0) return <Box />
  const from = run.startedAt || Math.min(...agents.map(x => x.a.startedAt))
  const to = isFinished(run) ? Math.max(run.endedAt, ...agents.map(x => x.a.endedAt)) : now
  const span = duration(to - from)
  return (
    <Box flexDirection="column" marginTop={1}>
      {agents.slice(0, TIMELINE_ROWS).map(({ a, i }) => {
        const bar = barSpan(a.startedAt, a.endedAt || now, from, to, cells)
        return (
          <Box flexDirection="row" marginLeft={1}>
            <Text>{' '.repeat(bar.at)}</Text>
            <Text color={PHASE_COLORS[i % PHASE_COLORS.length]} dimColor={i !== shownIndex}>
              {'━'.repeat(Math.max(0, bar.length - (isLive(a) ? 1 : 0))) + (isLive(a) ? '╸' : '')}
            </Text>
          </Box>
        )
      })}
      {agents.length > TIMELINE_ROWS && Empty(k, `and ${agents.length - TIMELINE_ROWS} more`)}
      <Text dimColor>{' 0' + ' '.repeat(Math.max(1, cells - 1 - span.length)) + span}</Text>
    </Box>
  )
}

const STATE_WORDS: Record<PhaseState, string> = { pending: 'not started', running: 'running', done: 'done', failed: 'failed' }

const PhaseDetail = (k: Kit, p: Phase, now: number): JSX.Element => {
  const { Box, Text } = k
  if (p.state === 'pending') return Empty(k, 'Not started yet.')
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {`  ${STATE_WORDS[p.state]} · ${duration(phaseElapsed(p, now))} · ${costLine({ ...p, agents: p.agents.length })}`}
      </Text>
      {p.agents.map(a => Agent(k, a, now, ''))}
    </Box>
  )
}

// A run in the list: what it was and cost, then when and where it ran. Pressing it shows it in full above.
const RunRow = (k: Kit, run: WorkflowRun, agents: AgentRow[], now: number, isShown: boolean, nav: AgentsNav): JSX.Element => {
  const { Box, Button, Text } = k
  const totals = totalsOf(run, phasesOf(run, agents))
  const glyph = runGlyph(totals, now)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={'run-' + run.toolUseId} plain onPress={() => nav.pickRun(isShown ? '' : run.toolUseId)}>
            <Text color={glyph.color}>{glyph.char + ' '}</Text>
            <Text color={isShown ? ACCENT : 'text'} weight={isShown ? 'semibold' : 'regular'}>
              {run.name}
            </Text>
          </Button>
        </Box>
        <Text color={totals.state === 'running' ? ACCENT : 'inactive'}>{duration(runElapsed(run, totals, now))}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {'    ' + [costLine({ ...totals, tools: 0 }), ago(now - run.startedAt), where(run)].filter(Boolean).join(' · ')}
      </Text>
    </Box>
  )
}

const elapsed = (a: AgentRow, now: number) => (a.endedAt || now) - a.startedAt

// An agent on two lines: what it is and how long it took, then its model and what it cost.
const Agent = (k: Kit, a: AgentRow, now: number, kind: string): JSX.Element => {
  const { Box, Text } = k
  const facts = [kind, shortModel(a.model), a.tools ? a.tools + '⚒' : '', a.tokens ? tokens(a.tokens) + ' ctx' : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <Box flexDirection="column" marginLeft={1}>
      {Line(k, agentGlyph(a.status, now), a.description || a.type, <Text color={isLive(a) ? ACCENT : 'inactive'}>{duration(elapsed(a, now))}</Text>)}
      <Box flexDirection="row">
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {'  ' + facts}
          </Text>
        </Box>
        {a.output > 0 && <Text color={ACCENT} dimColor>{' · ↓' + tokens(a.output)}</Text>}
      </Box>
    </Box>
  )
}
