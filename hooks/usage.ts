import type { UsageReading } from '../types'

type Context = { tokens?: number; window?: number; percent?: number }
type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

// The session's usage as the pane's footer shows it: the context window's fill, and the subscription's 5-hour and
// 7-day windows with when each resets (null where there's no reading yet, or no subscription).
export const readUsage = (context: Context | undefined, rateLimits: readonly RateLimit[] | undefined): UsageReading => {
  const fill = context?.percent ?? (context?.window && context.tokens !== undefined ? (context.tokens / context.window) * 100 : undefined)
  const window = (kind: string) => rateLimits?.find(r => r.kind === kind)
  const resetsAt = (kind: string) => {
    const at = Date.parse(window(kind)?.resetsAt ?? '')
    return Number.isNaN(at) ? null : at
  }
  return {
    contextPercent: fill === undefined ? null : fill,
    fiveHour: window('five_hour')?.percentUsed ?? null,
    sevenDay: window('seven_day')?.percentUsed ?? null,
    fiveHourResetsAt: resetsAt('five_hour'),
    sevenDayResetsAt: resetsAt('seven_day'),
  }
}

// "34%", with the limits' one decimal kept ("23.5%"); "–" for no reading.
const percent = (n: number | null, decimals: number) => (n === null ? '–' : `${Number(n.toFixed(decimals))}%`)

// The time left until a window resets, in whole minutes: " (4h12m)", or with days " (6d3h20m)"; nothing without a reset
// time, or before the pane's clock has a reading.
const left = (resetsAt: number | null | undefined, now: number, withDays: boolean) => {
  if (!resetsAt || !now) return ''
  const minutes = Math.max(0, Math.floor((resetsAt - now) / 60_000))
  const hours = Math.floor(minutes / 60)
  return withDays ? ` (${Math.floor(hours / 24)}d${hours % 24}h${minutes % 60}m)` : ` (${hours}h${minutes % 60}m)`
}

export const usageLine = (u: UsageReading, now: number): string =>
  `Context: ${percent(u.contextPercent, 0)} | 5hr${left(u.fiveHourResetsAt, now, false)}: ${percent(u.fiveHour, 1)} | ` +
  `7d${left(u.sevenDayResetsAt, now, true)}: ${percent(u.sevenDay, 1)}`
