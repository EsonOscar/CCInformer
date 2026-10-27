import type { RunSummary } from '../types'
import { duration, shortDate, tokens } from './format'
import { columnChart } from './insight'
import { isFull, statsFor, workflowNames } from './stats'
import type { GroupStats } from './stats'
import { ACCENT, Empty, Line, Section, bar } from './ui'
import type { Kit } from './ui'

const TREND_ROWS = 3
const RECENT_SHOWN = 6
const PHASE_COLUMN = 10
const SHARE_BAR = 8
// How many of the newest full runs the trend line compares against the average.
const LATEST_RUNS = 3

// Every finished run of one workflow in this project, summed up: how long and how much, where the time goes,
// and how each model's agents do per phase.
export const StatsView = (k: Kit, summaries: RunSummary[], picked: string, width: number, pick: (name: string) => void): JSX.Element => {
  const { Box, Button, Text } = k
  const names = workflowNames(summaries)
  const name = names.includes(picked) ? picked : names[0]
  if (!name) return <Box flexDirection="column">{Section(k, 'Stats')}{Empty(k, 'No finished workflow runs in this project yet.')}</Box>
  const s = statsFor(summaries, name)
  const first = s.runs[0]
  const last = s.runs[s.runs.length - 1]
  const next = names[(names.indexOf(name) + 1) % names.length] ?? name
  const note = names.length > 1 && (
    <Button key="stats-next" plain hotkey="o" onPress={() => pick(next)}>
      <Text dimColor>{`${names.indexOf(name) + 1}/${names.length} ›`}</Text>
    </Button>
  )
  return (
    <Box flexDirection="column">
      {Section(k, `${name} · ${s.runs.length} runs`, note)}
      <Text dimColor wrap="truncate-end">
        {`  ${s.full.runs} full · ${s.partial.runs} partial` + (first && last ? ` · ${shortDate(first.startedAt)} – ${shortDate(last.startedAt)}` : '')}
      </Text>
      {s.full.runs > 0 && Full(k, s.full, s.trend, width)}
      {s.full.runs > 0 && Section(k, 'Where the time goes', 'full runs')}
      {s.phases.map(p => (
        <Box flexDirection="row" columnGap={1} marginLeft={1}>
          <Box width={PHASE_COLUMN} flexShrink={0}>
            <Text wrap="truncate-end">{p.title}</Text>
          </Box>
          <Box width={SHARE_BAR} flexShrink={0}>
            <Text color={ACCENT}>{bar(p.share, 1, SHARE_BAR)}</Text>
          </Box>
          <Box flexGrow={1} />
          <Text dimColor>{`${duration(p.ms)} · ${Math.round(p.share * 100)}%`}</Text>
        </Box>
      ))}
      {Section(k, 'Models per phase', 'per agent')}
      {s.phases.map(p => (
        <Box flexDirection="column" marginLeft={1}>
          <Text weight="semibold">{p.title}</Text>
          {p.models.map(m =>
            Line(
              k,
              { char: '■', color: m.family === 'opus' ? ACCENT : m.family === 'sonnet' ? 'suggestion' : 'success' },
              `${m.family} · ${m.agents} agents` + (m.ran < m.agents ? ` (${m.agents - m.ran} cached)` : ''),
              m.ran ? `${duration(m.ms)} · ${tokens(Math.round(m.tokens))}` : 'cached only',
            ),
          )}
        </Box>
      ))}
      {s.partial.runs > 0 && Section(k, 'Partial runs', 'avg ' + duration(s.partial.ms))}
      {s.partial.runs > 0 && (
        <Text dimColor wrap="truncate-end">
          {`  e.g. re-checks · ${tokens(Math.round(s.partial.tokens))} ctx · ${s.partial.agents.toFixed(1)} agents`}
        </Text>
      )}
      {Section(k, 'Recent')}
      {s.runs
        .slice(-RECENT_SHOWN)
        .reverse()
        .map(r =>
          Line(
            k,
            { char: isFull(r) ? '●' : '○', color: isFull(r) ? ACCENT : 'inactive' },
            `${shortDate(r.startedAt)} · ${firstPhaseModels(r)}`,
            `${duration(r.ms)} · ${tokens(r.tokens)}`,
          ),
        )}
    </Box>
  )
}

const Full = (k: Kit, full: GroupStats, trend: number[], width: number): JSX.Element => {
  const { Box, Text } = k
  const shown = trend.slice(-Math.max(10, width - 2))
  const latest = trend.slice(-LATEST_RUNS)
  const latestMs = latest.reduce((n, v) => n + v, 0) / Math.max(1, latest.length)
  const change = full.ms ? Math.round((latestMs / full.ms - 1) * 100) : 0
  return (
    <Box flexDirection="column">
      {Section(k, 'Full runs', 'avg ' + duration(full.ms))}
      <Text dimColor wrap="truncate-end">
        {`  ${tokens(Math.round(full.tokens))} ctx · ${full.agents.toFixed(1)} agents · last ${latest.length}: ${duration(latestMs)} (${change > 0 ? '+' : ''}${change}%)`}
      </Text>
      <Box flexDirection="column" marginLeft={1} marginTop={1}>
        {columnChart(shown, Math.max(...shown), TREND_ROWS).map(row => (
          <Text color={ACCENT}>{row}</Text>
        ))}
      </Box>
      <Text dimColor>{'  duration per run, oldest first'}</Text>
    </Box>
  )
}

// Which models the run's first phase ran on, as "Scout: sonnet" (the phase the model switch is about).
const firstPhaseModels = (r: RunSummary): string => {
  const phase = r.phasesRan[0]
  if (!phase) return 'no agents'
  const families = [...new Set(r.agents.filter(a => a.phase === phase).map(a => a.family))]
  return `${phase}: ${families.join('+')}`
}
