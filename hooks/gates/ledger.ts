import type { EngineInterface } from 'claude-code'

import { SEGMENT_CHARS, appended, eventLine, latestSegment, ledgerName } from './match'
import type { ApprovalEvent } from './match'

// The approval log, one file per session under the repo's folder. `fs.write` replaces a whole file and there is no
// append, so each session's open segment is kept here as last written, read back from disk on first use (a hot
// reload starts this module over), and writes go one at a time.
const segments = new Map<string, { segment: number; text: string }>()
let chain: Promise<unknown> = Promise.resolve()

async function openSegment($: EngineInterface, dir: string, sessionId: string): Promise<{ segment: number; text: string }> {
  const known = segments.get(dir + '/' + sessionId)
  if (known) return known
  // No folder yet is no segments: the first write makes it.
  const names = (await $.fs.list(dir).catch(() => [])).map(f => f.name)
  const segment = latestSegment(names, sessionId)
  const text = await $.fs.read(dir + '/' + ledgerName(sessionId, segment)).catch(() => null)
  return { segment, text: typeof text === 'string' ? text : '' }
}

// Adds one event to this session's log. Rejects when it couldn't be written, so the gate can refuse the call.
export function appendEvent($: EngineInterface, dir: string, sessionId: string, ev: ApprovalEvent): Promise<void> {
  const write = chain.then(async () => {
    const next = appended(await openSegment($, dir, sessionId), eventLine(ev), SEGMENT_CHARS)
    await $.fs.write(dir + '/' + ledgerName(sessionId, next.segment), next.text) // may: safety.approvalGates
    segments.set(dir + '/' + sessionId, next)
  })
  chain = write.catch(() => undefined)
  return write
}
