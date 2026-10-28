import { describe, expect, test } from 'claude-code/testing'

import { isLowMemory, memoryQuery, parseMemory, parseProcesses, processQuery } from '../hooks/env/procs'
import { mergeLayers } from '../hooks/packs/merge'
import { NODE_VITE } from '../hooks/packs/node-vite'
import type { PackManifest } from '../hooks/packs/types'

const USER: PackManifest = {
  schema: 1,
  id: 'acme-shop',
  version: '1',
  processes: [{ id: 'worker', label: "the shop's worker", match: "worker\\.js|it's", kind: 'worker', ramWarnMb: 500 }],
  environments: [
    { id: 'staging', label: 'staging', tone: 'shared', argRegex: '--mode[= ]staging\\b' },
    { id: 'prod', label: 'production', tone: 'prod', argRegex: '--target prod\\b' },
  ],
}
const PACK = mergeLayers([
  { layer: 'built-in', pack: NODE_VITE },
  { layer: 'user', pack: USER },
]).pack

describe('the process query', () => {
  test('on Windows, one PowerShell call filters by runtime name and matches command lines inside PowerShell', async () => {
    const [query, ...more] = processQuery(PACK, 'windows')
    expect(more).toEqual([])
    expect(query!.slice(0, 4)).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'])
    const script = query![4]!
    expect(script).toMatch(/Get-CimInstance Win32_Process -Filter "Name LIKE 'node%' OR /)
    expect(script).toMatch(/Win32_OperatingSystem/)
    // Each pattern is a PowerShell literal: a quote inside it is doubled.
    expect(script).toContain("@{i='worker';r='worker\\.js|it''s'}")
    expect(script).toContain("@{i='staging';r='--mode[= ]staging\\b'}")
    // What comes back: ids, pids and working sets, never the command line.
    expect(script).toMatch(/@\{pid=\$x\.ProcessId;ws=\$x\.WorkingSetSize;m=\$m;e=/)
    expect(script).not.toMatch(/CommandLine[^;]*ConvertTo-Json/)
  })

  test('elsewhere, ps and /proc/meminfo; the memory probe alone is one cheap call', async () => {
    expect(processQuery(PACK, 'posix')).toEqual([['ps', '-eo', 'pid=,rss=,args='], ['cat', '/proc/meminfo']])
    expect(memoryQuery('windows')[4]).toMatch(/^Get-CimInstance Win32_OperatingSystem\|/)
    expect(memoryQuery('posix')).toEqual(['cat', '/proc/meminfo'])
  })
})

describe('reading what came back', () => {
  test('Windows: a lone process and lone ids come back unwrapped, and still read as lists', async () => {
    const out = JSON.stringify({ procs: { pid: 4242, ws: 734003200, m: 'worker', e: ['staging', 'prod'] }, freeKb: 8388608, totalKb: 16777216 })
    const { processes, memory } = parseProcesses(PACK, 'windows', [out], 5000, 900)
    expect(processes).toEqual({
      list: [{ matcherId: 'worker', label: "the shop's worker", kind: 'worker', pid: 4242, ramMb: 700, ramWarnMb: 500, envLabel: 'production', tone: 'prod' }],
      at: 5000,
      ms: 900,
      error: '',
    })
    expect(memory).toEqual({ freeMb: 8192, totalMb: 16384, at: 5000, isLow: false })
  })

  test('Windows: an answer that is not JSON is an error, not an empty machine', async () => {
    expect(parseProcesses(PACK, 'windows', ['Get-CimInstance : Access denied'], 1, 2).processes.error).toMatch(/could not be read/)
  })

  test('posix: command lines are matched here and none of their text is kept', async () => {
    const ps = [
      '  101  52000 node /app/node_modules/.bin/vite --mode staging --token SENTINEL_CMD_123',
      '  102   9000 /usr/bin/python3 unrelated.py',
      '  103 800000 node worker.js --target prod --password SENTINEL_CMD_456',
    ].join('\n')
    const meminfo = 'MemTotal:       16384000 kB\nMemFree:          200000 kB\nMemAvailable:    1024000 kB\n'
    const result = parseProcesses(PACK, 'posix', [ps, meminfo], 7, 3)
    expect(result.processes.list.map(p => [p.matcherId, p.pid, p.envLabel])).toEqual([
      ['vite-dev', 101, 'staging'],
      ['worker', 103, 'production'],
    ])
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL/)
    expect(result.memory).toEqual({ freeMb: 1000, totalMb: 16000, at: 7, isLow: true })
  })

  test('memory is low under a gigabyte free, or a tenth of the machine, whichever is more', async () => {
    expect([isLowMemory(1500, 16000), isLowMemory(1700, 16000), isLowMemory(900, 4000), isLowMemory(1100, 4000)]).toEqual([true, false, true, false])
    expect(parseMemory('windows', '{"FreePhysicalMemory":2097152,"TotalVisibleMemorySize":8388608}', 9)).toEqual({ freeMb: 2048, totalMb: 8192, at: 9, isLow: false })
    expect(parseMemory('windows', 'nope', 9)).toBeNull()
  })
})
