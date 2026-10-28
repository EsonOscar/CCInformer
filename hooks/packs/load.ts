import type { EngineInterface } from 'claude-code'

import type { PackReport } from '../../types'
import type { Exec } from '../collect'
import { cleanRemote, markerFiles } from './detect'
import { BUILTINS } from './node-vite'
import { LOCAL_FILE, REPO_FILE, pathsToResolve, resolvePack } from './resolve'
import { configHash, isStoredTrust } from './trust'
import type { ResolvedPack } from './types'

const STORE_TRUST = 'trust:'
const PACK_SUFFIX = '.pack.jsonc'

// Where user packs live, under Claude Code's config folder.
export const userPackDir = (configDir: string): string => configDir + '/ccinformer/packs'

// A file's text, or null when it doesn't exist or can't be read.
async function readText($: EngineInterface, path: string): Promise<string | null> {
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? text : null
}

// The repo the session is in: its root, its origin remote and a key for the clone's git folder. Outside a repo,
// the session's folder with no remote.
async function repoFacts(exec: Exec, cwd: string): Promise<{ root: string; remote: string; repoKey: string }> {
  const located = await exec(['git', 'rev-parse', '--show-toplevel', '--git-common-dir']).catch(() => null)
  const [root, commonDir] = located?.exitCode === 0 ? located.stdout.trim().split('\n') : []
  const remote = await exec(['git', 'config', '--get', 'remote.origin.url']).catch(() => null)
  const top = root?.trim() || cwd
  const common = commonDir?.trim() || ''
  const gitDir = !common ? top : /^([a-z]:|\/)/i.test(common) ? common : top + '/' + common
  return { root: top, remote: remote?.exitCode === 0 ? cleanRemote(remote.stdout) : '', repoKey: gitDir.replace(/[^a-z0-9]+/gi, '-') }
}

// Reads every layer and resolves the pack. Nothing here throws: a missing or broken file is a row in the report.
export async function loadPack(
  $: EngineInterface,
  exec: Exec,
  cwd: string,
  configDir: string,
): Promise<{ pack: ResolvedPack; report: PackReport }> {
  const { root, remote, repoKey } = await repoFacts(exec, cwd)
  const markers: Record<string, string | null> = {}
  for (const file of markerFiles(BUILTINS)) markers[file] = await readText($, `${root}/${file}`)
  const dir = userPackDir(configDir)
  const listed = await $.fs.list(dir).catch(() => [])
  const userPacks: { path: string; text: string }[] = []
  for (const f of listed.filter(f => f.kind === 'file' && f.name.endsWith(PACK_SUFFIX)).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readText($, `${dir}/${f.name}`)
    if (text !== null) userPacks.push({ path: `${dir}/${f.name}`, text })
  }
  const repo = await readText($, `${root}/${REPO_FILE}`)
  const local = await readText($, `${root}/${LOCAL_FILE}`)
  const ignored = local === null ? null : await exec(['git', 'check-ignore', '-q', `${root}/${LOCAL_FILE}`]).catch(() => null)
  const realPaths: Record<string, string | null> = {}
  for (const path of pathsToResolve({ repo, local })) {
    const stat = await $.fs.stat(`${root}/${path}`, { resolve: true }).catch(() => null)
    realPaths[path] = stat ? (stat.realPath ?? `${root}/${path}`) : null
  }
  const stored = await $.store.get(STORE_TRUST + repoKey)
  return resolvePack({
    root,
    remote,
    repoKey,
    markers,
    userPacks,
    repo,
    local,
    isLocalIgnored: ignored?.exitCode === 0,
    realPaths,
    storedTrust: isStoredTrust(stored) ? stored : null,
    hash: await configHash([repo, local]),
    now: await $.clock.now(),
  })
}

// When any file the pack comes from last changed, as one string: a different string means read it all again.
export async function packSignature($: EngineInterface, root: string, configDir: string): Promise<string> {
  const files = [...markerFiles(BUILTINS), REPO_FILE, LOCAL_FILE].map(f => `${root}/${f}`)
  const times: string[] = []
  for (const path of files) times.push(String((await $.fs.stat(path).catch(() => null))?.mtimeMs ?? '-'))
  const listed = await $.fs.list(userPackDir(configDir)).catch(() => [])
  for (const f of listed.filter(f => f.name.endsWith(PACK_SUFFIX))) times.push(f.name + ':' + f.mtimeMs)
  return times.join('|')
}

const ALLOW = 'Allow'

// Asks once whether the repo's own tools (linters, builds, the checks that load its config) may run, and keeps a
// yes for these exact config files. Resolves whether it was given; a dismissal is a no.
export async function askTrust($: EngineInterface, report: PackReport): Promise<boolean> {
  const name = report.remote || report.root
  const answer = await $.ui
    .ask(`Let CCInformer run this repo's own tools (linters, builds) for ${name}?`, { options: [ALLOW, 'Not now'], header: 'Repo trust' })
    .catch(() => '')
  if (answer !== ALLOW) return false
  await $.store.set(STORE_TRUST + report.repoKey, { hash: report.hash, at: await $.clock.now() })
  return true
}

export async function forgetTrust($: EngineInterface, report: PackReport): Promise<void> {
  await $.store.delete(STORE_TRUST + report.repoKey)
}
