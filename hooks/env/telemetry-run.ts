import type { EngineInterface } from 'claude-code'

import type { PackReport, TelemetryReading, TelemetryState } from '../../types'
import { isIgnored } from '../core/ignored'
import type { Lane, Solo } from '../core/lanes'
import type { ResolvedPack } from '../packs/types'
import {
  AUTOLOAD_LINE, PLACEHOLDER, REQUEST_FILE, SCRIPT_PATH, SHOT_POLL_MS, SHOT_WAIT_MS, TELEMETRY_ASSET, TELEMETRY_DIR,
  TELEMETRY_FILE, TELEMETRY_TEXTS as T, hasGame, mention, parseTelemetry, requestText, sameScript, shotOutcome,
  telemetryStatus, withAutoload,
} from './telemetry'

export type TelemetryDeps = {
  light: Lane
  solo: Solo
  // The resolved pack, read first if it hasn't been yet (its processes say whether a game runs here).
  pack: () => Promise<ResolvedPack | null>
  report: () => PackReport | null
  // The session's folder, for @ mentions relative to it.
  cwd: string
  save: (state: TelemetryState | null) => Promise<unknown>
  // A toast for a key the person pressed (the caller tags it as asked).
  toast: (text: string) => void
}

export type Telemetry = {
  // Reads telemetry.json again if it changed, while Now › Env shows.
  refresh: () => Promise<void>
  // /ccinformer pack install-telemetry: asks, writes, and says how it went.
  install: () => Promise<string>
  // `c`: asks the running game for a screenshot and offers it to the prompt.
  screenshot: () => Promise<void>
  // `t`: offers telemetry.json to the prompt.
  offerFile: () => Promise<void>
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Telemetry for the repo the session is in: whether it applies (the pack knows a game process and project.godot is at
// the root, cached per pack read), the reading, a screenshot asked for and not yet answered.
export function createTelemetry($: EngineInterface, deps: TelemetryDeps): Telemetry {
  let applies: { root: string; at: number; is: boolean } | null = null
  let reading: TelemetryReading | null = null
  let pendingShot = ''
  let isShooting = false
  let saved: { reading: TelemetryReading | null; pendingShot: string; is: boolean } | null = null

  const save = async () => {
    const is = !!applies?.is
    if (saved && saved.reading === reading && saved.pendingShot === pendingShot && saved.is === is) return
    saved = { reading, pendingShot, is }
    await deps.save(is ? { reading, pendingShot } : null)
  }
  // The game's root, or '' when telemetry doesn't apply here.
  const gameRoot = async (): Promise<string> => {
    const pack = await deps.pack()
    const report = deps.report()
    if (!pack || !report) return ''
    if (applies?.root !== report.root || applies.at !== report.at) {
      const project = await $.fs.stat(`${report.root}/project.godot`).catch(() => null)
      applies = { root: report.root, at: report.at, is: hasGame(pack) && project?.kind === 'file' }
    }
    return applies.is ? applies.root : ''
  }
  // telemetry.json, read only when its mtime changed (a missing file counts as none).
  const readFile = async (root: string) => {
    const path = `${root}/${TELEMETRY_DIR}/${TELEMETRY_FILE}`
    const stat = await $.fs.stat(path).catch(() => null)
    const now = await $.clock.now()
    if (stat?.kind !== 'file') {
      reading = parseTelemetry(null, 0, reading, now)
      return
    }
    if (reading && !reading.note && reading.mtimeMs === stat.mtimeMs) return
    const text = await $.fs.read(path).catch(() => null)
    reading = parseTelemetry(typeof text === 'string' ? text : null, stat.mtimeMs, reading, now)
  }
  const refresh = () =>
    deps.solo('telemetry', async () => {
      const root = await gameRoot()
      if (root) await readFile(root)
      await save()
    })
  const wait = (ms: number) => new Promise<void>(resolve => $.clock.after(ms, () => resolve()))
  // A file offered to the prompt as an @ mention, kept with what the person already typed.
  const offer = async (root: string, file: string, unfilled: (path: string) => string) => {
    const filled = await $.prompt.fill({ text: mention(root, deps.cwd, file) + ' ', mode: 'insert' }).catch(() => null) // asked
    if (!filled?.isFilled) deps.toast(unfilled(`${root}/${TELEMETRY_DIR}/${file}`))
  }
  // Writes a file and reads it back, so a write that didn't land counts as failed.
  const writeChecked = async (path: string, text: string) => {
    await $.fs.write(path, text) // asked
    const back = await $.fs.read(path)
    if (typeof back !== 'string' || !sameScript(back, text)) throw new Error('it read back different')
  }

  return {
    refresh,

    install: async () => {
      await deps.pack()
      const report = deps.report()
      if (!report) return T.noPack
      const root = report.root
      const projectPath = `${root}/project.godot`
      if ((await $.fs.stat(projectPath).catch(() => null))?.kind !== 'file') return T.noProject(root)
      const project = await $.fs.read(projectPath).catch(() => null)
      const planned = typeof project === 'string' ? withAutoload(project, AUTOLOAD_LINE) : null
      if (typeof project !== 'string' || !planned || planned.refusal) return T.badProject
      const ignored = await isIgnored(deps.light, root, TELEMETRY_DIR)
      if (ignored === false) return T.notIgnored
      if (ignored === null) return T.gitUnknown
      const asset = await $.fs.read(`${$.plugin.root}/${TELEMETRY_ASSET}`).catch(() => null)
      if (typeof asset !== 'string') return T.noAsset
      const scriptPath = `${root}/${SCRIPT_PATH}`
      const filePath = `${root}/${TELEMETRY_DIR}/${TELEMETRY_FILE}`
      const script = await $.fs.read(scriptPath).catch(() => null)
      const folder = await $.fs.stat(`${root}/${TELEMETRY_DIR}`).catch(() => null)
      if (typeof script === 'string' && sameScript(script, asset) && !planned.isChanged && folder?.kind === 'dir') return T.upToDate
      const answer = await $.ui.ask(T.question(root), { options: ['Install', 'Cancel'], header: 'Telemetry' }).catch(() => '') // asked
      if (answer !== 'Install') return T.declined
      try {
        await writeChecked(scriptPath, asset)
      } catch (err) {
        return T.writeFailed(scriptPath, why(err))
      }
      // The placeholder creates the folder; a file the game already wrote stays.
      if ((await $.fs.stat(filePath).catch(() => null))?.kind !== 'file') {
        try {
          await writeChecked(filePath, PLACEHOLDER)
        } catch (err) {
          return T.writeFailed(filePath, why(err))
        }
      }
      if (planned.isChanged) {
        const again = await $.fs.read(projectPath).catch(() => null)
        if (again !== project) return T.projectChanged
        try {
          await writeChecked(projectPath, planned.text)
        } catch {
          return T.projectFailed
        }
      }
      applies = null
      await refresh()
      return T.installed
    },

    screenshot: async () => {
      if (isShooting) return
      await refresh()
      const root = applies?.is ? applies.root : ''
      const now = await $.clock.now()
      if (!root || telemetryStatus(reading, now) !== 'live') return deps.toast(T.notRunning)
      if ((await isIgnored(deps.light, root, TELEMETRY_DIR)) !== true) return deps.toast(T.shotNotIgnored)
      isShooting = true
      const id = String(Math.round(now))
      pendingShot = id
      await save()
      try {
        await $.fs.write(`${root}/${TELEMETRY_DIR}/${REQUEST_FILE}`, requestText(id)) // asked
        const until = now + SHOT_WAIT_MS
        for (;;) {
          await wait(SHOT_POLL_MS)
          await readFile(root)
          const outcome = shotOutcome(reading, id)
          if (outcome.state === 'ok') {
            await offer(root, outcome.file, T.shotUnfilled)
            break
          }
          if (outcome.state === 'error') {
            deps.toast(T.shotFailed(outcome.error))
            break
          }
          if ((await $.clock.now()) >= until) {
            deps.toast(T.shotTimeout)
            break
          }
        }
      } catch (err) {
        deps.toast(T.requestFailed(why(err)))
      } finally {
        isShooting = false
        pendingShot = ''
        await save()
      }
    },

    offerFile: async () => {
      await refresh()
      const root = applies?.is ? applies.root : ''
      if (!root || !reading?.samples.length) return deps.toast(T.noTelemetry)
      await offer(root, TELEMETRY_FILE, T.fileUnfilled)
    },
  }
}
