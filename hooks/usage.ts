import type { UsageReading } from '../types'

type Context = { tokens?: number; window?: number; percent?: number }
type RateLimit = { kind: string; percentUsed: number }

// The session's usage as the pane's footer shows it: the context window's fill, and the subscription's 5-hour and
// 7-day windows (null where there's no reading yet, or no subscription).
export const readUsage = (context: Context | undefined, rateLimits: readonly RateLimit[] | undefined): UsageReading => {
  const fill = context?.percent ?? (context?.window && context.tokens !== undefined ? (context.tokens / context.window) * 100 : undefined)
  const window = (kind: string) => rateLimits?.find(r => r.kind === kind)?.percentUsed ?? null
  return { contextPercent: fill === undefined ? null : fill, fiveHour: window('five_hour'), sevenDay: window('seven_day') }
}

// "34%", with the limits' one decimal kept ("23.5%"); "–" for no reading.
const percent = (n: number | null, decimals: number) => (n === null ? '–' : `${Number(n.toFixed(decimals))}%`)

export const usageLine = (u: UsageReading): string =>
  `Context: ${percent(u.contextPercent, 0)} | 5 hour limit: ${percent(u.fiveHour, 1)} | 7 day limit: ${percent(u.sevenDay, 1)}`
