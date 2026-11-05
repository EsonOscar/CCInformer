import type { EngineInterface } from 'claude-code'

import type { CheckRun, Finding, PackReport } from '../../types'
import type { Lane } from '../core/lanes'
import type { May } from '../core/permissions'
import { askTrust, wasTrustAsked } from '../packs/load'
import type { CheckSpec, ResolvedPack } from '../packs/types'
import { filesOf } from '../read-files'
import { readText } from '../read-records'
import { covers, isTold, noteFor, ownedRules, regexFindings, sizeFindings, withoutInline } from './findings'
import { repoPath } from './glob'
import { keysetFindings, languagesOf, tableOf } from './i18n'
import { createSceneChecks } from './scenes'
import type { TableFile } from './i18n'
import { parseSuppressions } from './suppressions'
import type { Suppressions } from './suppressions'
import { MAX_OUTPUT_BYTES, OUTPUT_NOT_WRITTEN, SARIF_FILE_TOO_BIG, binOf, hasOutputFile, isToolCheck, outputFile, readRun, takesFiles, toolArgv } from './tools'
import type { OutputRead } from './tools'

// The most files one run takes when the command takes files (ESLint's JSON carries each file's source, and a run's
// output is cut at 4 MiB); the rest wait for the next run.
const MAX_CHECKED_FILES = 40
// How deep a `**` glob looks for translation tables.
const MAX_TABLE_DEPTH = 6

// What the checks take from the session: its pack and the report it came with (read again on `reload`), the heavy
// lane, where the empty suppressions file and a tool's output files go, this session's id, and the state they write
// and read (the atoms live in the hooks module).
export type CheckDeps = {
  cwd: string
  // Why a check's program isn't on this machine ("dotnet isn't installed"), or '' when it is: looked up before the
  // trust question, by reading files only.
  hasProgram: (bin: string[], root: string) => Promise<string>
  emptySuppressions: string
  outputDir: string
  sessionId: string
  heavy: Lane
  // Quick git reads (the scene checks'), beside the git and CI polls.
  light: Lane
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  reload: () => Promise<PackReport>
  saveFindings: (check: string, files: string[], found: Finding[]) => Promise<unknown>
  saveRun: (run: CheckRun) => Promise<unknown>
  dismissed: () => Promise<string[]>
  // The files a check's findings sit in now (read once per check, then kept here).
  findingFiles: (check: string) => Promise<string[]>
  may: May
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
// result. Turn ones run the repo's own tools (ESLint, a pack's sarif or problem-matcher command) once a main turn
// ends, over the files every agent wrote in it, one run at a time in the heavy lane; the model reads their findings
// with the next prompt the person types, for the files unchanged since the run.
export function createChecks($: EngineInterface, deps: CheckDeps): Checks {
  const touched = new Set<string>()
  // Per check, the files waiting for its next run: the overflow past one run's cap, and what a trust wait held back.
  const pending = new Map<string, Set<string>>()
  const held = new Map<string, Set<string>>()
  let isChecking = false
  let isCheckQueued = false
  let isTrustAsked = false
  let toTell: { findings: Finding[]; stamps: Record<string, string> } | null = null
  // The findings the model has been told this session: the scene checks tell each once.
  const told = new Set<string>()

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
  // Whether the repo's own tools may run. The first check that needs them asks once per repo, ever: after any answer,
  // only the person allows them (a in Debug › Pack).
  const mayRunRepoTools = async () => {
    const report = deps.report()
    if (report?.trust.isTrusted) return true
    if (!deps.may('ask.repoTrust')) return false
    if (isTrustAsked || !report) return false
    isTrustAsked = true
    if (await wasTrustAsked($, report)) return false
    if (!(await askTrust($, report, deps.may('claude.turnNotes')))) return false // may: ask.repoTrust
    return !!(await deps.reload()).trust.isTrusted
  }
  // The turn's translation-table checks, once its writes are all in: compared inside the mod, so they need no trust.
  // Every table a check covers is read, but only when the turn wrote to one of them.
  const checkTables = async (pack: ResolvedPack, root: string, written: string[]) => {
    for (const check of pack.checks.filter(c => c.cost === 'turn' && c.analyzer === 'i18n-keysets')) {
      const touchedTables = [...new Set(written.filter(f => covers(check, f)).map(tableOf))]
      if (!touchedTables.length) continue
      const all = new Set(touchedTables)
      for (const glob of check.on) for (const f of await filesOf($, root, glob, MAX_TABLE_DEPTH)) if (covers(check, f)) all.add(tableOf(f))
      const tables: Record<string, TableFile[]> = {}
      const stamps: Record<string, string> = {}
      for (const table of all) {
        const files: TableFile[] = []
        for (const lang of languagesOf(check)) {
          const path = table ? `${table}/${lang}.json` : `${lang}.json`
          stamps[path] = await stampOf(`${root}/${path}`)
          files.push({ lang, path, text: stamps[path] ? await readText($, `${root}/${path}`) : null })
        }
        tables[table] = files
      }
      const files = touchedTables.flatMap(t => tables[t]!.map(f => f.path))
      const findings = keysetFindings(check, tables, touchedTables)
      await deps.saveFindings(check.id, files, findings)
      const kept = toTell?.findings.filter(f => f.check !== check.id || !files.includes(f.file)) ?? []
      const told = Object.fromEntries(files.map(f => [f, stamps[f] ?? '']))
      toTell = { findings: [...kept, ...findings.filter(isTold)], stamps: { ...toTell?.stamps, ...told } }
    }
  }
  // The files each check's findings sit in, as this engine saved them: a whole-project run (no files passed)
  // clears the ones the tool no longer reports. Seeded once per check from the atom, as a get reads one moment per
  // dispatch and this loop can run twice in one.
  const heldFor = async (check: string) => {
    let set = held.get(check)
    if (!set) {
      set = new Set(await deps.findingFiles(check))
      held.set(check, set)
    }
    return set
  }
  // The Godot scene checks (scenes.ts), which read files and git themselves and need no trust.
  const runScenes = createSceneChecks({
    light: deps.light,
    stampOf,
    read: path => readText($, path),
    exists: path => $.fs.exists(path).catch(() => false),
    now: () => $.clock.now(),
    heldFor,
    saveFindings: deps.saveFindings,
    saveRun: deps.saveRun,
    tell: (check, files, found, stamps) => {
      const kept = toTell?.findings.filter(f => f.check !== check || !files.includes(f.file)) ?? []
      toTell = { findings: [...kept, ...found.filter(f => isTold(f) && !told.has(f.id))], stamps: { ...toTell?.stamps, ...stamps } }
    },
    pending,
    queue: () => {
      isCheckQueued = true
    },
  })
  // The tool's output file, read back after its run; over 4 MiB the host refuses the read, so its size is checked first.
  const readOutput = async (path: string): Promise<OutputRead> => {
    const stat = await $.fs.stat(path).catch(() => null)
    if (stat && stat.kind === 'file' && stat.size > MAX_OUTPUT_BYTES) return { text: null, error: SARIF_FILE_TOO_BIG }
    const text = await $.fs.read(path).catch(() => null)
    return { text: typeof text === 'string' ? text : null, error: '' }
  }
  // The turn's tool runs (ESLint, a pack's sarif or problem-matcher command): per check, the files written since the
  // last run that it covers and that still exist, plus the ones it has waiting, through the heavy lane once trust is
  // given.
  const checkTurn = async () => {
    const written = [...touched]
    touched.clear()
    const pack = written.length || pending.size ? await deps.pack() : null
    const report = deps.report()
    if (!pack || !report) return
    await checkTables(pack, report.root, written)
    // Before the tool checks, so they never wait behind the trust question; a failure here leaves those to run.
    await runScenes(pack, report.root, written).catch(() => undefined)
    for (const check of pack.checks.filter(isToolCheck)) {
      const queued = pending.get(check.id) ?? new Set<string>()
      pending.delete(check.id)
      const covered: string[] = []
      for (const f of new Set([...queued, ...written.filter(f => covers(check, f))])) if (await stampOf(`${report.root}/${f}`)) covered.push(f)
      if (!covered.length) continue
      const isWhole = !takesFiles(check)
      const files = isWhole ? covered : covered.slice(0, MAX_CHECKED_FILES)
      const run: CheckRun = { check: check.id, label: check.label, at: await $.clock.now(), ms: 0, files: files.length, isRunning: false, waitsForTrust: false, error: '', elsewhere: 0 }
      // A program this machine doesn't have (dotnet not installed, ESLint not in the repo) skips the check: nothing
      // runs, trust isn't asked, and its run line says why. Its files aren't kept waiting.
      const skipped = await deps.hasProgram(binOf(check), report.root)
      if (skipped) {
        await deps.saveRun({ ...run, skipped })
        continue
      }
      if (!(await mayRunRepoTools())) {
        // They run after the next main turn, once trust is given.
        pending.set(check.id, new Set(covered))
        await deps.saveRun({ ...run, waitsForTrust: true })
        continue
      }
      if (!isWhole && covered.length > MAX_CHECKED_FILES) {
        pending.set(check.id, new Set(covered.slice(MAX_CHECKED_FILES)))
        isCheckQueued = true
      }
      const stamps: Record<string, string> = {}
      for (const f of files) stamps[f] = await stampOf(`${report.root}/${f}`)
      await deps.saveRun({ ...run, isRunning: true })
      // Raw output (an empty suppressions file), so the repo's suppressions are applied here, exactly as ESLint would.
      if (check.analyzer === 'eslint-json' && !(await $.fs.exists(deps.emptySuppressions))) await $.fs.write(deps.emptySuppressions, '{}\n') // may: bg.turnChecks
      // A sarif tool that writes its log to a file gets the mod's own, emptied first, so a stale or skipped log never
      // reads as this run's; emptied again once read, so the file keeps nothing of the repo.
      const output = hasOutputFile(check) ? outputFile(deps.outputDir, check, report.root, deps.sessionId) : ''
      if (output && !(await $.fs.write(output, '').then(() => true, () => false))) { // may: bg.turnChecks
        await deps.saveRun({ ...run, error: OUTPUT_NOT_WRITTEN })
        continue
      }
      const argv = toolArgv(check, isWhole ? [] : files, output, deps.emptySuppressions)
      const ran = await deps.heavy(argv, check.timeoutMs, report.root).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      const read = output ? await readOutput(output) : null
      if (output) await $.fs.write(output, '').catch(() => undefined) // may: bg.turnChecks
      const owned = (file: string) => pack.checks.filter(c => c.cost === 'edit' && covers(c, file)).flatMap(ownedRules)
      const parsed = readRun(check, ran, read, report.root, files, await suppressionsOf(check, report.root), owned)
      if (!parsed.error) {
        // What a regex check already reports on a line, as the ESLint rule it stands for, shows and is told once.
        const inline: Finding[] = []
        for (const f of files) {
          const regexChecks = inlineChecks(pack, f).filter(c => c.analyzer === 'regex-lines')
          const text = regexChecks.length ? await readText($, `${report.root}/${f}`) : ''
          for (const c of regexChecks) inline.push(...(await inlineFindings(c, report.root, f, text)))
        }
        const findings = withoutInline(parsed.findings, inline)
        const holding = await heldFor(check.id)
        const saved = isWhole ? [...new Set([...files, ...holding])] : files
        await deps.saveFindings(check.id, saved, findings)
        for (const f of saved) holding.delete(f)
        for (const f of findings) holding.add(f.file)
        const kept = toTell?.findings.filter(f => f.check !== check.id || !files.includes(f.file)) ?? []
        toTell = { findings: [...kept, ...findings.filter(isTold)], stamps: { ...toTell?.stamps, ...stamps } }
      }
      const ms = (await $.clock.now()) - run.at
      await deps.saveRun({ ...run, ms, error: parsed.error, elsewhere: parsed.elsewhere })
    }
  }

  return {
    checkFile: async path => {
      const pack = await deps.pack()
      const root = deps.report()?.root ?? ''
      const file = root ? repoPath(root, /^([a-z]:)?[\\/]/i.test(path) ? path : `${deps.cwd}/${path}`) : ''
      if (!pack || !file) return ''
      // Noted for the turn's run only while turn checks are on, so turning them on later doesn't check every file since.
      if (deps.may('bg.turnChecks')) touched.add(file)
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
      const telling = pending.findings.filter(f => fresh.includes(f.file) && !dismissed.includes(f.id))
      for (const f of telling) told.add(f.id)
      return noteFor(telling, 'turn')
    },
  }
}
