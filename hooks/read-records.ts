import type { EngineInterface } from 'claude-code'

// A file's text, or '' when it doesn't exist or can't be read.
export async function readText($: EngineInterface, path: string): Promise<string> {
  const text = await $.fs.read(path).catch(() => '')
  return typeof text === 'string' ? text : ''
}

export type RecordFile = { path: string; name: string; mtime: number; session: string }

// The workflow run records Claude Code wrote under this project's sessions, from the sessions changed most
// recently first; `sessions` caps how many sessions are looked in.
export async function listRecordFiles($: EngineInterface, projectsDir: string, sessions = Infinity): Promise<RecordFile[]> {
  const dirs = (await $.fs.list(projectsDir).catch(() => []))
    .filter(d => d.kind === 'dir')
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, sessions)
  const found: RecordFile[] = []
  for (const dir of dirs) {
    const files = await $.fs.list(`${projectsDir}/${dir.name}/workflows`).catch(() => [])
    for (const f of files.filter(f => f.kind === 'file' && /^wf_.*\.json$/.test(f.name)))
      found.push({ path: `${projectsDir}/${dir.name}/workflows/${f.name}`, name: f.name, mtime: f.mtimeMs, session: dir.name })
  }
  return found
}
