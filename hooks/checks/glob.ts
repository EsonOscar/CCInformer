// A glob over a repo-relative path with forward slashes: `**/` spans any number of folders (none too), `**` anything,
// `*` and `?` stay within one folder, and `{a,b}` is either.
const source = (glob: string): string => {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      const isFolders = glob[i + 2] === '/'
      re += isFolders ? '(?:.*/)?' : '.*'
      i += isFolders ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i)
      re += '(?:' + glob.slice(i + 1, end).split(',').map(source).join('|') + ')'
      i = end
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

export const matchesGlob = (globs: string[], path: string): boolean => globs.some(g => new RegExp('^' + source(g) + '$').test(path))

// A file's path from the repo's top folder, forward slashes; '' when it lies outside. Windows paths compare without
// case, so `C:\Repo\src\a.ts` is `src/a.ts` under `c:/repo`.
export const repoPath = (root: string, path: string): string => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const top = norm(root)
  const full = norm(path)
  if (!top) return ''
  const isWindows = /^[a-z]:/i.test(top)
  const [a, b] = isWindows ? [full.toLowerCase(), top.toLowerCase()] : [full, top]
  if (!a.startsWith(b + '/')) return ''
  return full.slice(top.length + 1)
}

// A file's repo-relative path from what a tool reported: a relative path is joined to the root, `.` and `..` are
// resolved (one that climbs out of the root lands outside), backslashes read as `/`; then as repoPath. No decoding
// here: a gcc path may hold a literal `%`.
export const toRepoFile = (root: string, path: string): string => {
  const norm = path.replace(/\\/g, '/')
  const full = /^([a-z]:)?\//i.test(norm) ? norm : root.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + norm
  const [head, ...parts] = full.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (!out.length) return ''
      out.pop()
    } else if (part && part !== '.') out.push(part)
  }
  return repoPath(root, head + '/' + out.join('/'))
}
