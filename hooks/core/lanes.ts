import type { Ran } from '../collect'

// Quick reads (git, gh) share the light lane, a few at once; long jobs (git fetch, later checks and builds) take
// the heavy lane one at a time, so they never hold up the reads.
export const LIGHT_SLOTS = 4
export const HEAVY_SLOTS = 1
export const LIGHT_TIMEOUT_MS = 20_000
export const HEAVY_TIMEOUT_MS = 120_000

// Runs one command with a timeout, in `cwd` when given (else the session's folder). The hooks module makes it from
// $.process.run, and nothing else runs commands.
export type Run = (argv: string[], timeoutMs: number, cwd?: string) => Promise<Ran>
// Runs one command in its turn; the lane's timeout applies unless the caller gives one.
export type Lane = (argv: string[], timeoutMs?: number, cwd?: string) => Promise<Ran>
export type Lanes = { light: Lane; heavy: Lane }

export const createLanes = (run: Run): Lanes => ({
  light: createLane(run, LIGHT_SLOTS, LIGHT_TIMEOUT_MS),
  heavy: createLane(run, HEAVY_SLOTS, HEAVY_TIMEOUT_MS),
})

// First come, first served, at most `slots` commands at once.
const createLane = (run: Run, slots: number, timeoutMs: number): Lane => {
  let running = 0
  const waiting: (() => void)[] = []
  const take = (): Promise<void> => {
    if (running < slots) {
      running += 1
      return Promise.resolve()
    }
    return new Promise(resolve => waiting.push(resolve))
  }
  // A finished command hands its slot straight to the next in line, so a newcomer can't slip in between.
  const free = () => {
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
  return async (argv, ms = timeoutMs, cwd) => {
    await take()
    try {
      return await run(argv, ms, cwd)
    } finally {
      free()
    }
  }
}

// Runs a job unless the same job is still running, so a poll that comes due while its last run is busy is skipped.
export type Solo = (key: string, job: () => Promise<void>) => Promise<void>

export const createSolo = (): Solo => {
  const busy = new Set<string>()
  return async (key, job) => {
    if (busy.has(key)) return
    busy.add(key)
    try {
      await job()
    } finally {
      busy.delete(key)
    }
  }
}
