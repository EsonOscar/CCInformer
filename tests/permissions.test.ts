import { describe, expect, test } from 'claude-code/testing'

import { NO_CHOICES, PERMISSIONS, PERMISSION_GROUPS, allSet, choicesFrom, explainPrompt, isAllowed, isPassive, toggled } from '../hooks/core/permissions'
import type { PermissionId } from '../hooks/core/permissions'

const ORDINARY = PERMISSIONS.filter(d => d.group !== 'safety').map(d => d.id)
const SAFETY = PERMISSIONS.filter(d => d.group === 'safety').map(d => d.id)

describe('permissions', () => {
  test('nothing stored, or anything odd, is no choice: every permission at its default', async () => {
    for (const stored of [undefined, null, 'off', 3, [], { base: 'maybe' }, { base: 'on', set: [] }]) expect(choicesFrom(stored)).toEqual(NO_CHOICES)
    // Only yes/no entries count; an id this version doesn't know is kept for the version that does.
    expect(choicesFrom({ base: 'off', set: { 'bg.ciWatch': true, 'notify.ciOs': 1, 'safety.future': false } })).toEqual({
      base: 'off',
      set: { 'bg.ciWatch': true, 'safety.future': false },
    })
    for (const d of PERMISSIONS) expect(isAllowed(NO_CHOICES, d.id)).toBe(d.isOnByDefault)
  })

  test('a switch set by hand wins; Deny all turns the rest of the ordinary ones off, never Safety', async () => {
    const denied = { base: 'off' as const, set: { 'bg.ciWatch': true } }
    expect(isAllowed(denied, 'bg.ciWatch')).toBe(true)
    expect(isAllowed(denied, 'notify.ciToast')).toBe(false)
    for (const id of SAFETY) expect(isAllowed(denied, id)).toBe(true)
    expect(isAllowed({ base: 'defaults', set: { 'safety.envBand': false } }, 'safety.envBand')).toBe(false)
  })

  test('Deny all and Approve all change only this version\'s ordinary switches', async () => {
    const before = { base: 'defaults' as const, set: { 'notify.ciToast': false, 'safety.envBand': false, 'safety.future': true, 'some.unknown': false } }
    const kept = { 'safety.envBand': false, 'safety.future': true, 'some.unknown': false }
    const denied = allSet(before, false)
    expect(denied).toEqual({ base: 'off', set: kept })
    expect(isPassive(denied)).toBe(true)
    expect(isAllowed(denied, 'safety.envBand')).toBe(false)
    expect(isAllowed(denied, 'safety.prodStatus')).toBe(true)

    const approved = allSet(denied, true)
    expect(approved.base).toBe('defaults')
    expect(Object.keys(approved.set).sort()).toEqual([...Object.keys(kept), ...ORDINARY].sort())
    for (const id of ORDINARY) expect(isAllowed(approved, id)).toBe(true)
    expect(isAllowed(approved, 'safety.envBand')).toBe(false)
    expect(isPassive(approved)).toBe(false)
  })

  test('a toggle flips one switch from what it reads now', async () => {
    const off = toggled(NO_CHOICES, 'notify.ciOs')
    expect(isAllowed(off, 'notify.ciOs')).toBe(false)
    expect(isAllowed(off, 'notify.ciToast')).toBe(true)
    expect(isAllowed(toggled(off, 'notify.ciOs'), 'notify.ciOs')).toBe(true)
    // Under Deny all, a toggle turns one back on.
    expect(isAllowed(toggled(allSet(NO_CHOICES, false), 'bg.ciWatch'), 'bg.ciWatch')).toBe(true)
  })

  test("the explain prompt names every permission with its group and whether it's on", async () => {
    const choices = toggled(NO_CHOICES, 'claude.turnNotes')
    const prompt = explainPrompt(choices)
    expect(prompt).toContain('no tools are needed')
    for (const d of PERMISSIONS) {
      const group = PERMISSION_GROUPS.find(g => g.id === d.group)!.label
      expect(prompt).toContain(`- ${isAllowed(choices, d.id as PermissionId) ? 'On' : 'Off'} · ${group} · ${d.label}: ${d.description}`)
    }
    expect(prompt).toContain('- Off · Told to Claude · Turn check notes')
  })

  test('ids are unique, dotted, and every group has a label and at least one permission', async () => {
    const ids = PERMISSIONS.map(d => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z]+\.[A-Za-z]+$/)
    for (const g of PERMISSION_GROUPS) {
      expect(g.label).not.toBe('')
      expect(PERMISSIONS.some(d => d.group === g.id)).toBe(true)
    }
  })
})
