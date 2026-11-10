import type { PermissionChoices, SkillsSettings } from '../types'
import { ACTIONS } from './areas'
import { PERMISSIONS, PERMISSION_GROUPS, SAFETY_NOTE, isAllowed, isPassive } from './core/permissions'
import type { PermissionId } from './core/permissions'
import { AGENTS_TEXTS, AGENT_ROLES, PLAN_FILES, agentChoice, changedCount } from './core/skills'
import type { AgentField } from './core/skills'
import { ACCENT, Line, Section } from './ui'
import type { Glyph, Kit } from './ui'

export type SettingsNav = {
  toggle: (id: PermissionId) => void
  approveAll: () => void
  denyAll: () => void
  explain: () => void
  togglePlanFiles: () => void
  cycleAgent: (script: string, role: string, field: AgentField) => void
  resetAgents: () => void
}

const ON: Glyph = { char: '✓', color: 'success' }
const OFF: Glyph = { char: '○', color: 'inactive', dim: true }
// A workflow agent's row the person changed from its default.
const CHANGED: Glyph = { char: '●', color: ACCENT }

// Everything CCInformer does by itself, each with its switch: press a row's on/off to flip it. Approve all and Deny all
// change every switch but the Safety ones; explain hands Claude the list to put in plain words. Last, the planning
// skills' own settings, which neither of them touches: the Plan files switch, and the model and effort each kind of
// workflow agent runs on, where a press on a value moves it to the next one.
export const SettingsView = (k: Kit, choices: PermissionChoices, skills: SkillsSettings, nav: SettingsNav): JSX.Element => {
  const { Box, Button, Text } = k
  const onCount = PERMISSIONS.filter(d => isAllowed(choices, d.id)).length
  const changed = changedCount(skills)
  return (
    <Box flexDirection="column">
      {Section(k, 'Settings', isPassive(choices) ? 'passive' : `${onCount} of ${PERMISSIONS.length} on`)}
      <Text dimColor wrap="wrap">
        What CCInformer does by itself. With all of it off, it only shows what you open; keys, buttons and /ccinformer commands always work. A new install starts that way, except Safety.
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
                  {/* Indented by padding, not spaces, so a wrapped line keeps the indent. */}
                  <Box paddingLeft={2}>
                    <Text dimColor wrap="wrap">
                      {d.description}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        )
      })}
      <Box flexDirection="column">
        {Section(k, PLAN_FILES.group, skills.planFiles ? '1/1' : '0/1')}
        <Text dimColor wrap="wrap">
          {PLAN_FILES.note}
        </Text>
        {Line(
          k,
          skills.planFiles ? ON : OFF,
          PLAN_FILES.label,
          <Button key="skills-planFiles" plain hotkey={ACTIONS.debug.planFiles} onPress={nav.togglePlanFiles}>
            <Text color={skills.planFiles ? ACCENT : 'inactive'} dimColor={!skills.planFiles}>
              {skills.planFiles ? 'on' : 'off'}
            </Text>
          </Button>,
        )}
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {PLAN_FILES.description}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        {Section(k, AGENTS_TEXTS.heading, changed ? AGENTS_TEXTS.changed(changed) : AGENTS_TEXTS.defaults)}
        <Text dimColor wrap="wrap">
          {AGENTS_TEXTS.note}
        </Text>
        <Box flexDirection="row" marginTop={1}>
          <Button key="skills-agents-reset" plain hotkey={ACTIONS.debug.agentDefaults} onPress={nav.resetAgents}>
            <Text color={ACCENT}>{AGENTS_TEXTS.reset}</Text>
          </Button>
        </Box>
        {AGENT_ROLES.map(d => {
          const choice = agentChoice(skills, d.script, d.role)
          const id = `agent-${d.script}.${d.role}`
          // A value in the accent colour is one the person changed.
          const value = (field: AgentField) => (
            <Button key={`${id}-${field}`} plain onPress={() => nav.cycleAgent(d.script, d.role, field)}>
              <Text color={choice[field] === d[field] ? 'inactive' : ACCENT}>{choice[field]}</Text>
            </Button>
          )
          return Line(
            k,
            choice.isDefault ? OFF : CHANGED,
            d.label,
            <Box key={id} flexDirection="row" columnGap={1}>
              {value('model')}
              {value('effort')}
            </Box>,
          )
        })}
      </Box>
    </Box>
  )
}
