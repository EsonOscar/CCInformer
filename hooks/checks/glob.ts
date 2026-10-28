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
