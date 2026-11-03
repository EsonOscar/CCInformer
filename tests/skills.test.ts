import { expect, test } from 'claude-code/testing'

import { DEFAULT_SKILLS, skillsFrom, skillsText } from '../hooks/core/skills'

test('the skills file: planFiles false is off, anything else is on', () => {
  expect(skillsFrom('{ "planFiles": false }')).toEqual({ planFiles: false })
  expect(skillsFrom('{ "planFiles": true }')).toEqual({ planFiles: true })
  expect(skillsFrom('{}')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('not json')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('[false]')).toEqual(DEFAULT_SKILLS)
  expect(skillsFrom('{ "planFiles": "false" }')).toEqual(DEFAULT_SKILLS)
})

test('what the switch writes reads back the same, and is plain JSON for the skills', () => {
  expect(skillsFrom(skillsText({ planFiles: false }))).toEqual({ planFiles: false })
  expect(skillsFrom(skillsText({ planFiles: true }))).toEqual({ planFiles: true })
  expect(skillsText({ planFiles: false })).toBe('{\n  "planFiles": false\n}\n')
})
