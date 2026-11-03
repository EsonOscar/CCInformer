import type { PackTrust } from '../../types'
import type { CheckSpec, ResolvedPack } from './types'

// Turn and demand checks run the repo's own tools (ESLint loads its config and node_modules, a build runs its
// targets), so they wait for repo trust. Edit checks, and the translation tables compared once a turn ends, run
// inside the mod on files it reads itself.
export const needsTrust = (check: CheckSpec): boolean => (check.cost === 'turn' || check.cost === 'demand') && check.analyzer !== 'i18n-keysets'

export const runnableChecks = (pack: ResolvedPack, isTrusted: boolean): CheckSpec[] =>
  pack.checks.filter(c => isTrusted || !needsTrust(c))

// A yes given in this clone, kept in the store by repo until the person withdraws it. A yes stored by an older
// version also carries the hash of the repo config files it was given for; those files are no longer read, so the
// hash is ignored and the yes still counts.
export type StoredTrust = { at: number }

// A user pack matched by remote is the person's own word for the repo; otherwise a yes the person gave here.
export const trustOf = (isUserPack: boolean, stored: StoredTrust | null): PackTrust => {
  if (isUserPack) return { isTrusted: true, by: 'user pack', at: 0 }
  if (stored) return { isTrusted: true, by: 'you', at: stored.at }
  return { isTrusted: false, by: '', at: 0 }
}

export const isStoredTrust = (v: unknown): v is StoredTrust =>
  typeof v === 'object' && v !== null && typeof (v as StoredTrust).at === 'number'
