import type { SessionBeat } from '../types'
import { ago, lastSegment, shortModel, spinner } from './format'
import { sessionGroups } from './insight'
import { ACCENT, Empty, Line, Section } from './ui'
import type { Kit } from './ui'

const ELSEWHERE_SHOWN = 8

// The other Claude sessions on this machine: those working in this folder first, since they share its files.
export const SessionsView = (k: Kit, beats: SessionBeat[], selfId: string, cwd: string, now: number): JSX.Element => {
  const { Box, Text } = k
  const { here, elsewhere } = sessionGroups(beats, selfId, cwd, now)
  const busyOthers = here.filter(b => b.id !== selfId && b.isBusy)
  return (
    <Box flexDirection="column">
      {Section(k, 'This folder · ' + lastSegment(cwd), String(here.length))}
      {busyOthers.length > 0 && (
        <Text color="warning" wrap="truncate-end">
          {`  ⚠ ${busyOthers.length === 1 ? 'Another session is' : busyOthers.length + ' other sessions are'} working here now`}
        </Text>
      )}
      {here.length <= 1 && Empty(k, 'No other session in this folder.')}
      {here.map(b => Session(k, b, selfId, now, false))}
      {Section(k, 'Elsewhere', elsewhere.length ? String(elsewhere.length) : '')}
      {elsewhere.length === 0 && Empty(k, 'No sessions in other folders.')}
      {elsewhere.slice(0, ELSEWHERE_SHOWN).map(b => Session(k, b, selfId, now, true))}
    </Box>
  )
}

// A session on two lines: who it is and what it is doing, then what it last worked on.
const Session = (k: Kit, b: SessionBeat, selfId: string, now: number, showFolder: boolean): JSX.Element => {
  const { Box, Text } = k
  const isSelf = b.id === selfId
  const name = isSelf ? 'this session' : b.id.slice(0, 8)
  const state = b.isBusy ? 'working' : 'idle ' + ago(now - b.updatedAt).replace(' ago', '')
  const facts = [showFolder ? lastSegment(b.cwd) : '', b.branch, shortModel(b.model), b.contextPercent ? b.contextPercent + '% ctx' : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <Box flexDirection="column" marginLeft={1}>
      {Line(
        k,
        b.isBusy ? { char: spinner(now), color: isSelf ? ACCENT : 'warning' } : { char: '○', color: 'inactive' },
        <Box flexDirection="row" columnGap={1}>
          <Text color={isSelf ? ACCENT : 'text'} weight={isSelf ? 'semibold' : 'regular'}>
            {name}
          </Text>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {facts}
            </Text>
          </Box>
        </Box>,
        <Text color={b.isBusy ? ACCENT : 'inactive'}>{state}</Text>,
      )}
      {b.task && (
        <Text dimColor italic wrap="truncate-end">
          {'  “' + b.task + '”'}
        </Text>
      )}
    </Box>
  )
}
