import type { Color, ElementTable } from 'claude-code'

import type { AgentState, Area, CheckBucket, ToolOutcome } from '../types'
import { AREAS, REFRESH_KEY, isBuilt } from './areas'
import type { KeyDef } from './areas'
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
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={ACCENT} weight="semibold" size="heading" wrap="truncate-end">
          {'▍' + title.toUpperCase()}
        </Text>
      </Box>
      {typeof note === 'string' ? (
        <Text dimColor size="footnote">
          {note}
        </Text>
      ) : (
        note
      )}
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
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {typeof left === 'string' ? <Text wrap={truncate}>{left}</Text> : left}
      </Box>
      {typeof right === 'string' ? (
        <Text dimColor mono>
          {right}
        </Text>
      ) : (
        right
      )}
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

export type Badge = { char: string; color: Color }

// How a bar sits in the terminal's header, which is drawn over the content at a height worked out in advance: the gap
// between its items, each row's items by index, and whether the views' counts are drawn. A row that didn't fit would
// squeeze its last item into a column that wraps out of the header over the content.
export type BarFit = { gap: number; rows: number[][]; hasCounts: boolean }

const GAPS = [2, 1]

const cells = (text: string): number => [...text].length
// A plain Button in the terminal: its hotkey, `: `, then its text.
const buttonCells = (key: string, text: string): number => cells(key) + 2 + cells(text)
const span = (widths: number[], gap: number): number => widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1)

// Items in order, `gap` cells apart, as many to a row of `width` cells as fit; one wider than a row gets a row of its own.
export const wrapRows = (widths: number[], width: number, gap: number): number[][] => {
  const rows: number[][] = []
  let used = 0
  widths.forEach((w, i) => {
    const row = rows[rows.length - 1]
    if (row && used + gap + w <= width) {
      row.push(i)
      used += gap + w
    } else {
      rows.push([i])
      used = w
    }
  })
  return rows
}

// The first of `tries` that fits one row, at the wider gap first; else the last one wrapped at the wider gap.
const fit = (tries: { widths: number[]; hasCounts: boolean }[], width: number): BarFit => {
  for (const t of tries) for (const gap of GAPS) if (span(t.widths, gap) <= width) return { gap, rows: [t.widths.map((_, i) => i)], hasCounts: t.hasCounts }
  const last = tries[tries.length - 1]!
  return { gap: GAPS[0]!, rows: wrapRows(last.widths, width, GAPS[0]!), hasCounts: last.hasCounts }
}

// The area bar in `width` cells: the built areas with their badges, then refresh as the last item.
export const areaBarFit = (badges: Record<Area, Badge | null>, width: number): BarFit => {
  const areas = AREAS.filter(isBuilt).map(a => buttonCells(a.digit, a.label + (badges[a.id] ? ' ' + badges[a.id]!.char : '')))
  return fit([{ widths: [...areas, buttonCells(REFRESH_KEY, '⟳')], hasCounts: false }], width)
}

// The view bar in `width` cells: the counts stay while the bar fits one row with them, and go first when it doesn't.
export const viewBarFit = (views: KeyDef[], counts: Record<string, string>, width: number): BarFit =>
  fit(
    [true, false].map(hasCounts => ({ widths: views.map(v => buttonCells(v.key, v.label + (hasCounts && counts[v.id] ? ' ' + counts[v.id] : ''))), hasCounts })),
    width,
  )

// Rows of a bar as its fit lays them out.
const fitRows = (k: Kit, name: string, place: BarFit, items: JSX.Element[]): JSX.Element => {
  const { Box } = k
  return (
    <Box flexDirection="column">
      {place.rows.map((row, r) => (
        <Box key={name + '-row-' + r} flexDirection="row" columnGap={place.gap}>
          {row.map(i => items[i])}
        </Box>
      ))}
    </Box>
  )
}

// The areas across the top, each with its badge (its worst item), and refresh at the right. Only built areas show. In
// the terminal (`place` given) the rows its fit worked out, refresh at the right of the last. Off the terminal the pane
// has no name line, so the `version` is drawn dim before refresh; there the surface draws each hotkey as a chip, wider
// than the terminal's `1:`, so the gaps are narrower and a narrow pane wraps the row rather than hiding refresh under
// its scrollbar.
export const AreaBar = (k: Kit, area: Area, badges: Record<Area, Badge | null>, pick: (id: Area) => void, refresh: () => void, place: BarFit | null, version = ''): JSX.Element => {
  const { Box, Button, Text } = k
  const areas = AREAS.filter(isBuilt).map(a => {
    const badge = badges[a.id]
    return (
      <Button key={'area-' + a.id} plain hotkey={a.digit} onPress={() => pick(a.id)}>
        <Text color={area === a.id ? ACCENT : 'text'} weight={area === a.id ? 'semibold' : 'regular'} dimColor={area !== a.id}>
          {a.label}
        </Text>
        {badge && <Text color={badge.color}>{' ' + badge.char}</Text>}
      </Button>
    )
  })
  const refreshButton = (
    <Button key="refresh" plain hotkey={REFRESH_KEY} onPress={refresh}>
      <Text dimColor>⟳</Text>
    </Button>
  )
  if (place)
    return fitRows(k, 'areas', place, [
      ...areas,
      <Box key="refresh-box" flexGrow={1} flexDirection="row" justifyContent="flex-end">
        {refreshButton}
      </Box>,
    ])
  return (
    <Box flexDirection="row" columnGap="xs" flexWrap="wrap">
      {areas}
      <Box flexGrow={1} />
      {version ? <Text dimColor>{`v${version}`}</Text> : null}
      {refreshButton}
    </Box>
  )
}

// An area's sub-views, drawn when it has more than one, each with an optional count after its label. In the terminal
// (`place` given) the rows its fit worked out, with the counts only where it keeps them; off it, views that don't fit
// move to a second row as the surface wraps them.
export const ViewBar = (k: Kit, views: KeyDef[], view: string, pick: (id: string) => void, counts: Record<string, string>, place: BarFit | null): JSX.Element => {
  const { Box, Button, Text } = k
  const hasCounts = place ? place.hasCounts : true
  const buttons = views.map(v => (
    <Button key={'view-' + v.id} plain hotkey={v.key} onPress={() => pick(v.id)}>
      <Text color={view === v.id ? ACCENT : 'text'} weight={view === v.id ? 'semibold' : 'regular'} dimColor={view !== v.id}>
        {v.label}
      </Text>
      <Text dimColor>{hasCounts && counts[v.id] ? ' ' + counts[v.id] : ''}</Text>
    </Button>
  ))
  return (
    <Box flexDirection="column" marginTop={1}>
      {place ? (
        fitRows(k, 'views', place, buttons)
      ) : (
        <Box flexDirection="row" columnGap="sm" flexWrap="wrap">
          {buttons}
        </Box>
      )}
    </Box>
  )
}
