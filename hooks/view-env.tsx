import type { Color } from 'claude-code'

import type { EnvTask, MachineProcess, MemoryReading, ProcessList } from '../types'
import { ago, duration } from './format'
import { ACCENT, Empty, Line, Section, bar } from './ui'
import type { Glyph, Kit } from './ui'

const TONE_COLORS: Record<string, Color> = { '': 'inactive', local: 'success', shared: 'warning', prod: 'error' }
const MEMORY_BAR = 12
const MB_PER_GB = 1024

const toneGlyph = (tone: string): Glyph => ({ char: tone === 'prod' || tone === 'shared' ? '⚠' : '•', color: TONE_COLORS[tone] ?? 'inactive' })
const gb = (mb: number) => (mb / MB_PER_GB).toFixed(1) + ' GB'

// What runs and where it points: the processes this session started, the ones the pack knows on this machine, and
// how much memory is left.
export const EnvView = (k: Kit, tasks: EnvTask[], processes: ProcessList | null, memory: MemoryReading | null, now: number): JSX.Element => {
  const { Box, Text } = k
  return (
    <Box flexDirection="column">
      {Section(k, 'Started here', tasks.length ? String(tasks.length) : '')}
      {tasks.length === 0 && Empty(k, 'Nothing this session started is running.')}
      {tasks.map(t => Task(k, t, now))}
      {Section(k, 'On this machine', processes ? `checked ${ago(now - processes.at)} · took ${(processes.ms / 1000).toFixed(1)} s` : '')}
      {!processes && Empty(k, 'Reading the processes the pack knows…')}
      {processes?.error && (
        <Text color="error" wrap="wrap">
          {'  ' + processes.error}
        </Text>
      )}
      {processes && !processes.error && processes.list.length === 0 && Empty(k, 'None of the processes the pack knows is running.')}
      {processes?.list.map(p => Process(k, p))}
      {Section(k, 'Memory', memory ? ago(now - memory.at) : '')}
      {memory ? Memory(k, memory) : Empty(k, 'Read with the processes, and every 30 s while a heavy task runs.')}
    </Box>
  )
}

const Task = (k: Kit, t: EnvTask, now: number): JSX.Element => {
  const { Box, Text } = k
  const where = t.envLabel ? t.envLabel + (t.tone !== 'local' ? ' · ' + t.tone : '') : 'no environment'
  return (
    <Box key={'task-' + t.id}>
      {Line(
        k,
        toneGlyph(t.tone),
        <Box flexDirection="row" columnGap={1}>
          <Text wrap="truncate-end">{t.label || 'a process'}</Text>
          {t.isHeavy && <Text color="warning">heavy</Text>}
        </Box>,
        <Text color={TONE_COLORS[t.tone]}>{where + ' · ' + duration(now - t.startedAt)}</Text>,
      )}
    </Box>
  )
}

const Process = (k: Kit, p: MachineProcess): JSX.Element => {
  const { Box, Text } = k
  const isOver = p.ramWarnMb > 0 && p.ramMb > p.ramWarnMb
  return (
    <Box key={'proc-' + p.pid}>
      {Line(
        k,
        toneGlyph(p.tone),
        <Box flexDirection="row" columnGap={1}>
          <Text wrap="truncate-end">{p.label}</Text>
          <Text dimColor>{'pid ' + p.pid}</Text>
        </Box>,
        <Box flexDirection="row" columnGap={1}>
          {p.envLabel && <Text color={TONE_COLORS[p.tone]}>{p.envLabel}</Text>}
          <Text color={isOver ? 'warning' : 'inactive'}>{p.ramMb + ' MB'}</Text>
        </Box>,
      )}
    </Box>
  )
}

const Memory = (k: Kit, m: MemoryReading): JSX.Element => {
  const { Box, Text } = k
  const used = m.totalMb - m.freeMb
  return (
    <Box flexDirection="row" columnGap={1} marginLeft={1}>
      <Text color={m.isLow ? 'error' : ACCENT}>{bar(used, m.totalMb, MEMORY_BAR).padEnd(MEMORY_BAR, '·')}</Text>
      <Text color={m.isLow ? 'error' : 'text'}>{gb(m.freeMb) + ' free'}</Text>
      <Text dimColor>{'of ' + gb(m.totalMb)}</Text>
      {m.isLow && <Text color="error">low</Text>}
    </Box>
  )
}
