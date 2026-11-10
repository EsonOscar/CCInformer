import { describe, expect, test } from 'claude-code/testing'

import { taskEnds } from '../hooks/env/classify'
import { MAX_SHELLS, closedShells, endedShells, openShells, ownedEnds, shellFacts, shellFrom, withShell } from '../hooks/env/shells'
import type { ShellRow } from '../types'

// Invented commands and hosts throughout.
const row = (id: string, over: Partial<ShellRow> = {}): ShellRow => ({ id, tool: 'Bash', command: 'npm run dev', startedAt: 1000, endedAt: 0, status: 'running', owner: '', ...over })
const MINUTE = 60_000

describe('the row of a call that left a shell open', () => {
  test('a Bash or PowerShell call with a background task id is a row; a foreground one is not', async () => {
    expect(shellFrom('Bash', { command: 'npm run dev' }, { stdout: '', backgroundTaskId: 'bg-1' }, '', 5)).toEqual(row('bg-1', { startedAt: 5 }))
    expect(shellFrom('PowerShell', { command: 'Start-Sleep 60' }, { backgroundTaskId: 'bg-2' }, '', 5)).toEqual(
      row('bg-2', { tool: 'PowerShell', command: 'Start-Sleep 60', startedAt: 5 }),
    )
    expect(shellFrom('Bash', { command: 'ls' }, { stdout: 'a' }, '', 5)).toBeNull()
    expect(shellFrom('Bash', { command: 'ls' }, { backgroundTaskId: '' }, '', 5)).toBeNull()
    expect(shellFrom('Bash', { command: 'ls' }, 'text', '', 5)).toBeNull()
    expect(shellFrom('Bash', { command: 'ls' }, undefined, '', 5)).toBeNull()
    // Another tool's result with the same field is no shell.
    expect(shellFrom('Read', { file_path: 'a' }, { backgroundTaskId: 'bg-3' }, '', 5)).toBeNull()
  })

  test('a Monitor is a row by its task id: its command, or its description when it watches a WebSocket', async () => {
    expect(shellFrom('Monitor', { description: 'the build log', command: 'tail -f build.log' }, { taskId: 'mon-1', timeoutMs: 1 }, '', 5)).toEqual(
      row('mon-1', { tool: 'Monitor', command: 'tail -f build.log', startedAt: 5 }),
    )
    const socket = shellFrom('Monitor', { description: 'the price feed', ws: { url: 'wss://feed.example.test/?token=fake' } }, { taskId: 'mon-2' }, '', 5)
    expect(socket?.command).toBe('the price feed')
    expect(JSON.stringify(socket)).not.toContain('fake')
    // A Monitor's result has no backgroundTaskId, and a Bash result's taskId is not read.
    expect(shellFrom('Monitor', { command: 'tail -f a' }, { backgroundTaskId: 'bg-1' }, '', 5)).toBeNull()
    expect(shellFrom('Bash', { command: 'ls' }, { taskId: 'mon-3' }, '', 5)).toBeNull()
  })

  test('the command is its first line, without a carriage return, at most 200 characters', async () => {
    expect(shellFrom('PowerShell', { command: 'npm run dev\r\nWrite-Host done' }, { backgroundTaskId: 'bg-1' }, '', 5)?.command).toBe('npm run dev')
    const long = shellFrom('Bash', { command: 'x'.repeat(500) + '\nsecond' }, { backgroundTaskId: 'bg-1' }, '', 5)?.command ?? ''
    expect(long).toBe('x'.repeat(199) + '…')
    expect(shellFrom('Bash', {}, { backgroundTaskId: 'bg-1' }, '', 5)?.command).toBe('')
  })

  test('an agent owns a row only when its final response ends the command', async () => {
    const result = { backgroundTaskId: 'bg-1' }
    expect(shellFrom('Bash', { command: 'a' }, { ...result, backgroundEndsWithFinalResponse: true }, 'agent-1', 5)?.owner).toBe('agent-1')
    expect(shellFrom('Bash', { command: 'a' }, result, 'agent-1', 5)?.owner).toBe('')
    expect(shellFrom('Bash', { command: 'a' }, { ...result, backgroundEndsWithFinalResponse: true }, '', 5)?.owner).toBe('')
  })
})

describe('the list of shells', () => {
  test('over the cap the oldest ended row goes first; a running one only when all run', async () => {
    const running = Array.from({ length: MAX_SHELLS }, (_, i) => row('r' + i))
    const mixed = running.map((s, i) => (i === 3 || i === 7 ? { ...s, status: 'completed', endedAt: 2000 } : s))
    const kept = withShell(mixed, row('new'))
    expect(kept).toHaveLength(MAX_SHELLS)
    expect(kept.map(s => s.id)).not.toContain('r3')
    expect(kept.map(s => s.id)).toContain('r7')
    expect(kept.at(-1)?.id).toBe('new')

    const all = withShell(running, row('new'))
    expect(all).toHaveLength(MAX_SHELLS)
    expect(all[0]?.id).toBe('r1')
    // A row with an id already listed replaces it.
    expect(withShell([row('a'), row('b')], row('a', { command: 'again' })).map(s => s.id + ':' + s.command)).toEqual(['b:npm run dev', 'a:again'])
  })

  test('only a running row ends, and the first end stands', async () => {
    const list = [row('a'), row('b', { status: 'killed', endedAt: 1500 })]
    const ended = endedShells(list, [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }, { id: 'zz', status: 'failed' }], 3000)
    expect(ended).toEqual([row('a', { status: 'completed', endedAt: 3000 }), row('b', { status: 'killed', endedAt: 1500 })])
    expect(endedShells(list, [{ id: 'zz', status: 'failed' }], 3000)).toEqual(list)
  })

  test("an agent's turn ends the running rows it owns, and no others", async () => {
    const list = [row('a', { owner: 'agent-1' }), row('b', { owner: 'agent-2' }), row('c'), row('d', { owner: 'agent-1', status: 'killed', endedAt: 5 })]
    expect(ownedEnds(list, 'agent-1')).toEqual([{ id: 'a', status: 'ended' }])
    expect(ownedEnds(list, '')).toEqual([])
  })

  test('a notification names each task that ended and how; a block with no status is no end', async () => {
    const text = [
      '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>',
      '<task-notification><task-id>bg-2</task-id><status> failed </status></task-notification>',
      '<task-notification><task-id>mon-3</task-id><event>line</event></task-notification>',
      '<task-notification><task-id>bg-4</task-id><status></status></task-notification>',
    ].join('\n')
    expect(taskEnds(text)).toEqual([{ id: 'bg-1', status: 'completed' }, { id: 'bg-2', status: 'failed' }])
    expect(taskEnds('a prompt')).toEqual([])
  })

  test('what a row says: how long it has been open, or how it ended, how long it ran and when', async () => {
    expect(shellFacts(row('a'), 1000 + 2 * MINUTE + 3000)).toBe('Bash · 2m03s')
    expect(shellFacts(row('a', { status: 'completed', endedAt: 1000 + 2 * MINUTE + 3000 }), 1000 + 7 * MINUTE + 3000)).toBe('completed · ran 2m03s · 5m ago')
  })

  test('open rows come newest first, ended ones by their latest end', async () => {
    const list = [row('a', { startedAt: 1 }), row('b', { startedAt: 2, status: 'completed', endedAt: 9 }), row('c', { startedAt: 3 }), row('d', { startedAt: 4, status: 'killed', endedAt: 12 })]
    expect(openShells(list).map(s => s.id)).toEqual(['c', 'a'])
    expect(closedShells(list).map(s => s.id)).toEqual(['d', 'b'])
  })
})
