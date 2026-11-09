import type { TelemetryError, TelemetryReading, TelemetrySample, TelemetryShot } from '../../types'
import type { ResolvedPack } from '../packs/types'

// A Godot game's telemetry: the contract between the autoload the mod installs into a game
// (hooks/packs/assets/ccinformer_telemetry.gd) and the mod, which reads what it writes. Plain logic only; the asset
// check (tests/check-telemetry-asset.mjs) holds the script's own constants to these.

export const TELEMETRY_DIR = '.local/telemetry'
export const TELEMETRY_FILE = 'telemetry.json'
export const REQUEST_FILE = 'request.json'
export const SHOT_NAME = /^shot-\d{13}\.png$/
export const TELEMETRY_SCHEMA = 1
export const MAX_SAMPLES = 120
export const MAX_ERRORS = 20
export const MAX_SHOTS = 10
export const MAX_SHOT_WIDTH = 1280
// A reading whose last sample is older than this means the game stopped (or sits in the debugger).
export const STALE_MS = 5000
// The autoload drops a request older than this; the mod waits longer, so a slow capture still reaches it.
export const REQUEST_MAX_AGE_MS = 5000
export const SHOT_WAIT_MS = 10000
export const SHOT_POLL_MS = 500
export const CAPTURE_DEADLINE_MS = 3000
export const SHOWN_ERRORS = 5
export const AUTOLOAD_NAME = 'CCInformerTelemetry'
export const SCRIPT_PATH = 'addons/ccinformer/ccinformer_telemetry.gd'
export const AUTOLOAD_LINE = 'CCInformerTelemetry="res://addons/ccinformer/ccinformer_telemetry.gd"'
export const TELEMETRY_ASSET = 'hooks/packs/assets/ccinformer_telemetry.gd'
// What the install writes to create the folder: a valid, empty reading the autoload overwrites.
export const PLACEHOLDER = '{"schema":1,"startedAt":0,"errorSource":"none","errorCount":0,"samples":[],"errors":[],"screenshot":null}\n'

export type TelemetryStatus = 'absent' | 'waiting' | 'live' | 'stale' | 'broken'

// What the install replies and the keys toast, word for word (the tests hold them).
const ADD_LINE = `Add this line under [autoload]: ${AUTOLOAD_LINE}`
export const TELEMETRY_TEXTS = {
  noPack: "CCInformer couldn't read this repo's pack, so nothing was written.",
  noProject: (root: string) => `No project.godot at the root of ${root}: telemetry is for a Godot game.`,
  badProject: `Couldn't read project.godot, so nothing was written. ${ADD_LINE}`,
  notIgnored: "Git doesn't ignore .local/telemetry/ here, so nothing was written. Add .local/ to .gitignore, then run /ccinformer pack install-telemetry again.",
  gitUnknown: "Couldn't ask git whether .local/telemetry/ is ignored, so nothing was written.",
  noAsset: `Couldn't read CCInformer's own ${TELEMETRY_ASSET}, so nothing was written.`,
  upToDate: 'Telemetry is already installed and up to date.',
  question: (root: string) =>
    `Install CCInformer's game telemetry into ${root}? It writes ${SCRIPT_PATH}, adds ${AUTOLOAD_NAME} under [autoload] in project.godot, and creates ${TELEMETRY_DIR}/ (git ignores it). The game writes FPS, frame times, errors and screenshots there only when run from the project, never from an export. Close the Godot editor first, or it may save its own project.godot over this one.`,
  declined: 'Telemetry not installed: nothing was written.',
  writeFailed: (path: string, why: string) => `Couldn't write ${path}: ${why}. Nothing after it was changed.`,
  projectChanged: `project.godot changed while installing (is the editor open?), so it wasn't touched. ${ADD_LINE}`,
  projectFailed: `Wrote the script and ${TELEMETRY_DIR}/, but couldn't update project.godot. ${ADD_LINE}`,
  installed: `Telemetry installed. Start the game from the editor or with godot --path . and Now › Env shows it. Commit ${SCRIPT_PATH.slice(0, SCRIPT_PATH.lastIndexOf('/') + 1)} (the editor adds a .gd.uid next to the script) and project.godot.`,
  notRunning: "The game isn't running from the project, so nothing can take a screenshot.",
  shotNotIgnored: "Git doesn't ignore .local/telemetry/ here any more, so no screenshot was requested.",
  shotUnfilled: (path: string) => `Screenshot saved: ${path} (the prompt couldn't take it)`,
  shotFailed: (error: string) => `The game couldn't take the screenshot: ${error}${error === 'window not drawn' ? '. Is its window minimised?' : ''}`,
  shotTimeout: `No screenshot after ${SHOT_WAIT_MS / 1000} s: the game may be paused, minimised, or running an older telemetry script (run /ccinformer pack install-telemetry again).`,
  requestFailed: (why: string) => `Couldn't ask the game for a screenshot: ${why}`,
  noTelemetry: 'No telemetry yet: start the game from the project.',
  fileUnfilled: (path: string) => `Telemetry is in ${path} (the prompt couldn't take it)`,
} as const

// Telemetry applies to a repo whose pack knows a game process (the godot-csharp built-in, or a user pack on it).
export const hasGame = (pack: ResolvedPack | null): boolean => !!pack?.processes.some(p => p.kind === 'game')

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const ERROR_KINDS: TelemetryError['kind'][] = ['error', 'script', 'shader', 'stderr']

const sampleOf = (v: unknown): TelemetrySample => {
  const s = (v ?? {}) as Record<string, unknown>
  return { t: num(s.t), fps: num(s.fps), slowestFrameMs: num(s.slowestFrameMs), slowestPhysicsMs: num(s.slowestPhysicsMs), drawCalls: num(s.drawCalls), objects: num(s.objects), memMb: num(s.memMb) }
}

const errorOf = (v: unknown): TelemetryError => {
  const e = (v ?? {}) as Record<string, unknown>
  const kind = ERROR_KINDS.find(k => k === e.kind) ?? 'error'
  return { t: num(e.t), kind, msg: text(e.msg, 300) }
}

const shotOf = (v: unknown): TelemetryShot | null => {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const shot: TelemetryShot = { id: text(s.id, 13), file: text(s.file, 40), t: num(s.t) }
  if (typeof s.width === 'number') shot.width = num(s.width)
  if (typeof s.height === 'number') shot.height = num(s.height)
  if (typeof s.error === 'string' && s.error) shot.error = text(s.error, 40)
  return shot
}

const emptyReading = (mtimeMs: number, note: string): TelemetryReading => ({
  mtimeMs, schema: 0, startedAt: 0, errorSource: 'none', errorCount: 0, samples: [], errors: [], screenshot: null, note,
})

// The file's text (null when there is none) read into a reading. A missing file shortly after a good read, or text that
// isn't JSON, keeps the previous reading: on Windows the autoload's rename deletes the old file before it moves the new
// one in. Null means no telemetry file.
export const parseTelemetry = (raw: string | null, mtimeMs: number, previous: TelemetryReading | null, now: number): TelemetryReading | null => {
  if (raw === null) return previous && now - previous.mtimeMs < STALE_MS ? previous : null
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    doc = parsed as Record<string, unknown>
  } catch {
    return previous ?? emptyReading(mtimeMs, "telemetry.json isn't valid JSON yet.")
  }
  if (doc.schema !== TELEMETRY_SCHEMA)
    return emptyReading(mtimeMs, `telemetry.json is schema ${String(doc.schema)}; this CCInformer reads ${TELEMETRY_SCHEMA}. Run /ccinformer pack install-telemetry again.`)
  const samples = Array.isArray(doc.samples) ? doc.samples.slice(-MAX_SAMPLES).map(sampleOf) : []
  const errors = Array.isArray(doc.errors) ? doc.errors.slice(-MAX_ERRORS).map(errorOf) : []
  return {
    mtimeMs,
    schema: TELEMETRY_SCHEMA,
    startedAt: num(doc.startedAt),
    errorSource: doc.errorSource === 'logger' ? 'logger' : 'none',
    errorCount: num(doc.errorCount),
    samples,
    errors,
    screenshot: shotOf(doc.screenshot),
    note: '',
  }
}

// What the section says: no file, a file with no sample yet, a recent sample, an old one, or a file it can't use.
export const telemetryStatus = (r: TelemetryReading | null, now: number): TelemetryStatus => {
  if (!r) return 'absent'
  if (r.note) return 'broken'
  const last = r.samples[r.samples.length - 1]
  if (!last) return 'waiting'
  return now - last.t < STALE_MS ? 'live' : 'stale'
}

// The lowest fps and the longest frame over the samples in the file.
export const telemetrySpread = (r: TelemetryReading): { fpsMin: number; slowestFrameMsMax: number } => ({
  fpsMin: r.samples.length ? Math.min(...r.samples.map(s => s.fps)) : 0,
  slowestFrameMsMax: r.samples.length ? Math.max(...r.samples.map(s => s.slowestFrameMs)) : 0,
})

// project.godot with the autoload line under [autoload]: a line of the same name is replaced, a missing section is
// added where Godot keeps it (sections in name order), and the file's line endings are kept. A text that isn't a
// Godot project (empty, or no config_version= line) is refused and returned as it was.
export const withAutoload = (project: string, line: string): { text: string; isChanged: boolean; refusal: string } => {
  if (!/^config_version=/m.test(project)) return { text: project, isChanged: false, refusal: "project.godot has no config_version= line, so it doesn't look like a Godot project." }
  const eol = project.includes('\r\n') ? '\r\n' : '\n'
  const lines = project.split(/\r?\n/)
  const name = line.slice(0, line.indexOf('=') + 1)
  const headerAt = (from: number) => {
    for (let i = from; i < lines.length; i += 1) if (/^\[[^\]]+\]\s*$/.test(lines[i]!)) return i
    return lines.length
  }
  const section = lines.findIndex(l => l.trim() === '[autoload]')
  if (section >= 0) {
    const end = headerAt(section + 1)
    const existing = lines.findIndex((l, i) => i > section && i < end && l.startsWith(name))
    if (existing >= 0) {
      if (lines[existing] === line) return { text: project, isChanged: false, refusal: '' }
      lines[existing] = line
    } else {
      let last = end - 1
      while (last > section && lines[last]!.trim() === '') last -= 1
      lines.splice(last + 1, 0, ...(last === section ? ['', line] : [line]))
    }
    return { text: lines.join(eol), isChanged: true, refusal: '' }
  }
  // The first section that sorts after "autoload", or the end of the file.
  let at = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\[([^\]]+)\]\s*$/.exec(lines[i]!)
    if (m && m[1]! > 'autoload') {
      at = i
      break
    }
  }
  if (at === lines.length) {
    while (at > 0 && lines[at - 1]!.trim() === '') at -= 1
    const tail = lines.slice(at)
    return { text: [...lines.slice(0, at), '', '[autoload]', '', line, ...(tail.length ? tail : [''])].join(eol), isChanged: true, refusal: '' }
  }
  lines.splice(at, 0, '[autoload]', '', line, '')
  return { text: lines.join(eol), isChanged: true, refusal: '' }
}

// Two script texts, the same once line endings are set aside (a Windows checkout may hold CRLF).
export const sameScript = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')

// What the pane writes to ask the game for a screenshot.
export const requestText = (id: string): string => JSON.stringify({ id, kind: 'screenshot' }) + '\n'

// Where a screenshot request stands, by the reading's answer for that id.
export const shotOutcome = (r: TelemetryReading | null, id: string): { state: 'pending' } | { state: 'ok'; file: string } | { state: 'error'; error: string } => {
  const s = r?.screenshot
  if (!s || s.id !== id) return { state: 'pending' }
  if (s.error || !SHOT_NAME.test(s.file)) return { state: 'error', error: s.error || 'save failed' }
  return { state: 'ok', file: s.file }
}

// A folder written with forward slashes, no trailing slash, and a lower-case drive letter.
const folder = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([A-Z]):/, (_, d: string) => d.toLowerCase() + ':')
const isWindowsPath = (p: string): boolean => /^[a-z]:/.test(p)
const sameFolder = (a: string, b: string): boolean => (isWindowsPath(a) ? a.toLowerCase() === b.toLowerCase() : a === b)
const isUnder = (child: string, parent: string): boolean =>
  (isWindowsPath(parent) ? child.toLowerCase() : child).startsWith((isWindowsPath(parent) ? parent.toLowerCase() : parent) + '/')

// An @ mention of a telemetry file for the prompt: relative to the session's folder when the game's root is it, holds
// it or sits inside it, else the absolute path (cwd and root spelled differently, as an 8.3 name or a junction); quoted
// when it holds a space.
export const mention = (root: string, cwd: string, file: string): string => {
  const r = folder(root)
  const c = folder(cwd)
  const inside = `${TELEMETRY_DIR}/${file}`
  let path = `${r}/${inside}`
  if (sameFolder(r, c)) path = inside
  else if (isUnder(r, c)) path = `${r.slice(c.length + 1)}/${inside}`
  else if (isUnder(c, r)) path = `${'../'.repeat(c.slice(r.length + 1).split('/').length)}${inside}`
  return path.includes(' ') ? `@"${path}"` : `@${path}`
}
