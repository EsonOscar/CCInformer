import type { PlanCheckpoint, PlanFile, PlansState } from '../types'
import { ago, lastSegment } from './format'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

const STATUS_LOOK: Record<PlanCheckpoint['status'], Glyph> = {
  done: { char: '✓', color: 'success' },
  partly: { char: '◐', color: 'warning' },
  open: { char: '○', color: 'inactive' },
  dropped: { char: '–', color: 'inactive', dim: true },
}
const PRS_SHOWN = 3

// The checkpoint board: each plan file (in .local/plans/, or named by the pack), how many of its checkpoints are done,
// and every checkpoint with its status (from the markers on its own line) and the PRs it names.
export const PlansView = (k: Kit, state: PlansState | null, now: number): JSX.Element => {
  const { Box } = k
  return (
    <Box flexDirection="column">
      {!state && Section(k, 'Plans')}
      {!state && Empty(k, 'Reading the plans…')}
      {state && state.plans.length === 0 && Section(k, 'Plans', ago(now - state.at))}
      {state && state.plans.length === 0 && Empty(k, 'No plans yet: a plan in .local/plans/ (as /ccinformer:plan-feature saves it) shows here.')}
      {state?.plans.map(p => Plan(k, p))}
    </Box>
  )
}

const Plan = (k: Kit, plan: PlanFile): JSX.Element => {
  const { Box, Text } = k
  const done = plan.checkpoints.filter(c => c.status === 'done').length
  const dropped = plan.checkpoints.filter(c => c.status === 'dropped').length
  return (
    <Box key={'plan-' + plan.path} flexDirection="column">
      {Section(k, lastSegment(plan.path), `${done}/${plan.checkpoints.length} done` + (dropped ? `, ${dropped} dropped` : ''))}
      {plan.title ? <Text dimColor wrap="truncate-end">{'  ' + plan.title}</Text> : null}
      {plan.checkpoints.map(c => (
        <Box key={'checkpoint-' + plan.path + '-' + c.id}>
          {Line(
            k,
            STATUS_LOOK[c.status],
            <Text wrap="truncate-end" dimColor={c.status === 'dropped'}>
              <Text color={c.status === 'open' ? 'text' : ACCENT} weight="semibold">
                {c.id}
              </Text>
              {c.title ? '  ' + c.title : ''}
            </Text>,
            c.prs.length ? c.prs.slice(0, PRS_SHOWN).map(n => '#' + n).join(' ') + (c.prs.length > PRS_SHOWN ? ' …' : '') : undefined,
          )}
        </Box>
      ))}
    </Box>
  )
}
