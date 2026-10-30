import type { EngineInterface } from 'claude-code'

import type { CiActiveState, CiSnapshot, PackReport } from '../../types'
import type { Lane } from '../core/lanes'
import type { May } from '../core/permissions'
import {
  CI_TEXTS,
  DIFF_CHARS,
  LOG_CAP_CHARS,
  LOG_CHARS,
  LOG_LINES,
  LOGS_CHARS,
  failedChecks,
  handoffPrompt,
  logCommands,
  tailOf,
} from './investigate'

// The mode and the claims, per repo, in the store every session shares.
const STORE_MODE = 'ciMode:'
const STORE_CLAIMS = 'ciInvestigated:'
const CLAIMS_KEPT = 20
// How long a claim waits before reading the claims back: another session's claim on the same commit lands by then.
const CLAIM_SETTLE_MS = 1000
// Logs still being read after this have hung (the session reloaded mid-read, say); a new look may start.
const RUN_HUNG_MS = 5 * 60_000

// What active CI mode takes from the session: the light lane, the repo (once the pack has loaded), whether a person is
// there, this session's id, the CI snapshot and a refresh of it, the state through register.tsx's mirror (read at
// once, written by a change), and how to tell the person something.
export type CiActiveDeps = {
  light: Lane
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
  // A commit's checks failed in the session that pinged: looks into it when the repo is active.
  onFailed: (ci: CiSnapshot) => Promise<void>
  // The person asked: the branch's failing checks, looked into in either mode.
  investigateNow: () => Promise<void>
}

// Active CI mode: a failed check, its logs and the diff handed to the main session as one turn that looks into it
// (which register.tsx keeps read-only).
export function createCiActive($: EngineInterface, deps: CiActiveDeps): CiActive {
  let handoffs = 0

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

  // This session takes the commit unless another already has; two that claim at once both write, and the first
  // claim read back wins.
  const claim = async (repoKey: string, head: string) => {
    const read = async () => {
      const stored = await $.store.get(STORE_CLAIMS + repoKey)
      return Array.isArray(stored) ? (stored as { head: string; session: string }[]) : []
    }
    const before = await read()
    if (before.some(c => c.head === head)) return false
    await $.store.set(STORE_CLAIMS + repoKey, [...before, { head, session: deps.selfId }].slice(-CLAIMS_KEPT))
    await $.clock.sleep(CLAIM_SETTLE_MS)
    return (await read()).find(c => c.head === head)?.session === deps.selfId
  }

  const look = async (ci: CiSnapshot, asked: boolean) => {
    if (!deps.isInteractive || (!asked && !deps.may('claude.ciHandoff'))) return
    if (isRunning(await $.clock.now())) return void (asked && deps.notify(CI_TEXTS.replyBusy))
    const report = await deps.report()
    if (!report?.repoKey) return void (asked && deps.notify(CI_TEXTS.replyNoRepo))
    if (!asked && (await $.store.get(STORE_MODE + report.repoKey)) !== 'active') return
    const failed = failedChecks(ci)
    if (!failed.length) return void (asked && deps.notify(CI_TEXTS.replyNoFailure)) // asked
    if (!asked && !(await claim(report.repoKey, ci.head))) return

    const at = await $.clock.now()
    await deps.save(s => ({ ...s, run: { head: ci.head, state: 'investigating', why: '', marker: '', at } }))
    deps.notify(CI_TEXTS.started) // may: claude.ciHandoff
    // One at a time, so the reads never crowd the light lane.
    const logs: { check: string; tail: string; isCut: boolean }[] = []
    let budget = LOGS_CHARS
    for (const { check, argv } of logCommands(failed)) {
      if (budget <= 0) break
      const ran = await run(argv, report.root)
      if (ran.exitCode !== 0 || !ran.stdout.trim()) continue
      const { tail, isCut } = tailOf(ran.stdout, LOG_LINES, Math.min(LOG_CHARS, budget))
      budget -= tail.length
      logs.push({ check, tail, isCut: isCut || ran.stdout.length >= LOG_CAP_CHARS })
    }
    const diffArgv = ci.pr ? ['gh', 'pr', 'diff', String(ci.pr.number)] : ['git', 'show', '--format=', '--patch', ci.head]
    const diffRan = await run(diffArgv, report.root)
    const diffText = diffRan.exitCode === 0 ? diffRan.stdout : ''
    const diff = { text: diffText.slice(0, DIFF_CHARS), isCut: diffText.length > DIFF_CHARS }

    handoffs += 1
    const { text, marker } = handoffPrompt(ci, logs, diff, handoffs)
    // The marker first, so the turn that brings it is known as soon as it starts; the submit isn't awaited, as it
    // resolves only once that turn has started.
    // Switched off while the logs were read: nothing is handed over.
    if (!asked && !deps.may('claude.ciHandoff'))
      return void (await deps.save(s => ({ ...s, run: s.run && { ...s.run, state: 'failed', why: CI_TEXTS.switchedOff, marker: '' } })))
    await deps.save(s => ({ ...s, run: s.run && { ...s.run, state: 'waiting', marker } }))
    void $.prompt
      .submit({ text })
      .then(result => (result.drop !== undefined ? fail(result.drop, CI_TEXTS.refused(result.drop)) : undefined))
      .catch((err: unknown) => fail(String(err), CI_TEXTS.refused(String(err))))
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
    onFailed: ci => look(ci, false),
    investigateNow: async () => {
      await deps.refresh()
      const ci = await deps.ci()
      if (!ci) return void deps.notify(CI_TEXTS.replyNoFailure) // asked
      await look(ci, true)
    },
  }
}
