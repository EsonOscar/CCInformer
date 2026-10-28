import type { EngineInterface } from 'claude-code'

import type { EnvRule, ProcessMatcher, ResolvedPack } from '../packs/types'
import { classify, commandDir, envFilesFor, expandCommand } from './classify'

async function readText($: EngineInterface, path: string): Promise<string | null> {
  const text = await $.fs.read(path).catch(() => null)
  return typeof text === 'string' ? text : null
}

// The scripts of the package.json in a folder, or none.
async function readScripts($: EngineInterface, dir: string): Promise<Record<string, string>> {
  const text = await readText($, dir + '/package.json')
  try {
    const scripts = (JSON.parse(text ?? '{}') as { scripts?: unknown }).scripts
    return typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// What a Bash command runs and which environment it targets: its package scripts expanded through the
// package.json of the folder it runs in, and the env files its process reads. Only a label leaves here: the
// command line and the env files' values don't.
export async function classifyCommand(
  $: EngineInterface,
  cwd: string,
  command: string,
  pack: ResolvedPack,
): Promise<{ label: string; process: ProcessMatcher | null; env: EnvRule | null }> {
  const dir = commandDir(command)
  const base = !dir ? cwd : /^([a-z]:|\/)/i.test(dir) ? dir : cwd + '/' + dir
  const { text, label } = expandCommand(command, await readScripts($, base))
  const envFiles: { text: string; key?: string }[] = []
  for (const f of envFilesFor(pack, text)) {
    const body = await readText($, base + '/' + f.file)
    if (body !== null) envFiles.push({ text: body, key: f.key })
  }
  const { process, env } = classify(pack, text, envFiles)
  return { label: label || process?.label || '', process, env }
}
