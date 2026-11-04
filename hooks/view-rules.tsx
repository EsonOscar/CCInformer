import type { CheckRun, Finding } from '../types'
import { ACTIONS } from './areas'
import { ago, duration, spinner } from './format'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

const SEVERITY_LOOK: Record<Finding['severity'], Glyph> = {
  error: { char: '✗', color: 'error' },
  warn: { char: '!', color: 'warning' },
  info: { char: '·', color: 'inactive', dim: true },
}

export type RulesNav = { selected: string; pick: (id: string) => void; dismiss: (id: string) => void }

// The findings shown: every one the person hasn't dismissed, worst first within each file.
export const shownFindings = (findings: Finding[], dismissed: string[]): Finding[] => {
  const rank = (f: Finding) => (f.ciWouldFail ? 0 : f.severity === 'error' ? 1 : f.severity === 'warn' ? 2 : 3)
  return findings.filter(f => !dismissed.includes(f.id)).sort((a, b) => a.file.localeCompare(b.file) || rank(a) - rank(b) || a.line - b.line)
}

// What the pack's checks found in the files Claude changed: per file, each finding with its rule and whether CI
// would fail on it, under one line per turn check's latest run, in the pack's order. Pressing a finding selects it;
// `x` dismisses the selected one for this session.
export const RulesView = (
  k: Kit,
  findings: Finding[],
  dismissed: string[],
  runs: CheckRun[],
  checkIds: string[],
  hasChecks: boolean,
  now: number,
  nav: RulesNav,
): JSX.Element => {
  const { Box, Button, Text } = k
  const shown = shownFindings(findings, dismissed)
  const failing = shown.filter(f => f.ciWouldFail).length
  const files = [...new Set(shown.map(f => f.file))]
  return (
    <Box flexDirection="column">
      {Section(k, 'Rules', failing ? `${failing} would fail CI` : shown.length ? String(shown.length) : '')}
      {checkIds.map(id => {
        const run = runs.find(r => r.check === id)
        return run ? (
          <Box key={'run-' + id} flexDirection="column">
            {Run(k, run, now)}
          </Box>
        ) : null
      })}
      {!hasChecks && Empty(k, "This repo's pack has no checks.")}
      {hasChecks && shown.length === 0 && Empty(k, 'Nothing found in the files changed so far.')}
      {files.map(file => (
        <Box key={'rules-' + file} flexDirection="column">
          {Line(k, null, <Text color={ACCENT} wrap="truncate-start">{file}</Text>)}
          {shown
            .filter(f => f.file === file)
            .map(f => {
              const look = SEVERITY_LOOK[f.severity]
              const isSelected = nav.selected === f.id
              return (
                <Box key={'finding-' + f.id} flexDirection="row" columnGap={1} marginLeft={1}>
                  <Text color={look.color} dimColor={look.dim}>
                    {look.char}
                  </Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Button key={'finding-press-' + f.id} plain onPress={() => nav.pick(isSelected ? '' : f.id)}>
                      <Text color={isSelected ? ACCENT : 'text'} wrap="truncate-end">
                        {(f.line ? 'L' + f.line + ' ' : '') + f.rule + ': ' + f.message}
                      </Text>
                    </Button>
                  </Box>
                  {f.ciWouldFail ? <Text color="error">CI</Text> : f.class === 'advise' ? <Text dimColor>rule</Text> : null}
                  {isSelected && (
                    <Button key="finding-dismiss" plain hotkey={ACTIONS.code.dismiss} onPress={() => nav.dismiss(f.id)}>
                      <Text dimColor>×</Text>
                    </Button>
                  )}
                </Box>
              )
            })}
        </Box>
      ))}
    </Box>
  )
}

// The latest run of a check that runs the repo's own tools; a passed one counts the findings the tool reported in
// files the turn didn't write.
const Run = (k: Kit, run: CheckRun, now: number): JSX.Element => {
  const { Text } = k
  if (run.isRunning) return Line(k, { char: spinner(now), color: ACCENT }, `${run.label} on ${run.files} file${run.files === 1 ? '' : 's'}…`)
  if (run.skipped) return Line(k, { char: '–', color: 'inactive', dim: true }, `${run.label}: skipped, ${run.skipped}`, ago(now - run.at))
  if (run.waitsForTrust)
    return Line(k, { char: '◌', color: 'warning' }, `${run.label} waits until this repo's own tools may run (Debug › Pack, a)`)
  if (run.error) return Line(k, { char: '✗', color: 'error' }, `${run.label}: ${run.error}`, <Text dimColor>{ago(now - run.at)}</Text>)
  const elsewhere = run.elsewhere > 0 ? ` · ${run.elsewhere} elsewhere` : ''
  return Line(k, { char: '✓', color: 'success', dim: true }, `${run.label} on ${run.files} file${run.files === 1 ? '' : 's'} · ${duration(run.ms)}${elsewhere}`, ago(now - run.at))
}
