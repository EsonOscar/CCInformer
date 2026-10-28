import { describe, expect, test } from 'claude-code/testing'

import { classify, commandDir, endedTaskIds, envFilesFor, expandCommand, hostsIn } from '../hooks/env/classify'
import { mergeLayers } from '../hooks/packs/merge'
import { NODE_VITE } from '../hooks/packs/node-vite'
import type { PackManifest } from '../hooks/packs/types'
import { bandTasks } from '../hooks/view-band'
import type { EnvTask } from '../types'

// A synthetic Vite app: invented hosts and scripts, the shapes of a real one.
const SCRIPTS = {
  dev: 'vite',
  'dev:staging': 'npm run dev -- --mode staging',
  'dev:prod-data': 'vite --mode production',
  'db:check:staging': 'node tools/db-check.mjs --target staging',
  test: 'vitest run',
}

const USER: PackManifest = {
  schema: 1,
  id: 'acme-shop',
  version: '1',
  environments: [
    { id: 'staging', label: 'staging', tone: 'shared', hostPatterns: ['*.staging.example.test'] },
    { id: 'prod', label: 'production', tone: 'prod', hostPatterns: ['api.example.test'] },
    { id: 'staging-db', label: 'staging', tone: 'shared', argRegex: '--target staging' },
  ],
}
const PACK = mergeLayers([
  { layer: 'built-in', pack: NODE_VITE },
  { layer: 'user', pack: USER },
]).pack

const ENV_FILES: Record<string, string> = {
  '.env.staging': '# staging\nVITE_API_URL="https://api.staging.example.test/v1"\nVITE_FLAG=true\n',
  '.env.production': 'VITE_API_URL=https://api.example.test\n',
}

// What the loader does for a line, with the files above in place of the disk.
const run = (command: string) => {
  const { text, label } = expandCommand(command, SCRIPTS)
  const files = envFilesFor(PACK, text).flatMap(f => (ENV_FILES[f.file] ? [{ text: ENV_FILES[f.file]!, key: f.key }] : []))
  const { process, env } = classify(PACK, text, files)
  return { label, process: process?.id ?? null, env: env?.id ?? null, tone: env?.tone ?? null }
}

describe('what a command runs and where it points', () => {
  test('npm run dev:staging, through its scripts and .env.staging, is the dev server on staging', async () => {
    expect(run('npm run dev:staging')).toEqual({ label: 'npm run dev:staging', process: 'vite-dev', env: 'staging', tone: 'shared' })
  })

  test('a script expands through the scripts it runs, with the arguments after --', async () => {
    expect(expandCommand('npm run dev:staging', SCRIPTS).text.split('\n')).toEqual(['npm run dev:staging', 'npm run dev -- --mode staging', 'vite --mode staging'])
  })

  test('production data is the strictest tone, and a plain dev server points nowhere', async () => {
    expect(run('npm run dev:prod-data')).toMatchObject({ process: 'vite-dev', env: 'prod', tone: 'prod' })
    expect(run('npm run dev')).toEqual({ label: 'npm run dev', process: 'vite-dev', env: null, tone: null })
  })

  test('when the line says staging and an env file says production, production wins', async () => {
    const { env } = classify(PACK, 'node tools/db-check.mjs --target staging', [{ text: 'DB_URL=https://api.example.test\n' }])
    expect(env?.id).toBe('prod')
  })

  test("an environment's argRegex places a script that reads no env file", async () => {
    expect(run('npm run db:check:staging')).toMatchObject({ label: 'npm run db:check:staging', process: null, env: 'staging-db', tone: 'shared' })
  })

  test('the label is the script, never the line: assignments, paths and arguments stay out', async () => {
    expect(run('API_TOKEN=s3cret npm run dev:staging').label).toBe('npm run dev:staging')
    expect(run('cd web && npm run dev:staging')).toMatchObject({ label: 'npm run dev:staging', env: 'staging' })
    expect(commandDir('cd "my app" && npm run dev')).toBe('my app')
    expect(commandDir('npm run dev')).toBe('')
  })

  test('npm runs start and test without run; anything else needs it, and pnpm takes the bare name', async () => {
    expect(run('npm test')).toMatchObject({ label: 'npm test', process: 'vitest' })
    expect(run('npm install')).toEqual({ label: '', process: null, env: null, tone: null })
    expect(expandCommand('pnpm dev:staging', SCRIPTS).label).toBe('pnpm dev:staging')
    expect(expandCommand('yarn run dev', SCRIPTS).label).toBe('yarn run dev')
  })

  test('hosts come from URLs and bare host names, the named key only when one is named', async () => {
    const env = '# a comment\nA_URL=https://db.staging.example.test:5432/app\nB_HOST=cache.example.test\nexport C_URL="postgres://u:p@prod-db.example.test/x"\nD=true\n'
    expect(hostsIn(env)).toEqual(['db.staging.example.test', 'cache.example.test', 'prod-db.example.test'])
    expect(hostsIn(env, 'B_HOST')).toEqual(['cache.example.test'])
  })
})

describe('when a task ends, and what the band shows', () => {
  test('a task notification names the tasks that ended; a block with no status is no end', async () => {
    const text = [
      '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>',
      '<task-notification><task-id>bg-2</task-id><status>killed</status></task-notification>',
      '<task-notification><task-id>mon-3</task-id><event>line</event></task-notification>',
    ].join('\n')
    expect(endedTaskIds(text)).toEqual(['bg-1', 'bg-2'])
  })

  test('the band leaves local tasks out and puts production first, then the newest', async () => {
    const task = (id: string, tone: EnvTask['tone'], startedAt: number): EnvTask => ({
      id, toolUseId: id, label: id, envId: tone, envLabel: tone, tone, isHeavy: false, startedAt,
    })
    expect(bandTasks([task('a', 'shared', 1), task('b', 'local', 5), task('c', 'prod', 2), task('d', 'shared', 3)]).map(t => t.id)).toEqual(['c', 'd', 'a'])
  })
})
