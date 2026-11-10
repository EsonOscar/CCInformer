import type { ShellRow } from '../types'
import { closedShells, openShells, shellFacts } from './env/shells'
import { spinner } from './format'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

const shellGlyph = (status: string, now: number): Glyph =>
  status === 'running' ? { char: spinner(now), color: ACCENT }
  : status === 'completed' ? { char: '✓', color: 'success', dim: true }
  : status === 'failed' ? { char: '✗', color: 'error' }
  : { char: '⊘', color: 'inactive', dim: true }

// The background shells this session started: the open ones with how long each has been open, then the ended ones
// with how each ended.
export const ShellsView = (k: Kit, shells: ShellRow[], now: number): JSX.Element => {
  const { Box } = k
  const open = openShells(shells)
  const ended = closedShells(shells)
  return (
    <Box flexDirection="column">
      {Section(k, 'Open', open.length ? String(open.length) : '')}
      {open.length === 0 && Empty(k, 'No background shell is open in this session.')}
      {open.map(s => Shell(k, s, now))}
      {ended.length > 0 && Section(k, 'Ended', String(ended.length))}
      {ended.map(s => Shell(k, s, now))}
    </Box>
  )
}

const Shell = (k: Kit, s: ShellRow, now: number): JSX.Element => {
  const { Box } = k
  return <Box key={'shell-' + s.id}>{Line(k, shellGlyph(s.status, now), s.command || s.tool, shellFacts(s, now))}</Box>
}
