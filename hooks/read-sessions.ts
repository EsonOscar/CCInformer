import type { EngineInterface } from 'claude-code'

import type { SessionBeat } from '../types'
import { readText } from './read-records'
import { parseHead } from './records'

// The branch this folder's checkout is on, read from .git (a folder, or a worktree's file pointing at one); ''
// outside a repo or on a detached HEAD.
export async function readBranch($: EngineInterface): Promise<string> {
  const dotGit = await $.fs.stat('.git').catch(() => null)
  if (!dotGit) return ''
  if (dotGit.kind === 'dir') return parseHead(await readText($, '.git/HEAD')).branch
  const { gitdir } = parseHead(await readText($, '.git'))
  return gitdir ? parseHead(await readText($, gitdir + '/HEAD')).branch : ''
}

// Every session's beat in the store all sessions share; one not heard from for `forgetAfterMs` is deleted.
export async function readBeats($: EngineInterface, prefix: string, now: number, forgetAfterMs: number): Promise<SessionBeat[]> {
  const beats: SessionBeat[] = []
  for (const key of (await $.store.keys()).filter(k => k.startsWith(prefix))) {
    const b = (await $.store.get(key)) as SessionBeat | undefined
    if (!b || typeof b.updatedAt !== 'number') continue
    if (now - b.updatedAt > forgetAfterMs) await $.store.delete(key)
    else beats.push(b)
  }
  return beats
}
