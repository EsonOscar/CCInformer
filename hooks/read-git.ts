import type { EngineInterface } from 'claude-code'

import { OPERATION_MARKERS } from './parse'

// What the git folder itself says: an operation in the middle (rebase, merge, ...) and when it last fetched.
export async function gitFolderFacts($: EngineInterface, gitDir: string): Promise<{ operation: string; fetchedAt: number }> {
  let operation = ''
  for (const m of OPERATION_MARKERS) if (!operation && (await $.fs.exists(`${gitDir}/${m.file}`))) operation = m.name
  const fetched = await $.fs.stat(`${gitDir}/FETCH_HEAD`).catch(() => null)
  return { operation, fetchedAt: fetched?.mtimeMs ?? 0 }
}
