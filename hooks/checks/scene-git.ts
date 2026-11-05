import type { Ran } from '../collect'
import type { Lane } from '../core/lanes'
import type { GrepHit } from './tscn'

// The git reads the scene checks make, through the light lane, in the repo's top folder: which scenes changed since
// the last commit, a scene as committed, the commit, and git grep. Read-only, and a command that can't start reads as
// a failed run, never a thrown hook.

const ran = (light: Lane, root: string, argv: string[]): Promise<Ran> =>
  light(argv, undefined, root).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))

// A path pathspec that takes the name as written (no glob characters), from the repo's top folder.
export const literal = (path: string): string => `:(top,literal)${path}`
// A glob pathspec from the repo's top folder, such as **/*.tscn.
export const glob = (pattern: string): string => `:(top,glob)${pattern}`

// The scenes modified or deleted since the last commit (an added one has nothing to lose), or null when git can't say.
export const changedScenes = async (light: Lane, root: string): Promise<string[] | null> => {
  const r = await ran(light, root, ['git', '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '--diff-filter=MD', 'HEAD', '--', glob('**/*.tscn')])
  if (r.exitCode !== 0 || r.isStdoutTruncated) return null
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

// A scene as the last commit has it, or null when it can't be read whole.
export const headText = async (light: Lane, root: string, path: string): Promise<string | null> => {
  const r = await ran(light, root, ['git', 'show', `HEAD:${path}`])
  return r.exitCode === 0 && !r.isStdoutTruncated ? r.stdout : null
}

// The last commit, or null in a repo without one.
export const headOid = async (light: Lane, root: string): Promise<string | null> => {
  const r = await ran(light, root, ['git', 'rev-parse', 'HEAD'])
  return r.exitCode === 0 ? r.stdout.trim() || null : null
}

// git grep over tracked and untracked files (not ignored ones, so .godot/ and build output are never searched), with
// NUL-separated output. Exit 1 is git's "nothing matched": a complete answer. Anything else but 0, or output cut at the
// host's limit, is incomplete. With -l each hit is a file; with -o its text is the match.
export const grepLines = async (light: Lane, root: string, args: string[], pathspecs: string[]): Promise<{ hits: GrepHit[]; isComplete: boolean }> => {
  const r = await ran(light, root, ['git', '-c', 'core.quotePath=false', 'grep', '--untracked', '-n', '-z', '-I', ...args, '--', ...pathspecs])
  if (r.exitCode === 1 && !r.stdout) return { hits: [], isComplete: true }
  if (r.exitCode !== 0 || r.isStdoutTruncated) return { hits: [], isComplete: false }
  if (args.includes('-l')) return { hits: r.stdout.split('\0').filter(Boolean).map(file => ({ file, line: 0, text: '' })), isComplete: true }
  const hits: GrepHit[] = []
  for (const record of r.stdout.split('\n')) {
    const [file, line, ...text] = record.split('\0')
    if (file && line && /^\d+$/.test(line)) hits.push({ file, line: Number(line), text: text.join('\0') })
  }
  return { hits, isComplete: true }
}
