// How the pane writes times, counts and states.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

// 0.4s, 12s, 1m02s, 1h05m
export const duration = (ms: number): string => {
  if (!(ms >= 0)) return ''
  if (ms < 10 * SECOND) return (ms / SECOND).toFixed(1) + 's'
  if (ms < MINUTE) return Math.round(ms / SECOND) + 's'
  if (ms < HOUR) {
    const s = Math.floor((ms % MINUTE) / SECOND)
    return Math.floor(ms / MINUTE) + 'm' + String(s).padStart(2, '0') + 's'
  }
  return Math.floor(ms / HOUR) + 'h' + String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, '0') + 'm'
}

// 812, 12.3k, 1.2M
export const tokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

const SPINNER = ['◐', '◓', '◑', '◒']
export const spinner = (now: number): string => SPINNER[Math.floor(now / SECOND) % SPINNER.length] ?? '●'

// "just now", "42m ago", "3h ago", "2d ago"
export const ago = (ms: number): string =>
  ms < MINUTE ? 'just now' : ms < HOUR ? Math.floor(ms / MINUTE) + 'm ago' : ms < 24 * HOUR ? Math.floor(ms / HOUR) + 'h ago' : Math.floor(ms / (24 * HOUR)) + 'd ago'

// "10-21 13:07", in local time.
export const shortDate = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export const since = (now: number, iso: string): number => (iso ? now - Date.parse(iso) : 0)

// claude-opus-5-5 → opus-5-5
export const shortModel = (model: string): string => model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const lastSegment = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const firstLine = (text: string): string => text.split('\n')[0] ?? ''
