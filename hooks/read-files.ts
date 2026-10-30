import type { EngineInterface } from 'claude-code'

import { matchesGlob } from './checks/glob'

// The files under `dir` (repo-relative), `depth` folders down.
async function listFiles($: EngineInterface, root: string, dir: string, depth: number): Promise<string[]> {
  const entries = await $.fs.list(dir ? `${root}/${dir}` : root).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const path = dir ? `${dir}/${e.name}` : e.name
    if (e.kind === 'file') out.push(path)
    else if (e.kind === 'dir' && depth > 0) out.push(...(await listFiles($, root, path, depth - 1)))
  }
  return out
}

// The files a glob matches, repo-relative: listed from its last folder without a wildcard, as many folders down as
// the glob has, or `maxDepth` when it holds `**`.
export async function filesOf($: EngineInterface, root: string, glob: string, maxDepth: number): Promise<string[]> {
  const parts = glob.split('/')
  const wild = parts.findIndex(p => /[*?{]/.test(p))
  if (wild < 0) return (await $.fs.exists(`${root}/${glob}`)) ? [glob] : []
  const dir = parts.slice(0, wild).join('/')
  const depth = glob.includes('**') ? maxDepth : parts.length - wild - 1
  return (await listFiles($, root, dir, depth)).filter(f => matchesGlob([glob], f))
}
