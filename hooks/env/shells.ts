import type { ShellRow } from '../../types'
import { ago, duration, firstLine } from '../format'

// The background shells this session started, for Now › Shells. Claude Code gives a mod no list of them, so the rows
// are built from the session's own calls: a Bash or PowerShell call that went to the background, a Monitor, and what
// ends each (its task notification, a TaskStop, or its agent's turn ending).

export const MAX_SHELLS = 30
const COMMAND_CHARS = 200

const SHELL_TOOLS = ['Bash', 'PowerShell']

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

const capped = (line: string): string => (line.length > COMMAND_CHARS ? line.slice(0, COMMAND_CHARS - 1) + '…' : line)

// The row of a call that left a shell open in the background, or null: a Bash or PowerShell result with a background
// task id (Claude asked for it, or the person sent the command there), a Monitor's with its task id. The command is
// its first line; a Monitor on a WebSocket shows its description, as a URL can carry a token. `owner` is the agent
// whose final response terminates the command, which then gets no notification.
export const shellFrom = (tool: string, input: Record<string, unknown>, result: unknown, agentId: string, startedAt: number): ShellRow | null => {
  const r = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  const id = SHELL_TOOLS.includes(tool) ? text(r.backgroundTaskId) : tool === 'Monitor' ? text(r.taskId) : ''
  if (!id) return null
  const line = firstLine(text(input.command)).replace(/\r$/, '') || (tool === 'Monitor' ? firstLine(text(input.description)) : '')
  return { id, tool, command: capped(line), startedAt, endedAt: 0, status: 'running', owner: r.backgroundEndsWithFinalResponse === true ? agentId : '' }
}

const isRunning = (s: ShellRow): boolean => s.status === 'running'

// Adds a row and keeps MAX_SHELLS: the oldest ended one goes first, a running one only when every row runs.
export const withShell = (list: ShellRow[], row: ShellRow): ShellRow[] => {
  const rows = [...list.filter(s => s.id !== row.id), row]
  if (rows.length <= MAX_SHELLS) return rows
  const ended = rows.findIndex(s => !isRunning(s))
  const drop = ended === -1 ? 0 : ended
  return rows.filter((_, i) => i !== drop)
}

// Ends the running rows these name. Only a running row can end, so the first end stands.
export const endedShells = (list: ShellRow[], ends: { id: string; status: string }[], at: number): ShellRow[] =>
  list.map(s => {
    const end = isRunning(s) ? ends.find(e => e.id === s.id) : undefined
    return end ? { ...s, status: end.status, endedAt: at } : s
  })

// The ends of the running rows an agent's final response terminates.
export const ownedEnds = (list: ShellRow[], agentId: string): { id: string; status: string }[] =>
  list.filter(s => isRunning(s) && s.owner !== '' && s.owner === agentId).map(s => ({ id: s.id, status: 'ended' }))

// `Bash · 2m03s` while it runs; `completed · ran 2m03s · 5m ago` once it has ended.
export const shellFacts = (s: ShellRow, now: number): string =>
  isRunning(s) ? `${s.tool} · ${duration(now - s.startedAt)}` : `${s.status} · ran ${duration(s.endedAt - s.startedAt)} · ${ago(now - s.endedAt)}`

// Open: the running rows, newest first. Ended: the others, the latest end first.
export const openShells = (list: ShellRow[]): ShellRow[] => list.filter(isRunning).sort((a, b) => b.startedAt - a.startedAt)
export const closedShells = (list: ShellRow[]): ShellRow[] => list.filter(s => !isRunning(s)).sort((a, b) => b.endedAt - a.endedAt)
