import type { AgentStatus, ModelUsage, TurnCompleteReason } from 'claude-code'

import type { AgentRow, AgentState, WorkflowRun } from '../types'
import { firstLine, lastSegment } from './format'
import { parseWorkflowMeta } from './parse'

// Plain helpers the hooks use to turn an event into a row.

export const TOUCHING_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit']
const PUSH = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge|ready)\b/

export const isPush = (command: unknown): boolean => typeof command === 'string' && PUSH.test(command)

// mcp__claude_ai_Example__run_query → run_query
export const toolLabel = (tool: string): string => (tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool)

// One short line for what a tool call is about.
export const summarize = (tool: string, input: Record<string, unknown>): string => {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool.startsWith('mcp__')) return tool.split('__')[1] ?? ''
  if (text('file_path')) return lastSegment(text('file_path'))
  if (text('notebook_path')) return lastSegment(text('notebook_path'))
  if (tool === 'Workflow') return text('scriptPath') ? lastSegment(text('scriptPath')) : parseWorkflowMeta(text('script')).name
  const first = ['command', 'pattern', 'url', 'description', 'skill', 'query', 'prompt'].map(text).find(Boolean) ?? ''
  return firstLine(first)
}

export const endedState = (reason: TurnCompleteReason): AgentState =>
  reason === 'error' || reason === 'refusal' ? 'failed' : reason === 'aborted' ? 'killed' : 'done'

export const LISTED_STATES: Record<AgentStatus, AgentState> = {
  pending: 'running',
  running: 'running',
  waiting: 'waiting',
  idle: 'waiting',
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

export const isOver = (state: AgentState): boolean => state !== 'running' && state !== 'waiting'

// The context one request carried: fresh input plus what the cache served and wrote. This is what the workflow
// bar shows for an agent (its last request's); the bar adds only the first streamed output tokens, so leave output out.
export const contextTokens = (u: ModelUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + (u.cache_creation_input_tokens ?? 0)

// Appends a row and keeps only the newest `max`.
export const capped = <T>(list: readonly T[], row: T, max: number): T[] => [...list, row].slice(-max)

// Keeps the agents of the runs still listed, and every agent outside a workflow.
export const pruneAgents = (agents: AgentRow[], runs: WorkflowRun[]): AgentRow[] =>
  agents.filter(a => !a.runId || runs.some(r => r.toolUseId === a.toolUseId))

// A session's first words for its current task: the first line of the prompt that started the turn, shortened.
const TASK_CHARS = 90
export const taskOf = (prompt: string): string => {
  const line = firstLine(prompt.trim()).replace(/\s+/g, ' ')
  return line.length > TASK_CHARS ? line.slice(0, TASK_CHARS - 1) + '…' : line
}
