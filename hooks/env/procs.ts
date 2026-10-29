import type { MachineProcess, MemoryReading, ProcessList } from '../../types'
import type { EnvRule, ResolvedPack } from '../packs/types'
import { strictestEnv } from './classify'

export type Platform = 'windows' | 'posix'

// The runtimes whose processes are worth matching. Filtering by name inside the query keeps it cheap: the
// unfiltered list costs twice the time and a hundred times the bytes.
const RUNTIMES = ['node', 'bun', 'deno', 'python', 'py.exe', 'dotnet', 'java', 'ruby', 'php', 'godot', 'postgres', 'redis']

// Memory counts as low under a gigabyte free, or a tenth of the machine, whichever is more.
const LOW_FREE_MB = 1024
const LOW_FREE_SHARE = 0.1
const KB_PER_MB = 1024
const BYTES_PER_MB = 1024 * 1024

export const isLowMemory = (freeMb: number, totalMb: number): boolean => freeMb < Math.max(LOW_FREE_MB, totalMb * LOW_FREE_SHARE)

const reading = (freeMb: number, totalMb: number, at: number): MemoryReading => ({ freeMb, totalMb, at, isLow: isLowMemory(freeMb, totalMb) })

const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'"
export const powershell = (script: string): string[] => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]

// Windows: one PowerShell call lists the runtimes' processes, matches each command line against the pack's regexes
// there, and sends back only ids, pids and working sets, with the machine's free memory. Command lines never leave
// PowerShell.
export const processQuery = (pack: ResolvedPack, platform: Platform): string[][] => {
  if (platform !== 'windows') return [['ps', '-eo', 'pid=,rss=,args='], ['cat', '/proc/meminfo']]
  const filter = RUNTIMES.map(n => `Name LIKE '${n.includes('.') ? n : n + '%'}'`).join(' OR ')
  const table = (rows: { id: string; pattern: string }[]) => rows.map(r => `@{i=${quote(r.id)};r=${quote(r.pattern)}}`).join(',')
  const matchers = table(pack.processes.map(p => ({ id: p.id, pattern: p.match })))
  const envs = table(pack.environments.flatMap(e => (e.argRegex ? [{ id: e.id, pattern: e.argRegex }] : [])))
  const hits = (list: string) => `@(${list}|Where-Object{[regex]::IsMatch($c,$_.r)}|ForEach-Object{$_.i})`
  return [
    powershell(
      [
        "$ErrorActionPreference='Stop'",
        `$P=@(${matchers})`,
        `$E=@(${envs})`,
        `$out=@(foreach($x in Get-CimInstance Win32_Process -Filter "${filter}"){$c=[string]$x.CommandLine;if(-not $c){continue};$m=${hits('$P')};if($m.Count -eq 0){continue};@{pid=$x.ProcessId;ws=$x.WorkingSetSize;m=$m;e=${hits('$E')}}})`,
        '$o=Get-CimInstance Win32_OperatingSystem',
        '@{procs=$out;freeKb=$o.FreePhysicalMemory;totalKb=$o.TotalVisibleMemorySize}|ConvertTo-Json -Compress -Depth 4',
      ].join(';'),
    ),
  ]
}

// Free memory alone, for the probe while a heavy task runs.
export const memoryQuery = (platform: Platform): string[] =>
  platform === 'windows'
    ? powershell('Get-CimInstance Win32_OperatingSystem|Select-Object FreePhysicalMemory,TotalVisibleMemorySize|ConvertTo-Json -Compress')
    : ['cat', '/proc/meminfo']

// PowerShell writes a one-element array as the element itself.
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])

const machineProcess = (pack: ResolvedPack, matcherIds: string[], envIds: string[], pid: number, ramMb: number): MachineProcess | null => {
  const matcher = pack.processes.find(p => matcherIds.includes(p.id))
  if (!matcher) return null
  const env = strictestEnv(pack.environments.filter(e => envIds.includes(e.id)))
  return { matcherId: matcher.id, label: matcher.label, kind: matcher.kind, pid, ramMb, ramWarnMb: matcher.ramWarnMb ?? 0, envLabel: env?.label ?? '', tone: env?.tone ?? '' }
}

const testsAny = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern).test(text)
  } catch {
    return false
  }
}

// /proc/meminfo's MemAvailable and MemTotal, in kB.
export const parseMeminfo = (text: string, at: number): MemoryReading | null => {
  const kb = (key: string) => Number(new RegExp('^' + key + ':\\s+(\\d+)', 'm').exec(text)?.[1] ?? NaN)
  const free = kb('MemAvailable')
  const total = kb('MemTotal')
  return Number.isFinite(free) && Number.isFinite(total) ? reading(Math.round(free / KB_PER_MB), Math.round(total / KB_PER_MB), at) : null
}

export const parseMemory = (platform: Platform, stdout: string, at: number): MemoryReading | null => {
  if (platform !== 'windows') return parseMeminfo(stdout, at)
  try {
    const o = JSON.parse(stdout) as { FreePhysicalMemory?: number; TotalVisibleMemorySize?: number }
    return typeof o.FreePhysicalMemory === 'number' && typeof o.TotalVisibleMemorySize === 'number'
      ? reading(Math.round(o.FreePhysicalMemory / KB_PER_MB), Math.round(o.TotalVisibleMemorySize / KB_PER_MB), at)
      : null
  } catch {
    return null
  }
}

// What the queries sent back, as the processes the pack knows and the free memory. On posix the command lines are
// matched here and go no further: only the fields of MachineProcess are kept.
export const parseProcesses = (
  pack: ResolvedPack,
  platform: Platform,
  outputs: string[],
  at: number,
  ms: number,
): { processes: ProcessList; memory: MemoryReading | null } => {
  const [first = '', second = ''] = outputs
  if (platform !== 'windows') {
    const found = first.split(/\r?\n/).flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!m) return []
      const args = m[3] ?? ''
      const matcherIds = pack.processes.filter(p => testsAny(p.match, args)).map(p => p.id)
      const envIds = pack.environments.filter((e: EnvRule) => e.argRegex && testsAny(e.argRegex, args)).map(e => e.id)
      const proc = machineProcess(pack, matcherIds, envIds, Number(m[1]), Math.round(Number(m[2]) / KB_PER_MB))
      return proc ? [proc] : []
    })
    return { processes: { list: found, at, ms, error: '' }, memory: parseMeminfo(second, at) }
  }
  try {
    const o = JSON.parse(first) as { procs?: unknown; freeKb?: number; totalKb?: number }
    const found = list(o.procs).flatMap(raw => {
      const p = raw as { pid?: number; ws?: number; m?: unknown; e?: unknown }
      const proc = machineProcess(pack, list(p.m).map(String), list(p.e).map(String), Number(p.pid), Math.round(Number(p.ws ?? 0) / BYTES_PER_MB))
      return proc ? [proc] : []
    })
    const memory = typeof o.freeKb === 'number' && typeof o.totalKb === 'number' ? reading(Math.round(o.freeKb / KB_PER_MB), Math.round(o.totalKb / KB_PER_MB), at) : null
    return { processes: { list: found, at, ms, error: '' }, memory }
  } catch {
    return { processes: { list: [], at, ms, error: 'the process list could not be read' }, memory: null }
  }
}
