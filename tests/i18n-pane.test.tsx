import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const

const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

const PACKS = '/home/test/.claude/ccinformer/packs'
// A user pack for an invented shop: its translation tables, da, en and sv required, enforced by its CI.
const USER_PACK = `{ "schema": 1, "id": "acme-shop", "version": "1", "match": { "remote": ["github.com/acme/*"] },
  "checks": [
    { "id": "i18n", "label": "Translation keys", "on": ["src/i18n/common/*.json", "src/modules/*/i18n/*.json"],
      "analyzer": "i18n-keysets", "cost": "turn", "class": "ci", "options": { "languages": ["da", "en", "sv"] } }
  ] }`

const COMMON = '/repo/src/i18n/common'
const CART = '/repo/src/modules/cart/i18n'
const json = (entries: Record<string, string>) => '{\n' + Object.entries(entries).map(([k, v]) => `  "${k}": "${v}"`).join(',\n') + '\n}\n'
// Each language's file of a table, every one with the same keys.
const table = (dir: string, keys: string[]) =>
  Object.fromEntries(['da', 'en', 'sv'].map(l => [`${dir}/${l}.json`, json(Object.fromEntries(keys.map(k => [k, `${k} (${l})`])))]))
const REPO = {
  [PACKS + '/shop.pack.jsonc']: USER_PACK,
  ...table(COMMON, ['save', 'cancel']),
  ...table(CART, ['cart_title']),
  '/repo/src/modules/cart/index.ts': 'export {}\n',
}

const turnEnd = () => ({ answer: '', durationMs: 1, isAborted: false, turnId: 't-main', reason: 'answer' as const })
// The engine hands file hooks native paths (C:\repo\x on Windows); the files are keyed as /repo/x.
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')

// A repo at /repo with an acme remote, its files in memory, folders listed as folders. A Write changes a file there.
// `reads` holds every translation file read; `submitted` each prompt as it entered, with its context; `asked` each
// question put to the person.
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>) => {
  const mtimes: Record<string, number> = {}
  const reads: string[] = []
  const asked: string[] = []
  const submitted: { text: string; context: readonly string[] }[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  const change = (path: string, text: string) => {
    files[path] = text
    mtimes[path] = (mtimes[path] ?? 1) + 1
  }
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files }))
  on('fs.read', (_, e) => {
    const path = posix(e.path)
    if (path.endsWith('.json') && path.startsWith('/repo/src/')) reads.push(path)
    return { value: files[path] ?? null } as never
  })
  on('fs.write', (_, e) => {
    change(posix(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const path = posix(e.path)
    return { value: path in files ? { kind: 'file', size: files[path]!.length, mtimeMs: mtimes[path] ?? 1 } : null } as never
  })
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const below = Object.keys(files).filter(p => p.startsWith(dir)).map(p => p.slice(dir.length))
    const names = [...new Set(below.map(p => p.split('/')[0]!))]
    return { value: names.map(name => ({ name, kind: below.includes(name) ? 'file' : 'dir', mtimeMs: 1 })) } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:acme/shop.git\n')
    if (line.startsWith('git status')) return out('# branch.oid abc123\n# branch.head main\n')
    if (line.startsWith('git rev-parse')) return out('/repo/.git\n/repo\n')
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push((e as unknown as { questions: { question: string }[] }).questions[0]!.question)
      return { result: { questions: [], answers: {} }, text: '' } as never
    }
    if (e.tool === 'Write') {
      const write = e as unknown as { file_path: string; content: string }
      change(posix(write.file_path), write.content)
      return { result: { type: 'create', filePath: write.file_path, content: write.content, structuredPatch: [] }, text: 'written' } as never
    }
    return { result: {}, text: 'ok' }
  })
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, context: e.context } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { clock, reads, asked, submitted }
}

const start = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  const e = engine(on, { ...REPO })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await e.clock.settle()
  return e
}
const write = ($: Parameters<TestBody>[0], path: string, entries: Record<string, string>) => $.tool.call({ tool: 'Write', file_path: path, content: json(entries) })
const endTurn = async ($: Parameters<TestBody>[0], clock: { settle: () => Promise<void> }) => {
  await $.turn.complete(turnEnd())
  await clock.settle()
}
const rules = async ($: Parameters<TestBody>[0]) => {
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'rules' })
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('a key written to da, en and sv in one turn gives no finding, and nothing is told', async ($, on) => {
  const { clock, submitted, asked } = await start($, on)
  // Each write leaves the table short of a language until the last; nothing is checked before the turn ends.
  expect((await write($, CART + '/da.json', { cart_title: 'Kurv', cart_empty: 'Kurven er tom' })).context).toBeUndefined()
  await write($, CART + '/en.json', { cart_title: 'Cart', cart_empty: 'The cart is empty' })
  await write($, CART + '/sv.json', { cart_title: 'Kundvagn', cart_empty: 'Kundvagnen är tom' })
  await endTurn($, clock)

  const ui = await rules($)
  expect(await ui.find({ type: 'Text', text: /is missing|also in/ })).toBeUndefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  expect(submitted[0]!.context).toEqual([])
  // Compared inside the mod: no question about running the repo's tools.
  expect(asked).toEqual([])
})

test('a key still missing from sv when the turn ends shows in Rules, is told once with the next prompt, and clears once sv has it', async ($, on) => {
  const { clock, submitted } = await start($, on)
  await write($, CART + '/da.json', { cart_title: 'Kurv', cart_empty: 'Kurven er tom' })
  await write($, CART + '/en.json', { cart_title: 'Cart', cart_empty: 'The cart is empty' })
  await endTurn($, clock)

  const ui = await rules($)
  expect(await ui.find({ type: 'Text', text: /"cart_empty" is missing; da\.json and en\.json have it/ })).toBeDefined()
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeDefined()
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: 'and then', origin: { kind: 'composer' }, wait: false })
  expect(submitted.map(s => s.context.length)).toEqual([1, 0])
  expect(submitted[0]!.context[0]).toContain('- src/modules/cart/i18n/sv.json missing-key: "cart_empty" is missing; da.json and en.json have it [CI will fail]')

  await write($, CART + '/sv.json', { cart_title: 'Kundvagn', cart_empty: 'Kundvagnen är tom' })
  await endTurn($, clock)
  expect(await ui.find({ type: 'Text', text: /is missing/ })).toBeUndefined()
  expect(await ui.find({ key: 'area-code', text: /!/ })).toBeUndefined()
  await ui.unmount()
})

test('a key the shared table already has is a finding at its line in each language', async ($, on) => {
  const { clock } = await start($, on)
  for (const lang of ['da', 'en', 'sv']) await write($, `${CART}/${lang}.json`, { cart_title: `cart (${lang})`, save: `save (${lang})` })
  await endTurn($, clock)

  const ui = await rules($)
  const found = await ui.findAll({ type: 'Text', text: /"save" is also in src\/i18n\/common; a key lives in one table/ })
  expect(found.length).toBe(3)
  await ui.unmount()
})

test('a turn that wrote no translation file reads no table', async ($, on) => {
  const { clock, reads } = await start($, on)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/modules/cart/index.ts', content: 'export const a = 1\n' })
  await endTurn($, clock)
  expect(reads).toEqual([])
})
