import type { EngineInterface } from 'claude-code'

import type { CiActiveState, CiSnapshot, PackReport } from '../../types'
import type { Lane } from '../core/lanes'
import type { May } from '../core/permissions'
import type { NoiseRule } from '../packs/types'
import {
  CI_TEXTS,
  DIFF_CHARS,
  LOG_CAP_CHARS,
  LOG_CHARS,
  LOG_LINES,
  LOGS_CHARS,
  checkKey,
  failedChecks,
  failedPart,
  handoffDiff,
  handoffPrompt,
  logCommands,
  stillRunning,
  tailOf,
} from './investigate'

// The mode and the claims, per repo, in the store every session shares.
const STORE_MODE = 'ciMode:'
const STORE_CLAIMS = 'ciInvestigated:'
// One per check handed over (a commit can hand several over).
const CLAIMS_KEPT = 60
// How long a claim waits before reading the claims back: another session's claim on the same commit lands by then.
const CLAIM_SETTLE_MS = 1000
// Logs still being read after this have hung (the session reloaded mid-read, say); a new look may start.
const RUN_HUNG_MS = 5 * 60_000

// What active CI mode takes from the session: the light lane, the repo (once the pack has loaded), whether a person is
// there, this session's id, the CI snapshot and a refresh of it, the state through register.tsx's mirror (read at
// once, written by a change), and how to tell the person something.
export type CiActiveDeps = {
  light: Lane
  // The resolved pack's noise rules ([] with none): the hand-off's diff leaves that noise out.
  noise: () => Promise<NoiseRule[]>
  report: () => Promise<PackReport | null>
  isInteractive: boolean
  selfId: string
  ci: () => Promise<CiSnapshot | null>
  refresh: () => Promise<void>
  state: () => CiActiveState
  save: (change: (s: CiActiveState) => CiActiveState) => Promise<unknown>
  notify: (text: string) => void
  may: May
}

export type CiActive = {
  // The repo's mode from the store into the state, for the view.
  readMode: () => Promise<void>
  // Switches the repo's mode; says how it went.
  setMode: (mode: CiActiveState['mode']) => Promise<string>
  // A check failed (early, while others still run, or when the commit's checks finished): its new failures are looked
  // into when the repo is active, one look at a time.
  onFailed: (ci: CiSnapshot) => Promise<void>
  // The person asked: the branch's failing checks, looked into in either mode.
  investigateNow: () => Promise<void>
}

// Active CI mode: a failed check, its logs and the diff handed to the main session as one turn that looks into it
// (which register.tsx keeps read-only).
export function createCiActive($: EngineInterface, deps: CiActiveDeps): CiActive {
  let handoffs = 0
  // Looks run one at a time, each holding the queue until its turn has started (or was refused): the read-only guard
  // knows one waiting turn's marker, so a second hand-off must not replace it. `queued` counts the looks waiting or
  // running.
  let queue: Promise<void> = Promise.resolve()
  let queued = 0
  // While a person's look refreshes CI, the automatic looks that refresh would start are left out: the asked look that
  // follows covers the same failures.
  let isAsking = false
  const enqueue = (fn: () => Promise<void>) => {
    queued += 1
    queue = queue
      .then(fn)
      .catch(() => undefined)
      .then(() => void (queued -= 1))
    return queue
  }

  const run = (argv: string[], root: string) =>
    deps.light(argv, undefined, root).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const isRunning = (now: number) => {
    const r = deps.state().run
    return !!r && r.state === 'investigating' && now - r.at < RUN_HUNG_MS
  }
  const fail = async (why: string, text: string) => {
    await deps.save(s => ({ ...s, run: s.run ? { ...s.run, state: 'failed', why, marker: '' } : null }))
    deps.notify(text) // relay
  }

  type Claim = { head: string; session: string; check?: string }
  const readClaims = async (repoKey: string) => {
    const stored = await $.store.get(STORE_CLAIMS + repoKey)
    return Array.isArray(stored) ? (stored as Claim[]) : []
  }
  // Claims these checks of the commit for this session and returns the ones it holds: with `elect`, those whose first
  // claim, read back once another session's claim on them would have landed, is this session's; without, the ones it
  // wrote. Two sessions that claim at once both write, and the first claim read back wins. The claims are written before
  // the settle: that is what keeps an early look, an end-of-run look and an older version's look (which takes any claim
  // on the commit as its own) from handing a check over twice. A claim with no check, an older version's, covers the
  // whole commit.
  const claimChecks = async (repoKey: string, head: string, keys: string[], elect: boolean) => {
    const before = await readClaims(repoKey)
    const onHead = before.filter(c => c.head === head)
    if (onHead.some(c => !c.check)) return []
    const taken = new Set(onHead.map(c => c.check))
    const fresh = keys.filter(k => !taken.has(k))
    if (!fresh.length) return []
    await $.store.set(STORE_CLAIMS + repoKey, [...before, ...fresh.map(check => ({ head, session: deps.selfId, check }))].slice(-CLAIMS_KEPT))
    if (!elect) return fresh
    await $.clock.sleep(CLAIM_SETTLE_MS)
    const after = await readClaims(repoKey)
    return fresh.filter(k => after.find(c => c.head === head && (!c.check || c.check === k))?.session === deps.selfId)
  }

  // An automatic look hands over the failed checks no session has yet; an asked one hands over every failed check
  // and claims them, so no automatic look repeats them.
  const look = async (ci: CiSnapshot, asked: boolean) => {
    if (!deps.isInteractive || (!asked && !deps.may('claude.ciHandoff'))) return
    if (isRunning(await $.clock.now())) return void (asked && deps.notify(CI_TEXTS.replyBusy))
    const report = await deps.report()
    if (!report?.repoKey) return void (asked && deps.notify(CI_TEXTS.replyNoRepo))
    if (!asked && (await $.store.get(STORE_MODE + report.repoKey)) !== 'active') return
    const failed = failedChecks(ci)
    if (!failed.length) return void (asked && deps.notify(CI_TEXTS.replyNoFailure)) // asked
    const won = await claimChecks(report.repoKey, ci.head, failed.map(checkKey), !asked)
    const checks = asked ? failed : failed.filter(c => won.includes(checkKey(c)))
    if (!checks.length) return
    const keys = new Set(checks.map(checkKey))
    const before = new Set((await readClaims(report.repoKey)).filter(c => c.head === ci.head && c.check && !keys.has(c.check)).map(c => c.check))
    const earlier = ci.checks.filter(c => before.has(checkKey(c))).map(c => c.name)

    const at = await $.clock.now()
    await deps.save(s => ({ ...s, run: { head: ci.head, state: 'investigating', why: '', marker: '', at } }))
    deps.notify(stillRunning(ci).length ? CI_TEXTS.startedEarly : CI_TEXTS.started) // may: claude.ciHandoff
    // One at a time, so the reads never crowd the light lane. A job whose run still goes on has no failed-steps log in
    // gh yet; its own log is read through the API instead, and cut to what failed.
    const logs: { check: string; tail: string; isCut: boolean }[] = []
    let budget = LOGS_CHARS
    for (const { check, argv, fallback } of logCommands(checks)) {
      if (budget <= 0) break
      let ran = await run(argv, report.root)
      let text = ran.exitCode === 0 ? ran.stdout : ''
      if (!text.trim() && fallback) {
        ran = await run(fallback, report.root)
        text = ran.exitCode === 0 ? failedPart(ran.stdout) : ''
      }
      if (!text.trim()) continue
      const { tail, isCut } = tailOf(text, LOG_LINES, Math.min(LOG_CHARS, budget))
      budget -= tail.length
      logs.push({ check, tail, isCut: isCut || ran.stdout.length >= LOG_CAP_CHARS })
    }
    const diffArgv = ci.pr ? ['gh', 'pr', 'diff', String(ci.pr.number)] : ['git', 'show', '--format=', '--patch', '--src-prefix=a/', '--dst-prefix=b/', ci.head]
    const diffRan = await run(diffArgv, report.root)
    const diffText = diffRan.exitCode === 0 ? diffRan.stdout : ''
    // The pack's noise (generated output, editor rewrites) is left out and named, before the cut.
    const diff = handoffDiff(diffText, await deps.noise(), 'isStdoutTruncated' in diffRan && !!diffRan.isStdoutTruncated, DIFF_CHARS)

    handoffs += 1
    const { text, marker } = handoffPrompt(ci, checks, logs, diff, handoffs, earlier)
    // Switched off while the logs were read: nothing is handed over.
    if (!asked && !deps.may('claude.ciHandoff'))
      return void (await deps.save(s => ({ ...s, run: s.run && { ...s.run, state: 'failed', why: CI_TEXTS.switchedOff, marker: '' } })))
    // The marker first, so the turn that brings it is known as soon as it starts. The submit resolves only once that
    // turn has started, and is awaited so the queue's next look waits for it.
    await deps.save(s => ({ ...s, run: s.run && { ...s.run, state: 'waiting', marker } }))
    const result = await $.prompt.submit({ text }).catch((err: unknown) => ({ drop: String(err) })) // may: claude.ciHandoff (or asked)
    if (result.drop !== undefined) await fail(result.drop, CI_TEXTS.refused(result.drop))
  }

  return {
    readMode: async () => {
      const report = await deps.report()
      if (!report?.repoKey) return
      const mode = (await $.store.get(STORE_MODE + report.repoKey)) === 'active' ? 'active' : 'passive'
      if (deps.state().mode !== mode) await deps.save(s => ({ ...s, mode }))
    },
    setMode: async mode => {
      const report = await deps.report()
      if (!report?.repoKey) return CI_TEXTS.replyNoRepo
      if (mode === 'active') await $.store.set(STORE_MODE + report.repoKey, 'active')
      else await $.store.delete(STORE_MODE + report.repoKey)
      await deps.save(s => ({ ...s, mode }))
      if (mode === 'active') return CI_TEXTS.modeOn + (deps.may('claude.ciHandoff') ? '' : CI_TEXTS.heldOff)
      return CI_TEXTS.modeOff + (deps.may('notify.ciToast') ? '' : CI_TEXTS.quietOff)
    },
    onFailed: ci => (isAsking ? Promise.resolve() : enqueue(() => look(ci, false))),
    investigateNow: async () => {
      if (queued) return void deps.notify(CI_TEXTS.replyBusy) // asked
      isAsking = true
      try {
        await deps.refresh()
      } finally {
        isAsking = false
      }
      const ci = await deps.ci()
      if (!ci) return void deps.notify(CI_TEXTS.replyNoFailure) // asked
      void enqueue(() => look(ci, true))
    },
  }
}
