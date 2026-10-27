import type { AgentRow, Compaction, DebugView, StepRow, ToolRow } from '../types'
import { ago, duration, shortModel, spinner, tokens } from './format'
import { columnChart, compactionMarks, stepContext } from './insight'
import { ACCENT, Empty, Line, Section, bar, toolGlyph } from './ui'
import type { Kit } from './ui'

const ROWS_SHOWN = 30
const BAR_WIDTH = 5
const TOOL_COLUMN = 8
const CHART_ROWS = 6
const TREND_REQUESTS = 10
const COMPACTIONS_SHOWN = 5

export type DebugData = { tools: ToolRow[]; steps: StepRow[]; compactions: Compaction[]; agents: AgentRow[] }

export const DebugPanel = (k: Kit, view: DebugView, data: DebugData, now: number, width: number, pick: (v: DebugView) => void): JSX.Element => {
  const { Box, Button, Text } = k
  const main = data.steps.filter(s => !s.agent && s.ms > 0)
  const latest = main[main.length - 1]
  const views: { id: DebugView; label: string; hotkey: string; count: string }[] = [
    { id: 'tools', label: 'Tools', hotkey: 't', count: String(data.tools.length) },
    { id: 'requests', label: 'Requests', hotkey: 'q', count: String(data.steps.length) },
    { id: 'context', label: 'Context', hotkey: 'c', count: latest ? tokens(stepContext(latest)) : '' },
  ]
  const label = (id: string) => data.agents.find(a => a.id === id)?.description ?? 'subagent'
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} marginTop={1}>
        {views.map(v => (
          <Button key={'debug-' + v.id} plain hotkey={v.hotkey} onPress={() => pick(v.id)}>
            <Text color={view === v.id ? ACCENT : 'text'} weight={view === v.id ? 'semibold' : 'regular'} dimColor={view !== v.id}>
              {v.label}
            </Text>
            <Text dimColor>{v.count ? ' ' + v.count : ''}</Text>
          </Button>
        ))}
      </Box>
      {view === 'tools' && Tools(k, data.tools, now, label)}
      {view === 'requests' && Requests(k, data.steps, now, label)}
      {view === 'context' && Context(k, main, data.compactions, now, width)}
    </Box>
  )
}

const Tools = (k: Kit, rows: ToolRow[], now: number, label: (id: string) => string): JSX.Element => {
  const { Box, Text } = k
  const shown = rows.slice(-ROWS_SHOWN).reverse()
  const slowest = Math.max(1, ...shown.map(r => r.ms))
  const failed = rows.filter(r => r.outcome === 'error' || r.outcome === 'denied').length
  const total = rows.reduce((n, r) => n + r.ms, 0)
  return (
    <Box flexDirection="column">
      {Section(k, 'Tool calls', `${rows.length} · ${duration(total)}${failed ? ` · ${failed} failed` : ''}`)}
      {shown.length === 0 && Empty(k, 'No tool calls yet.')}
      {shown.map(r => {
        const ms = r.outcome === 'running' ? now - r.startedAt : r.ms
        return Line(
          k,
          toolGlyph(r.outcome, now),
          <Box flexDirection="row" columnGap={1}>
            <Box width={TOOL_COLUMN} flexShrink={0}>
              <Text color={r.outcome === 'error' ? 'error' : 'text'} weight="medium" wrap="truncate-end">
                {r.tool}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {(r.agent ? '↳ ' + label(r.agent) + ' · ' : '') + r.summary}
              </Text>
            </Box>
          </Box>,
          <Box flexDirection="row" columnGap={1}>
            <Text color={r.outcome === 'running' ? ACCENT : 'inactive'}>{duration(ms)}</Text>
            <Box width={BAR_WIDTH}>
              <Text color={ACCENT} dimColor>
                {bar(ms, slowest, BAR_WIDTH)}
              </Text>
            </Box>
          </Box>,
        )
      })}
    </Box>
  )
}

const Requests = (k: Kit, rows: StepRow[], now: number, label: (id: string) => string): JSX.Element => {
  const { Box, Text } = k
  const shown = rows.slice(-ROWS_SHOWN).reverse()
  const input = rows.reduce((n, r) => n + r.input + r.cacheRead, 0)
  const cached = rows.reduce((n, r) => n + r.cacheRead, 0)
  const output = rows.reduce((n, r) => n + r.output, 0)
  const share = input ? Math.round((cached / input) * 100) + '% cached' : ''
  return (
    <Box flexDirection="column">
      {Section(k, 'Requests', `${rows.length} · in ${tokens(input)} ${share} · out ${tokens(output)}`)}
      {shown.length === 0 && Empty(k, 'No requests yet.')}
      {shown.map(r => (
        <Box flexDirection="column">
          {Line(
            k,
            r.ms ? { char: '•', color: r.agent ? 'suggestion' : ACCENT } : { char: spinner(now), color: ACCENT },
            (r.agent ? '↳ ' + label(r.agent) + ' · ' : '') + shortModel(r.model) + (r.effort ? ' · ' + r.effort : ''),
            duration(r.ms || now - r.startedAt),
          )}
          {r.ms > 0 && (
            <Text dimColor wrap="truncate-end">
              {`   in ${tokens(r.input)} · cache ${tokens(r.cacheRead)} · out ${tokens(r.output)}${r.stop ? ' · ' + r.stop : ''}`}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

// How the main conversation's context grew, request by request, against its window, with compactions marked.
const Context = (k: Kit, main: StepRow[], compactions: Compaction[], now: number, width: number): JSX.Element => {
  const { Box, Text } = k
  const shown = main.slice(-Math.max(10, width - 2))
  const last = shown[shown.length - 1]
  if (!last) return <Box flexDirection="column">{Section(k, 'Context')}{Empty(k, 'No requests yet.')}</Box>
  const values = shown.map(stepContext)
  const current = stepContext(last)
  const windowSize = last.window || Math.max(...values)
  const percent = windowSize ? Math.round((current / windowSize) * 100) : 0
  const recent = main.slice(-TREND_REQUESTS - 1).map(stepContext)
  const first = recent[0] ?? 0
  const growth = recent.length > 1 ? Math.round((current - first) / (recent.length - 1)) : 0
  const own = compactions.filter(c => !c.agent)
  const marks = compactionMarks(shown, own)
  return (
    <Box flexDirection="column">
      {Section(k, 'Context · main', `${tokens(current)} / ${tokens(windowSize)} · ${percent}%`)}
      <Box flexDirection="column" marginLeft={1} marginTop={1}>
        {columnChart(values, windowSize, CHART_ROWS).map(row => (
          <Text color={percent >= 80 ? 'warning' : ACCENT}>{row}</Text>
        ))}
        {marks.trim() && <Text color="warning">{marks}</Text>}
      </Box>
      <Text dimColor wrap="truncate-end">
        {`  peak ${tokens(Math.max(...main.map(stepContext)))} · ${growth >= 0 ? '+' : '−'}${tokens(Math.abs(growth))} per request · ${main.length} requests`}
      </Text>
      {Section(k, 'Compactions', own.length ? String(own.length) : '')}
      {own.length === 0 && Empty(k, 'None this session.')}
      {own
        .slice(-COMPACTIONS_SHOWN)
        .reverse()
        .map(c =>
          Line(
            k,
            { char: '▲', color: 'warning' },
            c.trigger + (c.before && c.after ? ` · ${tokens(c.before)} → ${tokens(c.after)}` : ''),
            ago(now - c.at),
          ),
        )}
    </Box>
  )
}
