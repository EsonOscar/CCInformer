import type { EngineInterface } from 'claude-code'

import type { CheckRun, Finding, PackReport } from '../../types'
import type { Lane } from '../core/lanes'
import { askTrust } from '../packs/load'
import type { CheckSpec, ResolvedPack } from '../packs/types'
import { readText } from '../read-records'
import { ESLINT_BIN, covers, eslintFindings, isTold, noteFor, ownedRules, regexFindings, sizeFindings, withoutInline } from './findings'
import { repoPath } from './glob'
import { parseSuppressions } from './suppressions'
import type { Suppressions } from './suppressions'

// The most files one ESLint run takes (its JSON carries each file's source, and a run's output is cut at 4 MiB); the
// rest wait for the next run.
const MAX_CHECKED_FILES = 40

// What the checks take from the session: its pack and the report it came with (read again on `reload`), the heavy
// lane, where the empty suppressions file goes, and the state they write and read (the atoms live in the hooks module).
export type CheckDeps = {
  cwd: string
  emptySuppressions: string
  heavy: Lane
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  reload: () => Promise<PackReport>
  saveFindings: (check: string, files: string[], found: Finding[]) => Promise<unknown>
  saveRun: (run: CheckRun) => Promise<unknown>
  dismissed: () => Promise<string[]>
}

export type Checks = {
  // A file was written: note it for the turn's run, and run the inline checks on it. Says what the model should read
  // about it, or ''.
  checkFile: (path: string) => Promise<string>
  // A main turn ended: run the turn checks over what was written since the last run.
  runChecks: () => Promise<void>
  // The turn checks' findings the model hasn't read, for the files unchanged since; each is told once.
  turnNote: () => Promise<string>
}

// The pack's checks. Inline ones read each file Claude writes, and the model reads what they find with the tool's
// result. Turn ones run the repo's own tools (ESLint) once a main turn ends, over the files every agent wrote in it,
// one run at a time in the heavy lane; the model reads their findings with the next prompt the person types, for the
// files unchanged since the run.
export function createChecks($: EngineInterface, deps: CheckDeps): Checks {
  const touched = new Set<string>()
  let isChecking = false
  let isCheckQueued = false
  let isTrustAsked = false
  let toTell: { findings: Finding[]; stamps: Record<string, string> } | null = null

  // A file's modified time and size, '' when it isn't there: a file whose stamp changed since a run was edited again.
  const stampOf = async (path: string) => {
    const stat = await $.fs.stat(path).catch(() => null)
    return stat && stat.kind === 'file' ? `${stat.mtimeMs}:${stat.size}` : ''
  }
  const suppressionsOf = async (check: CheckSpec, root: string): Promise<Suppressions> =>
    check.suppressions ? parseSuppressions(await readText($, `${root}/${check.suppressions}`)) : {}
  // The inline checks a file is under, and what they find in its text.
  const inlineChecks = (pack: ResolvedPack, file: string) =>
    pack.checks.filter(c => c.cost === 'edit' && (c.analyzer === 'size-lines' || c.analyzer === 'regex-lines') && covers(c, file))
  const inlineFindings = async (check: CheckSpec, root: string, file: string, text: string) =>
    check.analyzer === 'size-lines' ? sizeFindings(check, file, text, await suppressionsOf(check, root)) : regexFindings(check, file, text, await suppressionsOf(check, root))
  // Whether the repo's own tools may run; the first check that needs them asks once a session.
  const mayRunRepoTools = async () => {
    const report = deps.report()
    if (report?.trust.isTrusted) return true
    if (isTrustAsked || !report) return false
    isTrustAsked = true
    if (!(await askTrust($, report))) return false
    return !!(await deps.reload()).trust.isTrusted
  }
  // The turn's ESLint run: the files written since the last run that a check covers and that still exist.
  const checkTurn = async () => {
    const written = [...touched]
    touched.clear()
    const pack = written.length ? await deps.pack() : null
    const report = deps.report()
    if (!pack || !report) return
    for (const check of pack.checks.filter(c => c.cost === 'turn' && c.analyzer === 'eslint-json')) {
      const covered: string[] = []
      for (const f of written) if (covers(check, f) && (await stampOf(`${report.root}/${f}`))) covered.push(f)
      if (!covered.length) continue
      // A repo without ESLint installed has nothing to run: skipped quietly, without asking for trust.
      const bin = check.bin ?? ESLINT_BIN
      if (bin[0] === 'node' && bin[1] && !(await $.fs.exists(`${report.root}/${bin[1]}`))) continue
      const files = covered.slice(0, MAX_CHECKED_FILES)
      const run: CheckRun = { check: check.id, label: check.label, at: await $.clock.now(), ms: 0, files: files.length, isRunning: false, waitsForTrust: false, error: '' }
      if (!(await mayRunRepoTools())) {
        // They run after the next main turn, once trust is given.
        for (const f of covered) touched.add(f)
        await deps.saveRun({ ...run, waitsForTrust: true })
        continue
      }
      for (const f of covered.slice(MAX_CHECKED_FILES)) touched.add(f)
      if (covered.length > MAX_CHECKED_FILES) isCheckQueued = true
      const stamps: Record<string, string> = {}
      for (const f of files) stamps[f] = await stampOf(`${report.root}/${f}`)
      await deps.saveRun({ ...run, isRunning: true })
      if (!(await $.fs.exists(deps.emptySuppressions))) await $.fs.write(deps.emptySuppressions, '{}\n')
      // Raw output (an empty suppressions file), so the repo's suppressions are applied here, exactly as ESLint would.
      const argv = [...(check.bin ?? ESLINT_BIN), '--format', 'json', '--no-warn-ignored', '--suppressions-location', deps.emptySuppressions, ...files]
      const ran = await deps.heavy(argv, check.timeoutMs, report.root).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      // ESLint exits 1 when it found problems and 2 when it couldn't run.
      const owned = (file: string) => pack.checks.filter(c => c.cost === 'edit' && covers(c, file)).flatMap(ownedRules)
      const parsed =
        ran.exitCode === 0 || ran.exitCode === 1
          ? eslintFindings(check, ran.stdout, report.root, await suppressionsOf(check, report.root), owned)
          : { findings: [], files: [], error: ran.stderr.trim().split('\n').find(l => l.trim()) || `it exited with ${ran.exitCode}` }
      if (!parsed.error) {
        // What a regex check already reports on a line, as the ESLint rule it stands for, shows and is told once.
        const inline: Finding[] = []
        for (const f of files) {
          const regexChecks = inlineChecks(pack, f).filter(c => c.analyzer === 'regex-lines')
          const text = regexChecks.length ? await readText($, `${report.root}/${f}`) : ''
          for (const c of regexChecks) inline.push(...(await inlineFindings(c, report.root, f, text)))
        }
        const findings = withoutInline(parsed.findings, inline)
        await deps.saveFindings(check.id, files, findings)
        const kept = toTell?.findings.filter(f => f.check !== check.id || !files.includes(f.file)) ?? []
        toTell = { findings: [...kept, ...findings.filter(isTold)], stamps: { ...toTell?.stamps, ...stamps } }
      }
      const ms = (await $.clock.now()) - run.at
      await deps.saveRun({ ...run, ms, error: parsed.error })
    }
  }

  return {
    checkFile: async path => {
      const pack = await deps.pack()
      const root = deps.report()?.root ?? ''
      const file = root ? repoPath(root, /^([a-z]:)?[\\/]/i.test(path) ? path : `${deps.cwd}/${path}`) : ''
      if (!pack || !file) return ''
      touched.add(file)
      const checks = inlineChecks(pack, file)
      if (!checks.length) return ''
      const text = await readText($, `${root}/${file}`)
      const found: Finding[] = []
      for (const check of checks) {
        const findings = await inlineFindings(check, root, file, text)
        await deps.saveFindings(check.id, [file], findings)
        found.push(...findings)
      }
      return noteFor(found, 'edit')
    },
    // One run at a time: a turn that ends while one runs starts another after it, with what was written meanwhile.
    runChecks: async () => {
      if (isChecking) {
        isCheckQueued = true
        return
      }
      isChecking = true
      try {
        do {
          isCheckQueued = false
          await checkTurn()
        } while (isCheckQueued)
      } finally {
        isChecking = false
      }
    },
    turnNote: async () => {
      const pending = toTell
      toTell = null
      const root = deps.report()?.root
      if (!pending || !root) return ''
      const dismissed = await deps.dismissed()
      const fresh: string[] = []
      for (const [file, stamp] of Object.entries(pending.stamps)) if (stamp && (await stampOf(`${root}/${file}`)) === stamp) fresh.push(file)
      return noteFor(pending.findings.filter(f => fresh.includes(f.file) && !dismissed.includes(f.id)), 'turn')
    },
  }
}
