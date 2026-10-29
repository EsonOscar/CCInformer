import type { PlanCheckpoint, PlanFile, PlansState } from '../types'
import { ago, lastSegment } from './format'
import { isFinished, mergedPrs } from './plans/drift'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

const STATUS_LOOK: Record<PlanCheckpoint['status'], Glyph> = {
  done: { char: '✓', color: 'success' },
  partly: { char: '◐', color: 'warning' },
  open: { char: '○', color: 'inactive' },
  dropped: { char: '–', color: 'inactive', dim: true },
}
const PRS_SHOWN = 3
const prList = (prs: number[]) => prs.slice(0, PRS_SHOWN).map(n => '#' + n).join(' ') + (prs.length > PRS_SHOWN ? ' …' : '')

// The checkpoint board: each plan file (in .local/plans/, or named by the pack), how many of its checkpoints are done,
// and every checkpoint with its status (from the markers on its own line) and the PRs it names. The status is always
// the plan's own; a PR GitHub reports merged on a checkpoint that still reads open is a warning beside it.
export const PlansView = (k: Kit, state: PlansState | null, now: number): JSX.Element => {
  const { Box } = k
  // A state stored before the board asked GitHub has no `merged`.
  const merged = new Set(state?.merged ?? [])
  return (
    <Box flexDirection="column">
      {!state && Section(k, 'Plans')}
      {!state && Empty(k, 'Reading the plans…')}
      {state && state.plans.length === 0 && Section(k, 'Plans', ago(now - state.at))}
      {state && state.plans.length === 0 && Empty(k, 'No plans yet: a plan in .local/plans/ (as /ccinformer:plan-feature saves it) shows here.')}
      {state?.plans.map(p => Plan(k, p, merged))}
    </Box>
  )
}

const Plan = (k: Kit, plan: PlanFile, merged: ReadonlySet<number>): JSX.Element => {
  const { Box, Text } = k
  const done = plan.checkpoints.filter(c => c.status === 'done').length
  const dropped = plan.checkpoints.filter(c => c.status === 'dropped').length
  const warned = plan.checkpoints.filter(c => mergedPrs(c, merged).length).length
  return (
    <Box key={'plan-' + plan.path} flexDirection="column">
      {Section(k, lastSegment(plan.path), `${done}/${plan.checkpoints.length} done` + (dropped ? `, ${dropped} dropped` : ''))}
      {plan.title ? <Text dimColor wrap="truncate-end">{'  ' + plan.title}</Text> : null}
      {warned > 0 && (
        <Text color="warning" wrap="truncate-end">
          {warned === 1
            ? '  ⚠ 1 checkpoint names a merged PR but reads open: update the plan'
            : `  ⚠ ${warned} checkpoints name a merged PR but read open: update the plan`}
        </Text>
      )}
      {isFinished(plan) && (
        <Text color="success" wrap="truncate-end">
          {`  ✓ Every checkpoint is ${dropped ? 'done or dropped' : 'done'}: ready to archive`}
        </Text>
      )}
      {plan.checkpoints.map(c => {
        const prsMerged = mergedPrs(c, merged)
        return (
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
              prsMerged.length ? <Text color="warning">{'⚠ ' + prList(prsMerged) + ' merged'}</Text> : c.prs.length ? prList(c.prs) : undefined,
            )}
          </Box>
        )
      })}
    </Box>
  )
}
