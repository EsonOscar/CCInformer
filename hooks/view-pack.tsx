import type { PackEntryRow, PackLayerRow, PackReport } from '../types'
import { ACTIONS } from './areas'
import { ago, lastSegment } from './format'
import { SECTION_ORDER } from './packs/merge'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

const LAYER_LOOK: Record<PackLayerRow['state'], Glyph> = {
  loaded: { char: '✓', color: 'success' },
  absent: { char: '○', color: 'inactive', dim: true },
  skipped: { char: '–', color: 'inactive', dim: true },
  refused: { char: '✗', color: 'error' },
  broken: { char: '✗', color: 'error' },
}

const SECTION_TITLES: Record<string, string> = {
  processes: 'Processes',
  environments: 'Environments',
  approvals: 'Approvals',
  hosts: 'Hosts',
  checks: 'Checks',
  budgets: 'Budgets',
  locks: 'Locks',
  noise: 'Noise',
  signals: 'Signals',
  claudeMd: 'From CLAUDE.md',
  plans: 'Plans',
  preflight: 'Preflight',
}

// `isToldClaude`: Debug › Settings lets the turn checks run and tell Claude what they find.
export type PackNav = { toggleTrust: () => void; isToldClaude: boolean }

// What this repo's pack came to: each layer and how it went, whether the repo's own tools may run, and every value
// with the layer that set it.
export const PackView = (k: Kit, report: PackReport | null, now: number, nav: PackNav): JSX.Element => {
  const { Box } = k
  if (!report) return <Box flexDirection="column">{Section(k, 'Pack')}{Empty(k, 'Reading the pack…')}</Box>
  const sections = SECTION_ORDER.map(s => ({ section: s, rows: report.entries.filter(e => e.section === s) })).filter(s => s.rows.length > 0)
  return (
    <Box flexDirection="column">
      {Section(k, 'Pack · ' + (report.id || 'none'), lastSegment(report.root))}
      {report.layers.map(l => Layer(k, l))}
      {Trust(k, report, now, nav)}
      {sections.length === 0 && Empty(k, 'Nothing set for this repo.')}
      {sections.map(s => (
        <Box key={'pack-' + s.section} flexDirection="column">
          {Section(k, SECTION_TITLES[s.section] ?? s.section, String(s.rows.length))}
          {s.rows.map(e => Entry(k, e, report.trust.isTrusted))}
        </Box>
      ))}
    </Box>
  )
}

const LAYER_NAMES: Record<PackLayerRow['layer'], string> = { 'built-in': 'built-in', user: 'user pack', repo: 'repo', local: 'local' }

const Layer = (k: Kit, l: PackLayerRow): JSX.Element => {
  const { Box, Text } = k
  const what = [l.source ? lastSegment(l.source) : '', l.note].filter(Boolean).join(' · ') || l.state
  return (
    <Box key={'layer-' + l.layer + l.source} flexDirection="column">
      {Line(
        k,
        LAYER_LOOK[l.state],
        <Box flexDirection="row" columnGap={1}>
          <Text weight="semibold">{LAYER_NAMES[l.layer]}</Text>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {what}
            </Text>
          </Box>
        </Box>,
        l.state === 'loaded' || l.state === 'absent' ? undefined : <Text color={l.state === 'skipped' ? 'inactive' : 'error'}>{l.state}</Text>,
      )}
      {l.reasons.map((r, i) => (
        <Text key={'reason-' + i} color="error" wrap="wrap">
          {'    ' + r}
        </Text>
      ))}
    </Box>
  )
}

// Whether the repo's own tools may run, and the key that grants or withdraws it. A user pack's trust isn't
// withdrawn here: it comes from the pack.
const Trust = (k: Kit, report: PackReport, now: number, nav: PackNav): JSX.Element => {
  const { Box, Button, Text } = k
  const { trust } = report
  const told = nav.isToldClaude ? ' Claude is told what they find.' : ' Claude is told nothing: Turn checks or Turn check notes is off in Debug › Settings.'
  const text = trust.by === 'user pack'
    ? 'repo tools may run: a user pack matches this repo.' + told
    : trust.isTrusted
      ? 'repo tools may run: allowed by you ' + ago(now - trust.at) + '.' + told
      : trust.isStale
        ? 'repo tools wait: the config changed since you allowed them. Press a to allow them again.'
        : "repo tools wait until you allow them with a; until then only the mod's own checks run, and Claude is told nothing from these tools."
  return (
    <Box flexDirection="row" columnGap={1} marginTop={1}>
      <Text color={trust.isTrusted ? 'success' : 'warning'}>{trust.isTrusted ? '✓' : '◌'}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">{text}</Text>
      </Box>
      {trust.by !== 'user pack' && (
        <Button key="pack-trust" plain hotkey={ACTIONS.debug.trust} onPress={nav.toggleTrust}>
          <Text color={ACCENT}>{trust.isTrusted ? 'withdraw' : 'allow'}</Text>
        </Button>
      )}
    </Box>
  )
}

const Entry = (k: Kit, e: PackEntryRow, isTrusted: boolean): JSX.Element => {
  const { Box, Text } = k
  const from = [LAYER_NAMES[e.layer], ...e.changedBy.map(l => '→ ' + LAYER_NAMES[l])].join(' ')
  const glyph: Glyph = e.removedBy
    ? { char: '–', color: 'inactive', dim: true }
    : e.needsTrust && !isTrusted
      ? { char: '◌', color: 'warning' }
      : { char: '•', color: ACCENT }
  return (
    <Box key={'entry-' + e.section + e.id}>
      {Line(
        k,
        glyph,
        <Text dimColor={!!e.removedBy} wrap="truncate-end">
          {e.label + (e.label !== e.id ? ' · ' + e.id : '')}
        </Text>,
        <Text dimColor>{e.removedBy ? 'off in ' + LAYER_NAMES[e.removedBy] : from}</Text>,
      )}
    </Box>
  )
}
