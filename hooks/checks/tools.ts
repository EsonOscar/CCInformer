import type { Finding } from '../../types'
import type { Ran } from '../collect'
import type { Platform } from '../env/procs'
import type { CheckSpec } from '../packs/types'
import { FILES_SLOT, OUTPUT_SLOT } from '../packs/types'
import { ESLINT_BIN, eslintFindings, toolFindings } from './findings'
import { matcherResults } from './matcher'
import { NOT_SARIF, sarifResults } from './sarif'
import type { Suppressions } from './suppressions'

// The checks that run a command once a turn ends (run.ts): the command each builds, what its output comes to, and
// the texts a run's error carries. Pure, so the exit and output rules are held by a plain test.

export const TOOL_ANALYZERS = ['eslint-json', 'sarif', 'problem-matcher'] as const

export const isToolCheck = (check: CheckSpec): boolean => check.cost === 'turn' && (TOOL_ANALYZERS as readonly string[]).includes(check.analyzer)

export const binOf = (check: CheckSpec): string[] => check.bin ?? (check.analyzer === 'eslint-json' ? ESLINT_BIN : [])

// Whether the run takes the files written (appended for ESLint, in place of `{files}` otherwise), or is one run over
// the whole project.
export const takesFiles = (check: CheckSpec): boolean => check.analyzer === 'eslint-json' || binOf(check).includes(FILES_SLOT)

export const hasOutputFile = (check: CheckSpec): boolean => check.analyzer === 'sarif' && binOf(check).some(a => a.includes(OUTPUT_SLOT))

export const toolArgv = (check: CheckSpec, files: string[], outputPath: string, emptySuppressions: string): string[] => {
  const bin = binOf(check)
  if (check.analyzer === 'eslint-json') return [...bin, '--format', 'json', '--no-warn-ignored', '--suppressions-location', emptySuppressions, ...files]
  return bin.flatMap(a => (a === FILES_SLOT ? files : [a.split(OUTPUT_SLOT).join(outputPath)]))
}

// Where a check's program would be, looked for before its run (and before the trust question), so a tool this machine
// doesn't have skips the check instead of failing every turn. `repo`: a `node <script>` script (its second item has
// to look like a repo path, so `node --flag` or `node {files}` looks for node itself) or a relative command,
// under the repo; `abs`: an absolute command; `path`: a bare name, in each PATH folder (with each PATHEXT extension on
// Windows). Folders written relative or empty are left out, as the lookup can't tell which folder they mean. Null:
// nothing to look for, so the check runs as before.
export type ProgramLookup = { kind: 'path' | 'repo' | 'abs'; program: string; paths: string[] }

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

export const programCandidates = (
  bin: string[],
  root: string,
  env: { path: string; pathext: string },
  platform: Platform,
): ProgramLookup | null => {
  const [first, second] = bin
  if (!first) return null
  if (first === 'node' && second && !/^[-{]/.test(second)) return { kind: 'repo', program: second, paths: [`${root}/${second}`] }
  const isWindows = platform === 'windows'
  const exts = isWindows ? (env.pathext || DEFAULT_PATHEXT).split(';').map(e => e.trim()).filter(Boolean) : []
  // On Windows a name without an extension is found with any of PATHEXT's.
  const forms = (path: string) => (isWindows && !/\.[^\\/.]+$/.test(path) ? [path, ...exts.map(e => path + e.toLowerCase())] : [path])
  const isAbsolute = (p: string) => (isWindows ? /^([a-z]:)?[\\/]/i : /^\//).test(p)
  if (/[\\/]/.test(first)) {
    const isAbs = isAbsolute(first)
    return { kind: isAbs ? 'abs' : 'repo', program: first, paths: forms(isAbs ? first : `${root}/${first.replace(/^\.[\\/]/, '')}`) }
  }
  const dirs = env.path
    .split(isWindows ? ';' : ':')
    .map(d => d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, ''))
    .filter(d => d && isAbsolute(d))
  return { kind: 'path', program: first, paths: dirs.flatMap(d => forms(`${d}/${first}`)) }
}

// What the run line says after "skipped, ".
export const skipReason = (lookup: ProgramLookup): string =>
  lookup.kind === 'repo' ? `${lookup.program} isn't in this repo` : `${lookup.program} isn't installed`

// FNV-1a over the text, as 8 hex characters.
export const hash8 = (text: string): string => {
  let h = 0x811c9dc5
  for (const ch of text) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// The file a sarif tool writes its log to, in the mod's output folder: one per check, repo and session, so two
// sessions in one clone never clear or read each other's; the id sanitised, so it can't leave the folder.
export const outputFile = (dir: string, check: CheckSpec, root: string, sessionId: string): string =>
  `${dir}/${check.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${hash8(root + '\0' + sessionId)}.sarif`

export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
export const TRUNCATED = 'its output passed 4 MiB and was cut; give it fewer files a run'
export const NO_SARIF_FILE = 'it wrote no SARIF 2.1.0 file'
export const SARIF_FILE_TOO_BIG = 'its SARIF file passed 4 MiB'
export const OUTPUT_NOT_WRITTEN = 'its output file could not be written'

// What the mod read back from the tool's output file: the text, or why it couldn't (too big, unreadable).
export type OutputRead = { text: string | null; error: string }

const firstLine = (text: string): string => text.split('\n').map(l => l.trim()).find(l => l) ?? ''
const errorLine = (text: string): string => text.split('\n').map(l => l.trim()).find(l => /error/i.test(l)) ?? ''
const failedWith = (ran: Ran): string => firstLine(ran.stderr) || errorLine(ran.stdout) || `it exited with ${ran.exitCode}`

// A run's result as findings, or the error that stops it, with nothing saved: a run the lane refused (a timeout, a
// program not found), output the host cut at 4 MiB, ESLint's own exit rule, SARIF that isn't 2.1.0 (a non-zero exit
// then reports the cause first), a non-zero exit with nothing of error severity among what was read (a failure the
// output doesn't show), and the matcher's line cap.
export const readRun = (
  check: CheckSpec,
  ran: Ran,
  output: OutputRead | null,
  root: string,
  files: string[],
  suppressions: Suppressions,
  owned: (file: string) => string[],
): { findings: Finding[]; elsewhere: number; error: string } => {
  const none = (error: string) => ({ findings: [], elsewhere: 0, error })
  if (ran.exitCode === -1) return none(firstLine(ran.stderr) || 'it could not run')
  if (check.analyzer === 'eslint-json') {
    if (ran.isStdoutTruncated) return none(TRUNCATED)
    if (ran.exitCode !== 0 && ran.exitCode !== 1) return none(firstLine(ran.stderr) || `it exited with ${ran.exitCode}`)
    const parsed = eslintFindings(check, ran.stdout, root, suppressions, owned)
    return parsed.error ? none(parsed.error) : { findings: parsed.findings, elsewhere: 0, error: '' }
  }
  if (check.analyzer === 'sarif') {
    let text: string
    if (output) {
      if (output.error) return none(output.error)
      if (output.text === null || !output.text.trim()) return none(ran.exitCode !== 0 ? failedWith(ran) : NO_SARIF_FILE)
      text = output.text
    } else {
      if (ran.isStdoutTruncated) return none(TRUNCATED)
      text = ran.stdout
    }
    const parsed = sarifResults(check, text, root)
    const notSarif = output ? NO_SARIF_FILE : NOT_SARIF
    if (parsed.error) return none(ran.exitCode !== 0 ? firstLine(ran.stderr) || errorLine(ran.stdout) || notSarif : notSarif)
    if (ran.exitCode !== 0 && !parsed.raws.some(r => r.severity === 'error')) return none(failedWith(ran))
    return { ...toolFindings(check, parsed.raws, files, root, suppressions, owned, 'warn', parsed.reported), error: '' }
  }
  if (ran.isStdoutTruncated || ran.isStderrTruncated) return none(TRUNCATED)
  const parsed = matcherResults(check, ran.stdout + '\n' + ran.stderr, root)
  if (parsed.error) return none(parsed.error)
  if (ran.exitCode !== 0 && !parsed.raws.some(r => r.severity === 'error')) return none(failedWith(ran))
  return { ...toolFindings(check, parsed.raws, files, root, suppressions, owned, 'warn'), error: '' }
}
