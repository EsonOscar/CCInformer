import type {
  AgentRow, Area, BudgetState, CheckRun, CiActiveState, PlansState, UsageReading, CiSnapshot, CodeView, Compaction, DebugView, DiffPreview, EnvTask, FileChange, Finding, GitSnapshot, MemoryReading,
  NowView, PackReport, ProcessList, RunSummary, SessionBeat, StepRow, ToolRow, WorkView, WorkflowRun,
} from '../types'
import { areaDef } from './areas'
import { spinner } from './format'
import { sessionGroups } from './insight'
import { ACCENT, AreaBar, ViewBar } from './ui'
import type { Badge, Kit } from './ui'
import { AgentsView as AgentsPanel } from './view-agents'
import { DebugPanel, debugCounts } from './view-debug'
import { EnvView } from './view-env'
import { GitView } from './view-git'
import { PackView } from './view-pack'
import { PLAN_SELECTED, PlansView } from './view-plans'
import { isOver } from './budgets/gauge'
import { mergedWarnings } from './plans/drift'
import { BudgetsView } from './view-budgets'
import { RulesView, shownFindings } from './view-rules'
import { SessionsView } from './view-sessions'
import { StatsView } from './view-stats'
import { usageLine } from './usage'

// Everything the pane draws from: the state the hooks keep, and who and where this session is.
export type PaneData = {
  area: Area
  nowView: NowView
  codeView: CodeView
  workView: WorkView
  debugView: DebugView
  selected: Record<Area, string>
  phase: string
  isActive: boolean
  now: number
  git: GitSnapshot | null
  ci: CiSnapshot | null
  showAllFiles: boolean
  diff: DiffPreview | null
  agents: AgentRow[]
  runs: WorkflowRun[]
  statsName: string
  stats: RunSummary[]
  tools: ToolRow[]
  steps: StepRow[]
  compactions: Compaction[]
  sessions: SessionBeat[]
  pack: PackReport | null
  findings: Finding[]
  dismissed: string[]
  checkRun: CheckRun | null
  budgets: BudgetState | null
  plans: PlansState | null
  usage: UsageReading | null
  ciActive: CiActiveState
  tasks: EnvTask[]
  processes: ProcessList | null
  memory: MemoryReading | null
  selfId: string
  cwd: string
  // The mod's version, shown muted in the top right; '' draws nothing.
  version: string
  width: number
  // The rows the pane shows at once, and the first row its window shows: the footer is drawn at the window's bottom.
  rows: number
  scrollTop: number
  // How far the pane has scrolled its own content (see scrolledTop).
  contentTop: number
}

// The footer's rows: a line, then the usage. The header's: the title, the areas and a line, then, for an area with
// several views, a blank row and the view bar.
const FOOTER_ROWS = 2
const HEADER_ROWS = 3
const VIEW_BAR_ROWS = 2

// The pane scrolls its own content, so the footer drawn over it never moves: a scroll of `by` rows moves the content
// from `top`, clamped so its last row still clears the footer. `contentRows` is the tree's height as drawn now, which
// is the content's own height less the `top` rows already scrolled away.
export const scrolledTop = (top: number, by: number, contentRows: number, bodyRows: number): number =>
  Math.min(Math.max(0, contentRows + top - bodyRows), Math.max(0, top + by))

// What a press in the pane does; the hooks module makes each from its state and the session's work.
export type PaneNav = {
  showArea: (area: Area) => void
  pickView: (view: string) => void
  refresh: () => void
  toggleAllFiles: () => void
  toggleCiMode: () => void
  openDiff: (file: FileChange) => void
  fetch: () => void
  openDiffPane: () => void
  pickPhase: (title: string) => void
  pickRun: (key: string) => void
  pickStats: (name: string) => void
  pickPlan: (path: string) => void
  archivePlan: (path: string) => void
  toggleTrust: () => void
  pickFinding: (id: string) => void
  dismissFinding: (id: string) => void
  measure: () => void
}

// Each area's badge: its worst item.
export const badgesOf = (d: PaneData): Record<Area, Badge | null> => {
  const busy: Badge = { char: spinner(d.now), color: ACCENT }
  const othersBusy = sessionGroups(d.sessions, d.selfId, d.cwd, d.now).here.filter(b => b.id !== d.selfId && b.isBusy).length
  const isPackBroken = !!d.pack?.layers.some(l => l.state === 'refused' || l.state === 'broken')
  // A fresh budget reading that's over counts as much as a finding that would fail CI.
  const wouldFail = shownFindings(d.findings, d.dismissed).some(f => f.ciWouldFail) || !!d.budgets?.readings.some(r => isOver(r) && !r.staleWhy)
  return {
    now: d.memory?.isLow ? { char: '!', color: 'error' } : othersBusy ? { char: String(othersBusy), color: 'warning' } : null,
    code: d.ci?.checks.some(c => c.bucket === 'fail')
      ? { char: '✗', color: 'error' }
      : d.ci?.checks.some(c => c.bucket === 'pending')
        ? busy
        : wouldFail
          ? { char: '!', color: 'warning' }
          : null,
    // A PR merged under a checkpoint that still reads open: the plan wants updating.
    work: d.agents.some(a => a.status === 'running')
      ? busy
      : d.plans && mergedWarnings(d.plans.plans, new Set(d.plans.merged ?? [])).length
        ? { char: '!', color: 'warning' }
        : null,
    timeline: null,
    debug: d.tools.some(t => t.outcome === 'error') || isPackBroken ? { char: '•', color: 'error' } : null,
  }
}

// The pane: its name, the areas, and the shown area's view bar and view.
export const PaneView = (k: Kit, title: string, d: PaneData, nav: PaneNav): JSX.Element => {
  const { Box, Text } = k
  const def = areaDef(d.area)
  const debugData = { tools: d.tools, steps: d.steps, compactions: d.compactions, agents: d.agents }
  const views: Record<Area, string> = { now: d.nowView, code: d.codeView, work: d.workView, timeline: '', debug: d.debugView }
  const ruleCount = shownFindings(d.findings, d.dismissed).length
  const counts: Record<string, string> = d.area === 'debug' ? debugCounts(debugData) : d.area === 'code' && ruleCount ? { rules: String(ruleCount) } : {}
  const hasChecks = !!d.pack?.entries.some(e => e.section === 'checks' && !e.removedBy)
  const hasBudgets = !!d.pack?.entries.some(e => e.section === 'budgets' && !e.removedBy)
  const rulesNav = { selected: d.selected.code, pick: nav.pickFinding, dismiss: nav.dismissFinding }
  const width = d.width - 2
  const gitNav = { showAll: d.showAllFiles, toggleAll: nav.toggleAllFiles, diff: d.diff, openDiff: nav.openDiff, fetch: nav.fetch, openDiffPane: nav.openDiffPane, ciActive: d.ciActive, toggleCiMode: nav.toggleCiMode }
  // Work keeps one selected row: a run, or a plan (marked by its prefix), which Runs leaves alone.
  const isPlanSelected = d.selected.work.startsWith(PLAN_SELECTED)
  const runNav = { phase: d.phase, pickPhase: nav.pickPhase, run: isPlanSelected ? '' : d.selected.work, pickRun: nav.pickRun }
  const planNav = { selected: isPlanSelected ? d.selected.work.slice(PLAN_SELECTED.length) : '', pick: nav.pickPlan, archive: nav.archivePlan }
  const hasViewBar = def.views.length > 1
  const headerRows = hasViewBar ? HEADER_ROWS + VIEW_BAR_ROWS : HEADER_ROWS
  return (
    // The padding leaves room for the header above the content and the footer below it, so a long view scrolls clear
    // of both.
    <Box flexDirection="column" paddingX={1} paddingBottom={FOOTER_ROWS} minHeight={d.rows}>
      {/* The content, moved up by the rows the pane has scrolled itself; the header and footer stay where they are. */}
      <Box key="content" flexDirection="column" paddingTop={headerRows} marginTop={d.contentTop ? -d.contentTop : 0}>
        {d.area === 'now' && d.nowView === 'env' && EnvView(k, d.tasks, d.processes, d.memory, d.now)}
        {d.area === 'now' && d.nowView === 'sessions' && SessionsView(k, d.sessions, d.selfId, d.cwd, d.now)}
        {d.area === 'code' && d.codeView === 'git' && GitView(k, d.git, d.ci, d.now, width, !d.isActive, gitNav)}
        {d.area === 'code' && d.codeView === 'rules' && RulesView(k, d.findings, d.dismissed, d.checkRun, hasChecks, d.now, rulesNav)}
        {d.area === 'code' && d.codeView === 'budgets' && BudgetsView(k, d.budgets, hasBudgets, d.now, nav.measure)}
        {d.area === 'work' && d.workView === 'runs' && AgentsPanel(k, d.agents, d.runs, d.now, width, runNav)}
        {d.area === 'work' && d.workView === 'stats' && StatsView(k, d.stats, d.statsName, width, nav.pickStats)}
        {d.area === 'work' && d.workView === 'plans' && PlansView(k, d.plans, d.now, planNav)}
        {d.area === 'debug' && d.debugView !== 'pack' && DebugPanel(k, d.debugView, debugData, d.now, width)}
        {d.area === 'debug' && d.debugView === 'pack' && PackView(k, d.pack, d.now, { toggleTrust: nav.toggleTrust })}
      </Box>
      {/* The header, laid over the tree at the window's top rows, as the footer is at its bottom: the pane scrolls its
          own content, so neither moves, and the area and view hotkeys stay in view. A layer of blank rows is drawn first
          and the header over it, so the gaps between its buttons cover the content beneath too. */}
      <Box key="header" position="absolute" top={d.scrollTop} left={1} width={width} flexDirection="column">
        <Box key="header-blank" position="absolute" top={0} left={0} flexDirection="column">
          {Array.from({ length: headerRows }, (_, i) => (
            <Text key={'header-blank-' + i}>{' '.repeat(Math.max(1, width))}</Text>
          ))}
        </Box>
        {/* Claude Code draws a pane's title only as a tab beside other panes, so the pane names itself. */}
        <Box key="title" flexDirection="row">
          <Text color={ACCENT} weight="bold">
            ✻{' '}
          </Text>
          <Text dimColor>{title}</Text>
          <Box flexGrow={1} />
          {d.version ? <Text dimColor>{`v${d.version}`}</Text> : null}
        </Box>
        {AreaBar(k, d.area, badgesOf(d), nav.showArea, nav.refresh)}
        <Text color={ACCENT} dimColor>
          {'─'.repeat(Math.max(1, width))}
        </Text>
        {hasViewBar && ViewBar(k, def.views, views[d.area], nav.pickView, counts)}
      </Box>
      {/* The footer, in every area, laid over the tree at the window's bottom rows. Its rows run the full width,
          covering what's beneath. */}
      <Box key="footer" position="absolute" top={Math.max(0, d.scrollTop + d.rows - FOOTER_ROWS)} left={1} width={width} flexDirection="column">
        <Text color={ACCENT} dimColor>
          {'─'.repeat(Math.max(1, width))}
        </Text>
        <Text dimColor wrap="truncate-end">
          {usageLine(d.usage ?? { contextPercent: null, fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null }, d.now).padEnd(width)}
        </Text>
      </Box>
    </Box>
  )
}
