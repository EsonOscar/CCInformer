import type { PackManifest } from './types'

// The marker files every built-in looks for, so the loader reads each one once.
export const markerFiles = (builtins: PackManifest[]): string[] => [...new Set(builtins.flatMap(b => (b.detect ?? []).map(r => r.file)))]

// The built-in whose markers score highest, given each marker file's text (null when it doesn't exist). A built-in
// with a required marker missing scores nothing; nothing scoring means no built-in.
export const detect = (builtins: PackManifest[], files: Record<string, string | null>): PackManifest | null => {
  let best: { pack: PackManifest; score: number } | null = null
  for (const pack of builtins) {
    let score = 0
    let isOut = false
    for (const rule of pack.detect ?? []) {
      const text = files[rule.file] ?? null
      const hit = text !== null && (rule.contains === undefined || text.includes(rule.contains))
      if (hit) score += rule.weight
      else if (rule.required) isOut = true
    }
    if (!isOut && score > 0 && (!best || score > best.score)) best = { pack, score }
  }
  return best?.pack ?? null
}

// A remote URL without any credentials in it (`https://user:token@host/...`), so it can be shown and kept.
export const cleanRemote = (url: string): string => url.trim().replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1')

// A remote URL as `host/owner/repo`, lower case: `git@github.com:Acme/App.git` and
// `https://user@github.com/Acme/App` both read `github.com/acme/app`.
export const normalizeRemote = (url: string): string =>
  url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')

// A glob over a normalized remote: `*` stands for any run of characters but `/`, `**` for any run at all.
export const remoteMatches = (pattern: string, remote: string): boolean => {
  const source = normalizeRemote(pattern)
    .split(/(\*\*|\*)/)
    .map(part => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp('^' + source + '$').test(normalizeRemote(remote))
}
