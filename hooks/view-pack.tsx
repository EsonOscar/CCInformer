import type { PackApprovalRow, PackEntryRow, PackLayerRow, PackReport } from '../types'
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
  checks: 'Checks',
  budgets: 'Budgets',
  noise: 'Noise',
  plans: 'Plans',
}

// `isToldClaude`: Debug › Settings lets the turn checks run and tell Claude what they find. `isGateOn`: its Approval
// gates switch is on, so the approval rules ask and log.
export type PackNav = { toggleTrust: () => void; isToldClaude: boolean; isGateOn: boolean }

export const GATES_OFF = 'Approval gates are off in Debug › Settings (Safety): these rules neither ask nor log.'

// What the gate does with a rule, as Debug › Pack says it.
export const approvalText = (a: PackApprovalRow): string =>
  (a.mode === 'log' ? 'logs, no prompt' : a.scope === 'session' ? 'asks once a session' : 'asks each time') + (a.isLoosened ? ', loosened' : '')

// What this repo's pack came to: each layer and how it went, whether the repo's own tools may run, and every value
// with the layer that set it. With no pack yet, either it is being read or the last read failed (`failed`, why).
export const PackView = (k: Kit, report: PackReport | null, failed: string, now: number, nav: PackNav): JSX.Element => {
  const { Box, Text } = k
  if (!report) return <Box flexDirection="column">{Section(k, 'Pack')}{Empty(k, failed ? `Couldn't read the pack: ${failed}. r tries again.` : 'Reading the pack…')}</Box>
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
          {s.section === 'approvals' && !nav.isGateOn && (
            <Text key="gates-off" color="warning" wrap="wrap">
              {GATES_OFF}
            </Text>
          )}
          {s.rows.map(e => (s.section === 'approvals' ? ApprovalEntry(k, e) : Entry(k, e, report.trust.isTrusted)))}
        </Box>
      ))}
    </Box>
  )
}

const LAYER_NAMES: Record<PackLayerRow['layer'], string> = { 'built-in': 'built-in', user: 'user pack' }

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
          <Box flexShrink={1} minWidth={0}>
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
      : "repo tools wait until you allow them with a; until then only the mod's own checks run, and Claude is told nothing from these tools."
  return (
    <Box flexDirection="row" columnGap={1} marginTop={1}>
      <Text color={trust.isTrusted ? 'success' : 'warning'}>{trust.isTrusted ? '✓' : '◌'}</Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
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

const layersOf = (e: PackEntryRow): string => [LAYER_NAMES[e.layer], ...e.changedBy.map(l => '→ ' + LAYER_NAMES[l])].join(' ')

const Entry = (k: Kit, e: PackEntryRow, isTrusted: boolean): JSX.Element => {
  const { Box, Text } = k
  const from = layersOf(e)
  const glyph: Glyph = e.removedBy
    ? { char: '–', color: 'inactive', dim: true }
    : e.needsTrust && !isTrusted
      ? { char: '◌', color: 'warning' }
      : { char: '•', color: ACCENT }
  return (
    <Box key={'entry-' + e.section + (e.env ?? '') + e.id}>
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

// An approval rule: its environment and what the gate does with it, amber when a person's own pack loosened a prod
// rule (it only logs, or asks once a session). A row kept by an older version, with no details, is drawn plainly.
const ApprovalEntry = (k: Kit, e: PackEntryRow): JSX.Element => {
  const { Box, Text } = k
  const a = e.approval
  if (!e.removedBy && !a) return Entry(k, e, true)
  const isLoosened = !!a?.isLoosened
  const glyph: Glyph = e.removedBy ? { char: '–', color: 'inactive', dim: true } : isLoosened ? { char: '!', color: 'warning' } : { char: '•', color: ACCENT }
  const where = a?.envLabel ?? e.env ?? ''
  const right = e.removedBy ? `${where} · off in ${LAYER_NAMES[e.removedBy]}` : `${where} · ${approvalText(a!)} · ${layersOf(e)}`
  return (
    <Box key={'entry-' + e.section + (e.env ?? '') + e.id}>
      {Line(
        k,
        glyph,
        <Text dimColor={!!e.removedBy} wrap="truncate-end">
          {e.label + (e.label !== e.id ? ' · ' + e.id : '')}
        </Text>,
        isLoosened ? <Text color="warning">{right}</Text> : <Text dimColor>{right}</Text>,
      )}
    </Box>
  )
}
