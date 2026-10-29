import type { PlanCheckpoint, PlanFile, PlansState } from '../types'
import { ACTIONS } from './areas'
import { ago, lastSegment } from './format'
import { archiveDirFor } from './plans/archive'
import { isFinished, mergedPrs } from './plans/drift'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

// A selected plan in Work's one selected row: this prefix and its path.
export const PLAN_SELECTED = 'plan:'

// The plan selected (its path, or ''), and what pressing does: select a plan, archive one.
export type PlanNav = { selected: string; pick: (path: string) => void; archive: (path: string) => void }

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
// the plan's own; a PR GitHub reports merged on a checkpoint that still reads open is a warning beside it. Pressing a
// plan's header selects it, and `a` archives the selected one (it asks first).
export const PlansView = (k: Kit, state: PlansState | null, now: number, nav: PlanNav): JSX.Element => {
  const { Box } = k
  // A state stored before the board asked GitHub has no `merged` (or `archiveDir`).
  const merged = new Set(state?.merged ?? [])
  const archiveDir = state?.archiveDir ?? ''
  return (
    <Box flexDirection="column">
      {!state && Section(k, 'Plans')}
      {!state && Empty(k, 'Reading the plans…')}
      {state && state.plans.length === 0 && Section(k, 'Plans', ago(now - state.at))}
      {state && state.plans.length === 0 && Empty(k, 'No plans yet: a plan in .local/plans/ (as /ccinformer:plan-feature saves it) shows here.')}
      {state?.plans.map(p => Plan(k, p, merged, archiveDir, nav))}
    </Box>
  )
}

const Plan = (k: Kit, plan: PlanFile, merged: ReadonlySet<number>, archiveDir: string, nav: PlanNav): JSX.Element => {
  const { Box, Button, Text } = k
  const done = plan.checkpoints.filter(c => c.status === 'done').length
  const dropped = plan.checkpoints.filter(c => c.status === 'dropped').length
  const warned = plan.checkpoints.filter(c => mergedPrs(c, merged).length).length
  const isSelected = nav.selected === plan.path
  const canArchive = archiveDirFor(plan.path, { archiveDir }) !== null
  return (
    <Box key={'plan-' + plan.path} flexDirection="column">
      {/* A section header as Section draws it, its title a button (a Button holds only text). */}
      <Box flexDirection="row" marginTop={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={'plan-pick-' + plan.path} plain onPress={() => nav.pick(plan.path)}>
            <Text color={ACCENT} weight="semibold" wrap="truncate-end">
              {'▍' + (isSelected ? '› ' : '') + lastSegment(plan.path).toUpperCase()}
            </Text>
          </Button>
        </Box>
        <Text dimColor>{`${done}/${plan.checkpoints.length} done` + (dropped ? `, ${dropped} dropped` : '')}</Text>
      </Box>
      {plan.title ? <Text dimColor wrap="truncate-end">{'  ' + plan.title}</Text> : null}
      {isSelected && canArchive && (
        <Button key="plan-archive" plain hotkey={ACTIONS.work.archive} onPress={() => nav.archive(plan.path)}>
          <Text color={ACCENT}>{`  ${ACTIONS.work.archive} archive`}</Text>
        </Button>
      )}
      {isSelected && !canArchive && (
        <Text dimColor wrap="truncate-end">
          {'  no archive folder: set plans.archiveDir in the pack'}
        </Text>
      )}
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
