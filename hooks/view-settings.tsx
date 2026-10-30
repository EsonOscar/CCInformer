import type { PermissionChoices } from '../types'
import { ACTIONS } from './areas'
import { PERMISSIONS, PERMISSION_GROUPS, SAFETY_NOTE, isAllowed, isPassive } from './core/permissions'
import type { PermissionId } from './core/permissions'
import { ACCENT, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

export type SettingsNav = { toggle: (id: PermissionId) => void; approveAll: () => void; denyAll: () => void; explain: () => void }

const ON: Glyph = { char: '✓', color: 'success' }
const OFF: Glyph = { char: '○', color: 'inactive', dim: true }

// Everything CCInformer does by itself, each with its switch: press a row's on/off to flip it. Approve all and Deny all
// change every switch but the Safety ones; explain hands Claude the list to put in plain words.
export const SettingsView = (k: Kit, choices: PermissionChoices, nav: SettingsNav): JSX.Element => {
  const { Box, Button, Text } = k
  const onCount = PERMISSIONS.filter(d => isAllowed(choices, d.id)).length
  return (
    <Box flexDirection="column">
      {Section(k, 'Settings', isPassive(choices) ? 'passive' : `${onCount} of ${PERMISSIONS.length} on`)}
      <Text dimColor wrap="wrap">
        What CCInformer does by itself. With everything off it only shows what you open; keys, buttons and /ccinformer commands still work.
      </Text>
      <Box flexDirection="row" columnGap={2} marginTop={1}>
        <Button key="settings-approve" plain hotkey={ACTIONS.debug.approveAll} onPress={nav.approveAll}>
          <Text color={ACCENT}>approve all</Text>
        </Button>
        <Button key="settings-deny" plain hotkey={ACTIONS.debug.denyAll} onPress={nav.denyAll}>
          <Text color={ACCENT}>deny all</Text>
        </Button>
        <Button key="settings-explain" plain hotkey={ACTIONS.debug.explain} onPress={nav.explain}>
          <Text color={ACCENT}>have Claude explain these</Text>
        </Button>
      </Box>
      {PERMISSION_GROUPS.map(g => {
        const defs = PERMISSIONS.filter(d => d.group === g.id)
        const on = defs.filter(d => isAllowed(choices, d.id)).length
        return (
          <Box key={'group-' + g.id} flexDirection="column">
            {Section(k, g.label, `${on}/${defs.length}`)}
            {g.id === 'safety' && (
              <Text dimColor wrap="wrap">
                {SAFETY_NOTE}
              </Text>
            )}
            {defs.map(d => {
              const isOn = isAllowed(choices, d.id)
              return (
                <Box key={'perm-row-' + d.id} flexDirection="column">
                  {Line(
                    k,
                    isOn ? ON : OFF,
                    d.label,
                    <Button key={'perm-' + d.id} plain onPress={() => nav.toggle(d.id)}>
                      <Text color={isOn ? ACCENT : 'inactive'} dimColor={!isOn}>
                        {isOn ? 'on' : 'off'}
                      </Text>
                    </Button>,
                  )}
                  <Text dimColor wrap="wrap">
                    {'  ' + d.description}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}
