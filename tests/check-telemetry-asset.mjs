// The telemetry autoload the mod copies into a person's game (hooks/packs/assets/ccinformer_telemetry.gd) can't run
// here (no Godot in CI), so its shipped text is held to the contract in hooks/env/telemetry.ts and to what it must
// never do. Runs under tsx, which loads that TypeScript; the plugin test kit runs only *.test.ts(x) files:
//   npx -y tsx@4 tests/check-telemetry-asset.mjs
// Each seeded fault below must fail the check, so a check that stops looking fails too.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contract = await import(pathToFileURL(join(root, 'hooks/env/telemetry.ts')).href)

// The script's own constants, each equal to the contract's.
const CONSTANTS = {
  DIR: JSON.stringify('res://' + contract.TELEMETRY_DIR),
  SCHEMA: String(contract.TELEMETRY_SCHEMA),
  MAX_SAMPLES: String(contract.MAX_SAMPLES),
  MAX_ERRORS: String(contract.MAX_ERRORS),
  MAX_SHOTS: String(contract.MAX_SHOTS),
  MAX_SHOT_WIDTH: String(contract.MAX_SHOT_WIDTH),
  REQUEST_MAX_AGE_MS: String(contract.REQUEST_MAX_AGE_MS),
  CAPTURE_DEADLINE_MS: String(contract.CAPTURE_DEADLINE_MS),
}
// The shot name pattern, as a GDScript string literal: the contract's, with its backslash written twice.
const SHOT_LITERAL = JSON.stringify(contract.SHOT_NAME.source.replace('\\d', '[0-9]'))
const FORBIDDEN = [
  'print(', 'prints(', 'printerr(', 'printraw(', 'print_rich(', 'print_verbose(', 'push_error(', 'push_warning(', 'assert(',
  'OS.execute', 'OS.create_process', 'OS.shell_open', 'OS.kill', 'HTTPClient', 'HTTPRequest', 'StreamPeer', 'PacketPeer',
  'WebSocket', 'TCPServer', 'UDPServer', 'ENetConnection',
]
const REQUIRED = [
  ['the export gate', 'OS.has_feature("template")'],
  ['the headless gate', '"headless"'],
  ['the project gate', 'ProjectSettings.globalize_path(DIR)'],
  ['the folder gate', 'DirAccess.dir_exists_absolute(_dir)'],
  ['the temp file', '/telemetry.json.tmp"'],
  ['the rename over the file', 'DirAccess.rename_absolute(tmp, _dir + "/telemetry.json")'],
  ['the request file', '/request.json"'],
  ['running while paused', 'PROCESS_MODE_ALWAYS'],
  ['the window check', 'DisplayServer.window_can_draw()'],
  ['the capture deadline', '_check_capture_deadline('],
  ['the shot name pattern', `const SHOT_NAME := ${SHOT_LITERAL}`],
  ['pruning by that pattern', '_shot_name.search(name) != null'],
  ['the logger only when the engine has one', 'ClassDB.class_exists("Logger")'],
]

// Every reason the text breaks the rules; [] when it keeps them.
export const check = text => {
  const reasons = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const code = lines.filter(l => !l.trimStart().startsWith('#'))
  const first = code.find(l => l.trim() !== '')
  if (first !== 'extends Node') reasons.push(`the first code line is "${first}", not "extends Node"`)
  if (code.some(l => /^\s*@tool\b/.test(l))) reasons.push('it is a @tool script')
  if (code.some(l => /^\s*class_name\b/.test(l))) reasons.push('it declares a class_name')
  const sink = text.indexOf('const SINK_SOURCE := """')
  const loggers = [...text.matchAll(/extends Logger/g)].map(m => m.index)
  if (loggers.length !== 1 || sink < 0 || loggers[0] < sink) reasons.push('"extends Logger" must appear once, inside SINK_SOURCE')
  for (const [name, value] of Object.entries(CONSTANTS)) {
    const m = new RegExp(`^const ${name} := (.+)$`, 'm').exec(text)
    if (!m) reasons.push(`no const ${name}`)
    else if (m[1].trim() !== value) reasons.push(`const ${name} is ${m[1].trim()}, the contract says ${value}`)
  }
  for (const word of FORBIDDEN) if (code.some(l => l.includes(word))) reasons.push(`it calls ${word}`)
  for (const [what, needle] of REQUIRED) if (!text.includes(needle)) reasons.push(`no ${what} (${needle})`)
  for (const l of code) for (const m of l.matchAll(/res:\/\/[^"\s]*/g)) if (!m[0].startsWith('res://' + contract.TELEMETRY_DIR)) reasons.push(`a res:// path outside the telemetry folder: ${m[0]}`)
  lines.forEach((l, i) => {
    if (/^ +\S/.test(l) || /^\t* +\t*\S/.test(l)) reasons.push(`line ${i + 1} is indented with spaces`)
  })
  return reasons
}

const path = join(root, contract.TELEMETRY_ASSET)
const text = readFileSync(path, 'utf8')
const reasons = check(text)
if (reasons.length) {
  console.error(`${contract.TELEMETRY_ASSET} breaks the telemetry contract:\n` + reasons.map(r => `  - ${r}`).join('\n'))
  process.exit(1)
}

// Seeded faults: each must be caught.
const FAULTS = [
  ['a print( line', t => t.replace('func _now() -> int:\n', 'func _now() -> int:\n\tprint("now")\n')],
  ['a changed MAX_SAMPLES', t => t.replace(`const MAX_SAMPLES := ${contract.MAX_SAMPLES}`, 'const MAX_SAMPLES := 500')],
  ['a res:// path outside the folder', t => t.replace('func _now() -> int:\n', 'func _now() -> int:\n\tvar x := "res://save.dat"\n')],
  ['a looser shot pattern', t => t.replace(`const SHOT_NAME := ${SHOT_LITERAL}`, 'const SHOT_NAME := "^shot-.*\\\\.png$"')],
  ['a space-indented line', t => t.replace('\treturn int(Time.get_unix_time_from_system() * 1000.0)', '    return int(Time.get_unix_time_from_system() * 1000.0)')],
  ['no window check', t => t.replace('DisplayServer.window_can_draw()', 'true')],
]
for (const [name, seed] of FAULTS) {
  const faulty = seed(text)
  if (faulty === text) {
    console.error(`the seeded fault "${name}" changed nothing: update the check's seeds`)
    process.exit(1)
  }
  if (!check(faulty).length) {
    console.error(`the check missed a seeded fault: ${name}`)
    process.exit(1)
  }
}
console.log(`${contract.TELEMETRY_ASSET} keeps the telemetry contract (${FAULTS.length} seeded faults caught)`)
