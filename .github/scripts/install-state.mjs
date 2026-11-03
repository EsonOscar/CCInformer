// For install.yml: fails unless the install script left the mod installed and auto-update on, then prints what a
// second run of the script must leave unchanged (the plugin's entry without its timestamps, and settings.json).
//
//   node .github/scripts/install-state.mjs <path to claude>

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const claude = process.argv[2]
const plugins = JSON.parse(execFileSync(claude, ['plugin', 'list', '--json'], { encoding: 'utf8' }))
const plugin = plugins.find(p => p.id === 'ccinformer@ccinformer')
if (!plugin) {
  console.error('ccinformer@ccinformer is not installed. claude plugin list --json:\n' + JSON.stringify(plugins, null, 2))
  process.exit(1)
}

const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
const settings = readFileSync(file, 'utf8')
if (JSON.parse(settings).extraKnownMarketplaces?.ccinformer?.autoUpdate !== true) {
  console.error('Auto-update is not on for the ccinformer marketplace. ' + file + ':\n' + settings)
  process.exit(1)
}

const { id, version, scope, enabled } = plugin
console.log(JSON.stringify({ plugin: { id, version, scope, enabled }, settings }, null, 2))
