import type { Color } from 'claude-code'

import type { EnvTask } from '../types'
import type { Kit } from './ui'

const TONE_COLORS: Record<EnvTask['tone'], Color> = { local: 'inactive', shared: 'warning', prod: 'error' }

// The tasks the band warns about: those aimed at a shared or prod environment, prod first, then the newest.
export const bandTasks = (tasks: EnvTask[]): EnvTask[] =>
  tasks
    .filter(t => t.tone !== 'local')
    .sort((a, b) => (a.tone === b.tone ? b.startedAt - a.startedAt : a.tone === 'prod' ? -1 : 1))

// One line above the prompt: the environment, what runs against it, how many more, and × to clear a row whose end
// never arrived.
export const EnvBand = (k: Kit, tasks: EnvTask[], dismiss: (id: string) => void): JSX.Element => {
  const { Box, Button, Text } = k
  const [top, ...rest] = tasks
  if (!top) return <Box />
  const color = TONE_COLORS[top.tone]
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={color} weight="bold">
        {'⚠ ' + top.envLabel.toUpperCase()}
      </Text>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{top.label || 'a process'}</Text>
      </Box>
      <Text dimColor>{top.tone === 'prod' ? 'targets production' : 'targets a shared environment'}</Text>
      {rest.length > 0 && <Text dimColor>{`+${rest.length} more`}</Text>}
      <Button key="band-dismiss" plain onPress={() => dismiss(top.id)}>
        <Text dimColor>×</Text>
      </Button>
    </Box>
  )
}
