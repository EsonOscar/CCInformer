// The write-pack skill reads pack-template.jsonc for every setting and what it does, so it must stay a valid user
// pack that names every key the schema has. The mod's own validator decides, so this runs under tsx, which loads its
// TypeScript (the plugin test kit loads only code files, not the JSONC):
//   npx -y tsx@4 skills/write-pack/tests/check_template.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const load = path => import(pathToFileURL(join(root, path)).href)
const { parseJsonc } = await load('hooks/packs/jsonc.ts')
const { checkPack } = await load('hooks/packs/validate.ts')
const { PACK_KEYS } = await load('hooks/packs/types.ts')
const { gateCall, ruleMatches } = await load('hooks/gates/match.ts')

// A call each approval example must name, so the template's examples read the call the way the gates do.
const SAMPLES = {
  migrate: ['Bash', { command: 'npm run build && npm run db:migrate:staging' }],
  'db-check': ['PowerShell', { command: 'npm run db:check:staging' }],
  sql: ['mcp__acmedb__execute_sql', { project_id: '<staging-ref>', query: 'select 1' }],
  'migration-files': ['Edit', { file_path: '/repo/db/migrations/001.sql' }],
}

const text = readFileSync(join(root, 'skills/write-pack/pack-template.jsonc'), 'utf8')
const parsed = parseJsonc(text)
const problems = parsed.error !== undefined ? [parsed.error] : checkPack(parsed.value, 'user').reasons
for (const key of PACK_KEYS) if (!text.includes(`"${key}"`)) problems.push(`doesn't name "${key}"`)
for (const env of parsed.value?.environments ?? [])
  for (const rule of env.approvals ?? []) {
    const sample = SAMPLES[rule.id]
    if (!sample) problems.push(`approval ${rule.id} has no sample call in check_template.mjs`)
    else if (!ruleMatches(rule, gateCall(sample[0], sample[1], {}, '/repo'))) problems.push(`approval ${rule.id} doesn't name its sample call (${sample[0]})`)
  }
if (problems.length) {
  console.error('skills/write-pack/pack-template.jsonc:\n' + problems.map(p => '  - ' + p).join('\n'))
  process.exit(1)
}
console.log('skills/write-pack/pack-template.jsonc is a valid pack naming every key, its approval examples naming their sample calls')
