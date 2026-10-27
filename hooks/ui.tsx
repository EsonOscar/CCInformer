import type { Color, ElementTable } from 'claude-code'

import type { AgentState, CheckBucket, ToolOutcome } from '../types'
import { spinner } from './format'

// The pane is drawn for the terminal; other surfaces get the same tree through this table.
export type Kit = ElementTable<'terminal'>

// Claude Code's own orange, by its theme key, so it follows the person's theme.
export const ACCENT: Color = 'claude'

export type Glyph = { char: string; color: Color; dim?: boolean }

export const checkGlyph = (bucket: CheckBucket, now: number): Glyph =>
  ({
    pass: { char: '✓', color: 'success' },
    fail: { char: '✗', color: 'error' },
    pending: { char: spinner(now), color: ACCENT },
    skipping: { char: '–', color: 'inactive', dim: true },
    cancel: { char: '⊘', color: 'warning' },
  })[bucket] as Glyph

export const agentGlyph = (state: AgentState, now: number): Glyph =>
  ({
    running: { char: spinner(now), color: ACCENT },
    waiting: { char: '◌', color: 'warning' },
    done: { char: '✓', color: 'success' },
    failed: { char: '✗', color: 'error' },
    killed: { char: '⊘', color: 'inactive', dim: true },
  })[state] as Glyph

export const toolGlyph = (outcome: ToolOutcome, now: number): Glyph =>
  ({
    running: { char: spinner(now), color: ACCENT },
    ok: { char: '✓', color: 'success', dim: true },
    error: { char: '✗', color: 'error' },
    denied: { char: '⊘', color: 'warning' },
  })[outcome] as Glyph

// A section's heading: an orange bar and caps, with an optional note at the right.
export const Section = (k: Kit, title: string, note?: JSX.Element | string | false): JSX.Element => {
  const { Box, Text } = k
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={ACCENT} weight="semibold" wrap="truncate-end">
          {'▍' + title.toUpperCase()}
        </Text>
      </Box>
      {typeof note === 'string' ? <Text dimColor>{note}</Text> : note}
    </Box>
  )
}

// One line: a glyph, a left part that gives way first, and a right part that stays whole.
export const Line = (
  k: Kit,
  glyph: Glyph | null,
  left: JSX.Element | string,
  right?: JSX.Element | string,
  truncate: 'truncate-end' | 'truncate-start' = 'truncate-end',
): JSX.Element => {
  const { Box, Text } = k
  return (
    <Box flexDirection="row" columnGap={1}>
      {glyph && (
        <Text color={glyph.color} dimColor={glyph.dim}>
          {glyph.char}
        </Text>
      )}
      <Box flexGrow={1} flexShrink={1}>
        {typeof left === 'string' ? <Text wrap={truncate}>{left}</Text> : left}
      </Box>
      {typeof right === 'string' ? <Text dimColor>{right}</Text> : right}
    </Box>
  )
}

export const Empty = (k: Kit, text: string): JSX.Element => {
  const { Text } = k
  return (
    <Text dimColor italic>
      {'  ' + text}
    </Text>
  )
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// A bar `width` cells long for `value` out of `max`, in eighths of a cell.
export const bar = (value: number, max: number, width: number): string => {
  if (!(max > 0) || !(value > 0)) return ''
  const eighths = Math.max(1, Math.round((Math.min(value, max) / max) * width * 8))
  return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]
}
