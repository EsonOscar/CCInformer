import type { BudgetReading, BudgetState } from '../types'
import { ACTIONS } from './areas'
import { isOver, shown, verdict } from './budgets/gauge'
import { ago, spinner } from './format'
import { ACCENT, Empty, Line, Section, bar } from './ui'
import type { Glyph, Kit } from './ui'

const FROM: Record<string, string> = { command: 'the repo\'s report', 'ci-log': 'CI', json: 'a file' }
const BAR_CELLS = 16

// The pack's budgets: each one's value against its limit, where the value came from, and whether it still measures
// the tree as it is. `m` builds first and then reads, which takes minutes and loads the machine.
export const BudgetsView = (k: Kit, budgets: BudgetState | null, hasBudgets: boolean, now: number, measure: () => void): JSX.Element => {
  const { Box, Button, Text } = k
  const doing = budgets?.doing
  const note = doing === 'building' ? 'building…' : doing === 'reading' ? 'reading…' : budgets?.at ? 'read ' + ago(now - budgets.at) : ''
  return (
    <Box flexDirection="column">
      {Section(k, 'Budgets', note)}
      {!hasBudgets && Empty(k, "This repo's pack has no budgets.")}
      {hasBudgets && !budgets?.readings.length && !doing && Empty(k, 'Not read yet: r reads them, m builds first.')}
      {doing && Line(k, { char: spinner(now), color: ACCENT }, doing === 'building' ? 'Building, then reading the budgets (a build can take minutes)' : 'Reading the budgets')}
      {budgets?.error ? Line(k, { char: '✗', color: 'error' }, budgets.error) : null}
      {budgets?.readings.map(r => Reading(k, r))}
      {hasBudgets && (
        <Box marginTop={1}>
          <Button key="budgets-measure" plain hotkey={ACTIONS.code.measure} onPress={measure}>
            <Text dimColor>{`${ACTIONS.code.measure} measure now (builds first)`}</Text>
          </Button>
        </Box>
      )}
    </Box>
  )
}

const Reading = (k: Kit, r: BudgetReading): JSX.Element => {
  const { Box, Text } = k
  const over = isOver(r)
  const glyph: Glyph =
    r.value === null ? { char: '○', color: 'inactive', dim: true } : over ? { char: '✗', color: 'error' } : r.staleWhy ? { char: '◌', color: 'warning' } : { char: '✓', color: 'success' }
  const value = r.value === null ? '' : shown(r.value, r.unit)
  const details = r.value === null ? r.error : [verdict(r), 'from ' + (FROM[r.from] ?? r.from), r.staleWhy && 'stale: ' + r.staleWhy].filter(Boolean).join(' · ')
  return (
    <Box key={'budget-' + r.id} flexDirection="column">
      {Line(k, glyph, r.label, <Text color={over ? 'error' : 'text'}>{value}</Text>)}
      <Box flexDirection="row" columnGap={1} marginLeft={2}>
        {r.value !== null && r.limit !== null && <Text color={over ? 'error' : ACCENT}>{bar(r.value, r.limit, BAR_CELLS).padEnd(BAR_CELLS)}</Text>}
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="wrap">
            {details}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
