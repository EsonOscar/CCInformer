import { describe, expect, test } from 'claude-code/testing'

import { isLowMemory, memoryQuery, parseMemory, parseProcesses, parseVmStat, processQuery } from '../hooks/env/procs'
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
    // A pattern .NET can't read fails only its own match: the script stops on any other error.
    expect(script).toContain('Where-Object{try{[regex]::IsMatch($c,$_.r)}catch{$false}}')
    // What comes back: ids, pids and working sets, never the command line.
    expect(script).toMatch(/@\{pid=\$x\.ProcessId;ws=\$x\.WorkingSetSize;m=\$m;e=/)
    expect(script).not.toMatch(/CommandLine[^;]*ConvertTo-Json/)
  })

  test('elsewhere, ps and /proc/meminfo; the memory probe alone is one cheap call', async () => {
    expect(processQuery(PACK, 'posix')).toEqual([['ps', '-eo', 'pid=,rss=,args='], ['cat', '/proc/meminfo']])
    expect(memoryQuery('windows')[4]).toMatch(/^Get-CimInstance Win32_OperatingSystem\|/)
    expect(memoryQuery('posix')).toEqual(['cat', '/proc/meminfo'])
  })

  test('on macOS, ps and one call for the machine size and vm_stat, which the probe uses alone', async () => {
    expect(processQuery(PACK, 'macos')).toEqual([['ps', '-eo', 'pid=,rss=,args='], ['sh', '-c', 'sysctl hw.memsize && vm_stat']])
    expect(memoryQuery('macos')).toEqual(['sh', '-c', 'sysctl hw.memsize && vm_stat'])
  })
})

// `sysctl hw.memsize && vm_stat` as a GitHub macos-latest runner answered it (Apple silicon, macOS 26, 16 KiB pages).
const MACOS_RUNNER = `hw.memsize: 7516192768
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5657.
Pages active:                                 193653.
Pages inactive:                               191149.
Pages speculative:                              4622.
Pages throttled:                                   0.
Pages wired down:                              54461.
Pages purgeable:                                1968.
"Translation faults":                        1885206.
Pages copy-on-write:                          128401.
Pages zero filled:                            546336.
Pages reactivated:                             52021.
Pages purged:                                   2984.
File-backed pages:                            210001.
Anonymous pages:                              179423.
Pages stored in compressor:                    30546.
Pages occupied by compressor:                   8331.
Decompressions:                                 2057.
Compressions:                                  34338.
Pageins:                                      271743.
Pageouts:                                       1303.
Swapins:                                           0.
Swapouts:                                          0.
`

describe('reading macOS memory', () => {
  test('free is the free, inactive and speculative pages times vm_stat page size', async () => {
    // (5657 + 191149 + 4622) pages of 16384 bytes is 3147 MB of 7168.
    expect(parseVmStat(MACOS_RUNNER, 4)).toEqual({ freeMb: 3147, totalMb: 7168, at: 4, isLow: false })
    expect(parseMemory('macos', MACOS_RUNNER, 4)).toEqual(parseVmStat(MACOS_RUNNER, 4))
  })

  test('the page size comes from vm_stat, so 4 KiB pages (Intel) read right too', async () => {
    const intel = 'hw.memsize: 17179869184\nMach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free:  100000.\nPages inactive:  50000.\nPages speculative:  12000.\n'
    // 162000 pages of 4096 bytes is 633 MB of 16384: low, under a tenth of the machine.
    expect(parseVmStat(intel, 1)).toEqual({ freeMb: 633, totalMb: 16384, at: 1, isLow: true })
  })

  test('a readout missing the size, the page size or a count is no reading', async () => {
    expect(parseVmStat(MACOS_RUNNER.replace(/^hw\.memsize.*\n/, ''), 1)).toBeNull()
    expect(parseVmStat(MACOS_RUNNER.replace('page size of 16384 bytes', 'page size unknown'), 1)).toBeNull()
    expect(parseVmStat(MACOS_RUNNER.replace(/^Pages inactive.*\n/m, ''), 1)).toBeNull()
    expect(parseVmStat('', 1)).toBeNull()
    // /proc/meminfo on a Mac would be read as nothing, not as Linux numbers.
    expect(parseMemory('macos', 'MemTotal: 16384000 kB\nMemAvailable: 1024000 kB\n', 1)).toBeNull()
  })

  test('the process list on macOS reads its memory from vm_stat', async () => {
    const ps = '  103 800000 node worker.js --target prod\n'
    const result = parseProcesses(PACK, 'macos', [ps, MACOS_RUNNER], 7, 3)
    expect(result.processes.list.map(p => p.matcherId)).toEqual(['worker'])
    expect(result.memory).toEqual({ freeMb: 3147, totalMb: 7168, at: 7, isLow: false })
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
