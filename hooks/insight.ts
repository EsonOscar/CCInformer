import type { CiSnapshot, Compaction, SessionBeat, StepRow } from '../types'

// Plain functions behind the CI ping, the Sessions tab and the context chart, so the tests can feed them rows.

// What to tell the person when this commit's checks stop running: null while they run, or when nothing changed.
export const ciOutcome = (prev: CiSnapshot | null, next: CiSnapshot): { isOk: boolean; text: string } | null => {
  if (!prev || prev.head !== next.head || next.checks.length === 0) return null
  const wasRunning = prev.checks.some(c => c.bucket === 'pending')
  if (!wasRunning || next.checks.some(c => c.bucket === 'pending')) return null
  const failed = next.checks.filter(c => c.bucket === 'fail')
  const where = next.pr ? `PR #${next.pr.number}` : next.branch
  return failed.length
    ? { isOk: false, text: `CI failed on ${where}: ${failed.map(c => c.name).join(', ')}` }
    : { isOk: true, text: `CI passed on ${where}: ${next.checks.length} check${next.checks.length === 1 ? '' : 's'}` }
}

// A session whose beat is older than this has ended or hung; it is left out.
export const SESSION_STALE_MS = 90_000

const sameFolder = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

export type SessionGroups = { here: SessionBeat[]; elsewhere: SessionBeat[] }

// The sessions alive now: those in this session's folder first (this one leading), then the rest, newest first.
export const sessionGroups = (beats: SessionBeat[], selfId: string, cwd: string, now: number): SessionGroups => {
  const live = beats.filter(b => now - b.updatedAt < SESSION_STALE_MS || b.id === selfId)
  const order = (a: SessionBeat, b: SessionBeat) => (a.id === selfId ? -1 : b.id === selfId ? 1 : b.updatedAt - a.updatedAt)
  return {
    here: live.filter(b => sameFolder(b.cwd, cwd)).sort(order),
    elsewhere: live.filter(b => !sameFolder(b.cwd, cwd)).sort(order),
  }
}

// The context one request carried, from its step row.
export const stepContext = (s: StepRow): number => s.input + s.cacheRead + (s.cacheWrite || 0)

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

// A column chart `height` rows tall, one column per value, scaled to `max`: the rows from the top down.
export const columnChart = (values: number[], max: number, height: number): string[] =>
  Array.from({ length: height }, (_, row) => {
    const floor = (height - 1 - row) * 8
    return values
      .map(v => {
        const eighths = max > 0 ? Math.round((Math.min(v, max) / max) * height * 8) : 0
        return EIGHTHS[Math.max(0, Math.min(8, eighths - floor))] ?? ' '
      })
      .join('')
  })

// Under the chart: a mark under the first request after each compaction.
export const compactionMarks = (steps: StepRow[], compactions: Compaction[]): string =>
  steps
    .map((s, i) => {
      const prev = steps[i - 1]
      return prev && compactions.some(c => !c.agent && c.at > prev.startedAt && c.at <= s.startedAt) ? '▲' : ' '
    })
    .join('')

// Where an agent's bar sits on a timeline `width` cells wide spanning `from` to `to`: its first cell and its length.
export const barSpan = (start: number, end: number, from: number, to: number, width: number): { at: number; length: number } => {
  const span = Math.max(1, to - from)
  const at = Math.min(width - 1, Math.max(0, Math.floor(((start - from) / span) * width)))
  const stop = Math.min(width, Math.max(at + 1, Math.ceil(((end - from) / span) * width)))
  return { at, length: stop - at }
}
