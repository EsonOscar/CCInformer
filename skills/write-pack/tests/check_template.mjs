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

const text = readFileSync(join(root, 'skills/write-pack/pack-template.jsonc'), 'utf8')
const parsed = parseJsonc(text)
const problems = parsed.error !== undefined ? [parsed.error] : checkPack(parsed.value, 'user').reasons
for (const key of PACK_KEYS) if (!text.includes(`"${key}"`)) problems.push(`doesn't name "${key}"`)
if (problems.length) {
  console.error('skills/write-pack/pack-template.jsonc:\n' + problems.map(p => '  - ' + p).join('\n'))
  process.exit(1)
}
console.log('skills/write-pack/pack-template.jsonc is a valid pack naming every key')
