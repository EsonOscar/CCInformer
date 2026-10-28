import type { PackTrust } from '../../types'
import type { CheckSpec, ResolvedPack } from './types'

// Turn and demand checks run the repo's own tools (ESLint loads its config and node_modules, a build runs its
// targets), so they wait for repo trust. Edit and batch checks run inside the mod on text it already has.
export const needsTrust = (check: CheckSpec): boolean => check.cost === 'turn' || check.cost === 'demand'

export const runnableChecks = (pack: ResolvedPack, isTrusted: boolean): CheckSpec[] =>
  pack.checks.filter(c => isTrusted || !needsTrust(c))

// A yes given in this clone, kept in the store by repo: it holds only while the repo's config files are unchanged.
export type StoredTrust = { hash: string; at: number }

// A user pack matched by remote is the person's own word for the repo; otherwise a stored yes for these exact
// config files. A yes for files that have changed since is stale and asks again.
export const trustOf = (isUserPack: boolean, stored: StoredTrust | null, hash: string): PackTrust => {
  if (isUserPack) return { isTrusted: true, by: 'user pack', at: 0, isStale: false }
  if (stored && stored.hash === hash) return { isTrusted: true, by: 'you', at: stored.at, isStale: false }
  return { isTrusted: false, by: '', at: 0, isStale: !!stored }
}

export const isStoredTrust = (v: unknown): v is StoredTrust =>
  typeof v === 'object' && v !== null && typeof (v as StoredTrust).hash === 'string' && typeof (v as StoredTrust).at === 'number'

// SHA-256 of the repo's config files, each one's text (or nothing) in a fixed order.
export const configHash = async (texts: (string | null)[]): Promise<string> => {
  const bytes = new TextEncoder().encode(texts.map(t => (t === null ? '\u0000absent' : t)).join('\u0000\u0000'))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
