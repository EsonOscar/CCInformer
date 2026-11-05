import type { CheckRun, Finding } from '../../types'
import type { Lane } from '../core/lanes'
import type { CheckSpec, ResolvedPack } from '../packs/types'
import { covers, isTold } from './findings'
import { changedScenes, glob, grepLines, headOid, headText, literal } from './scene-git'
import { connectionFindings, nodePathFindings, parseScene, removedNames, resToRepo, scriptInfo } from './tscn'
import type { Scene, ScriptInfo } from './tscn'

// The Godot scene checks (tscn-connections, tscn-nodepaths), once a turn that wrote a scene or a script it covers ends.
// Compared inside the mod, so they need no repo trust: files are read through the callbacks and git through the light
// lane, one read at a time. What run.ts hands in reads and writes; this decides.

// The most scenes one run reads; the rest wait in `pending` and go first next turn.
export const MAX_SCENES = 20
// How many levels of partial parts and base classes a connection's method is looked for in.
const MAX_BASE_DEPTH = 3
// The host reads at most 4 MiB of a file or a command's output: a bigger scene is skipped on both sides.
const MAX_SCENE_BYTES = 4 * 1024 * 1024

export const SCENE_TEXTS = {
  gitFailed: 'git could not read the scenes',
  noProject: (file: string) => `no project.godot above ${file}`,
  tooLarge: (n: number) => `${n} scene${n === 1 ? '' : 's'} too large`,
}

export type SceneIO = {
  light: Lane
  // A file's modified time and size, '' when it isn't there.
  stampOf: (path: string) => Promise<string>
  read: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  now: () => Promise<number>
  heldFor: (check: string) => Promise<Set<string>>
  saveFindings: (check: string, files: string[], found: Finding[]) => Promise<unknown>
  saveRun: (run: CheckRun) => Promise<unknown>
  // Hands the model what a run found (only findings it wasn't told before), for the files stamped.
  tell: (check: string, files: string[], found: Finding[], stamps: Record<string, string>) => void
  pending: Map<string, Set<string>>
  // Asks for another pass after this one, for the scenes past the cap.
  queue: () => void
}

const isTscnCheck = (c: CheckSpec) => c.cost === 'turn' && (c.analyzer === 'tscn-connections' || c.analyzer === 'tscn-nodepaths')
const sizeOf = (stamp: string) => Number(stamp.split(':')[1] ?? 0)
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const EMPTY_SCENE: Scene = { nodes: [], connections: [] }

export const createSceneChecks = (io: SceneIO) => {
  // The removed-name map of the last full node-path run, by the commit and the changed scenes' stamps it was built from.
  let removedCache: { key: string; removed: Map<string, string> } | null = null

  return async (pack: ResolvedPack, root: string, written: string[]): Promise<void> => {
    const checks = pack.checks.filter(isTscnCheck)
    if (!checks.length) return
    // The folder project.godot is in, nearest above a file ('' for the repo's top), or null when there's none.
    const projectDirs = new Map<string, string | null>()
    const projectDirOf = async (file: string): Promise<string | null> => {
      let dir = dirOf(file)
      for (;;) {
        const known = projectDirs.get(dir)
        if (known !== undefined) return known
        if (await io.exists(`${root}/${dir ? dir + '/' : ''}project.godot`)) {
          projectDirs.set(dir, dir)
          return dir
        }
        if (!dir) {
          projectDirs.set('', null)
          return null
        }
        dir = dirOf(dir)
      }
    }
    for (const check of checks) {
      const covered = written.filter(f => covers(check, f))
      const queued = [...(io.pending.get(check.id) ?? [])]
      io.pending.delete(check.id)
      if (!covered.length && !queued.length) continue
      const at = await io.now()
      const run: CheckRun = { check: check.id, label: check.label, at, ms: 0, files: 0, isRunning: false, waitsForTrust: false, error: '', elsewhere: 0 }
      const done = async (files: number, error: string, note = '') =>
        io.saveRun({ ...run, files, ms: (await io.now()) - at, error, ...(note ? { note } : {}) })
      const result =
        check.analyzer === 'tscn-connections' ? await connections(check, root, covered, queued, projectDirOf) : await nodePaths(check, root, covered, queued)
      if (result.error) {
        await done(0, result.error)
        continue
      }
      await done(result.files, '', result.tooLarge ? SCENE_TEXTS.tooLarge(result.tooLarge) : '')
    }
  }

  // The scenes a run reads, at most MAX_SCENES: the ones held back last time first, then in the order given. The rest
  // wait for the next pass.
  function capped(check: CheckSpec, queued: string[], ordered: string[]): { scenes: string[]; isCapped: boolean } {
    const all = [...new Set([...queued, ...ordered])]
    if (all.length <= MAX_SCENES) return { scenes: all, isCapped: false }
    io.pending.set(check.id, new Set(all.slice(MAX_SCENES)))
    io.queue()
    return { scenes: all.slice(0, MAX_SCENES), isCapped: true }
  }

  // A scene's text and stamp, or why it can't be compared: gone, too big, or unreadable right now.
  async function sceneFile(root: string, path: string): Promise<{ text: string; stamp: string } | 'gone' | 'large' | 'unread'> {
    const stamp = await io.stampOf(`${root}/${path}`)
    if (!stamp) return 'gone'
    if (sizeOf(stamp) > MAX_SCENE_BYTES) return 'large'
    const text = await io.read(`${root}/${path}`)
    return text ? { text, stamp } : 'unread'
  }

  // Saves a run's findings over the files it looked at, keeps the held set current, and tells the model the new ones.
  async function save(check: CheckSpec, root: string, files: string[], found: Finding[]): Promise<void> {
    await io.saveFindings(check.id, files, found)
    const held = await io.heldFor(check.id)
    for (const f of files) held.delete(f)
    for (const f of found) held.add(f.file)
    const stamps: Record<string, string> = {}
    for (const f of new Set(found.filter(isTold).map(x => x.file))) stamps[f] = await io.stampOf(`${root}/${f}`)
    io.tell(check.id, files, found, stamps)
  }

  type Result = { files: number; error: string; tooLarge: number }

  async function connections(check: CheckSpec, root: string, covered: string[], queued: string[], projectDirOf: (f: string) => Promise<string | null>): Promise<Result> {
    const writtenScenes = covered.filter(f => f.endsWith('.tscn'))
    const writtenScripts = covered.filter(f => f.endsWith('.cs'))
    const referencing: string[] = []
    for (const cs of writtenScripts) {
      // A script outside every Godot project (a test project, a tool) belongs to no scene.
      const dir = await projectDirOf(cs)
      if (dir === null) continue
      const res = `res://${dir ? cs.slice(dir.length + 1) : cs}`
      const found = await grepLines(io.light, root, ['-l', '-F', '-e', `path="${res}"`], [glob('**/*.tscn')])
      if (!found.isComplete) return { files: 0, error: SCENE_TEXTS.gitFailed, tooLarge: 0 }
      referencing.push(...found.hits.map(h => h.file))
    }
    // A fix in a base or partial class touches no scene: the scenes holding findings are looked at again.
    const held = writtenScripts.length ? [...(await io.heldFor(check.id))] : []
    const { scenes } = capped(check, queued, [...writtenScenes, ...referencing, ...held].filter(f => covers(check, f) && f.endsWith('.tscn')))
    const scripts = new Map<string, { path: string; info: ScriptInfo } | null>()
    const chains = new Map<string, Set<string> | null>()
    const evaluated: string[] = []
    const found: Finding[] = []
    let tooLarge = 0
    for (const scene of scenes) {
      const file = await sceneFile(root, scene)
      if (file === 'large') tooLarge++
      if (typeof file === 'string') {
        // A scene that's gone or unreadable has nothing to check; a gone one keeps no findings.
        if (file === 'gone') evaluated.push(scene)
        continue
      }
      const dir = await projectDirOf(scene)
      if (dir === null) return { files: 0, error: SCENE_TEXTS.noProject(scene), tooLarge: 0 }
      const parsed = parseScene(file.text)
      for (const node of parsed.nodes)
        if (node.script.endsWith('.cs') && !scripts.has(node.script)) {
          const path = resToRepo(dir, node.script)
          const text = await io.read(`${root}/${path}`)
          scripts.set(node.script, text ? { path, info: scriptInfo(text) } : null)
        }
      for (const s of scripts.values())
        if (s && !chains.has(s.info.className)) {
          const chain = await methodsUp(root, s.info)
          if (chain === 'failed') return { files: 0, error: SCENE_TEXTS.gitFailed, tooLarge: 0 }
          chains.set(s.info.className, chain)
        }
      evaluated.push(scene)
      found.push(...connectionFindings(check, scene, parsed, res => scripts.get(res) ?? null, info => chains.get(info.className) ?? null))
    }
    await save(check, root, evaluated, found)
    return { files: evaluated.length, error: '', tooLarge }
  }

  // A class's methods with its partial parts and the repo's base classes, up to MAX_BASE_DEPTH levels. Null when the
  // chain is still in the repo at the limit (can't be sure); a base the repo doesn't declare is the engine's.
  async function methodsUp(root: string, info: ScriptInfo): Promise<Set<string> | null | 'failed'> {
    const methods = new Set(info.methods)
    const seen = new Set<string>()
    const declaring = (names: string[]) => grepLines(io.light, root, ['-l', '-E', '-w', '-e', `class[[:space:]]+(${names.join('|')})`], [glob('**/*.cs')])
    // Level 0 is the class with its partial parts; each level after it, the bases the level before named.
    let names = [info.className]
    let found = await declaring(names)
    for (let depth = 0; ; depth++) {
      if (!found.isComplete) return 'failed'
      names.forEach(n => seen.add(n))
      const next = new Set<string>()
      for (const hit of found.hits) {
        const part = scriptInfo(await io.read(`${root}/${hit.file}`))
        if (!names.includes(part.className)) continue
        part.methods.forEach(m => methods.add(m))
        for (const base of part.bases) if (!seen.has(base)) next.add(base)
      }
      if (!next.size) return methods
      names = [...next]
      found = await declaring(names)
      if (!found.isComplete) return 'failed'
      // A base the repo doesn't declare is the engine's (or an interface): the chain ends there.
      if (!found.hits.length) return methods
      if (depth + 1 >= MAX_BASE_DEPTH) return null
    }
  }

  async function nodePaths(check: CheckSpec, root: string, covered: string[], queued: string[]): Promise<Result> {
    const oid = await headOid(io.light, root)
    // No commit yet: nothing was removed against one.
    if (!oid) return { files: 0, error: '', tooLarge: 0 }
    const changed = await changedScenes(io.light, root)
    if (!changed) return { files: 0, error: SCENE_TEXTS.gitFailed, tooLarge: 0 }
    const writtenScenes = covered.filter(f => f.endsWith('.tscn'))
    const writtenScripts = covered.filter(f => f.endsWith('.cs'))
    const scenesChanged = changed.filter(f => covers(check, f))
    const stamps: string[] = []
    for (const s of scenesChanged) stamps.push(`${s}=${await io.stampOf(`${root}/${s}`)}`)
    const key = [oid, ...stamps].join('|')
    // The usages: every covered script on a full run, the written ones when the removed names are known already.
    const isCached = !!removedCache && removedCache.key === key && !writtenScenes.length && !queued.length
    let removed: Map<string, string>
    let tooLarge = 0
    let isCapped = false
    if (isCached) removed = removedCache!.removed
    else {
      const order = [...writtenScenes.filter(s => scenesChanged.includes(s)), ...scenesChanged]
      const pick = capped(check, queued, order)
      isCapped = pick.isCapped
      removed = new Map()
      for (const scene of pick.scenes) {
        const now = await sceneFile(root, scene)
        if (now === 'large') tooLarge++
        if (now === 'large' || now === 'unread') continue
        const head = await headText(io.light, root, scene)
        if (head === null) return { files: 0, error: SCENE_TEXTS.gitFailed, tooLarge: 0 }
        for (const name of removedNames(parseScene(head), now === 'gone' ? EMPTY_SCENE : parseScene(now.text))) removed.set(name, scene)
      }
      // A name another working scene still has isn't gone.
      if (removed.size) {
        const present = await grepLines(io.light, root, ['-o', '-F', ...[...removed.keys()].flatMap(n => ['-e', `name="${n}"`])], [glob('**/*.tscn')])
        if (!present.isComplete) return { files: 0, error: SCENE_TEXTS.gitFailed, tooLarge: 0 }
        for (const hit of present.hits) removed.delete(hit.text.replace(/^name="|"$/g, ''))
      }
      removedCache = isCapped ? null : { key, removed }
    }
    const scripts = isCached ? writtenScripts : null
    if (scripts && !scripts.length) return { files: 0, error: '', tooLarge: 0 }
    let hits: { file: string; line: number; text: string }[] = []
    if (removed.size) {
      const names = [...removed.keys()].flatMap(n => ['-e', n])
      const found = await grepLines(io.light, root, ['-F', '-w', ...names], scripts ? scripts.map(literal) : [glob('**/*.cs')])
      if (!found.isComplete) return { files: 0, error: SCENE_TEXTS.gitFailed, tooLarge: 0 }
      hits = found.hits.filter(h => covers(check, h.file))
    }
    const found = nodePathFindings(check, removed, hits)
    // A full run looked at every script: the files held from before are cleared where nothing is found any more. A
    // partial one (written scripts only, or past the scene cap) saves over what it looked at.
    const isFull = !scripts && !isCapped
    const files = isFull
      ? [...new Set([...found.map(f => f.file), ...(await io.heldFor(check.id))])]
      : scripts ?? [...new Set(found.map(f => f.file))]
    await save(check, root, files, found)
    return { files: scripts ? scripts.length : scenesChanged.length, error: '', tooLarge }
  }
}
