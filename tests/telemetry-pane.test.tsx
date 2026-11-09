import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { AUTOLOAD_LINE, PLACEHOLDER, SHOT_WAIT_MS, TELEMETRY_TEXTS as T } from '../hooks/env/telemetry'

const PANE = {
  plugin: 'ccinformer',
  component: 'Pane',
  requestId: 'ccinformer',
  props: { title: 'CCInformer', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 400 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const

// An invented Godot C# game, Lantern, at /repo. Unix ms, so a screenshot id has 13 digits.
const NOW = 1_800_000_000_000
const PROJECT = ['config_version=5', '', '[application]', '', 'config/name="Lantern"', '', '[dotnet]', '', 'project/assembly_name="Lantern"', ''].join('\n')
const ASSET = 'extends Node\n# the shipped telemetry script\n'
const TELEMETRY = '/repo/.local/telemetry/telemetry.json'
const REQUEST = '/repo/.local/telemetry/request.json'
const SCRIPT = '/repo/addons/ccinformer/ccinformer_telemetry.gd'
const VITE_PKG = JSON.stringify({ name: 'shop', devDependencies: { vite: '^5.0.0' } })

// Four minutes of mocked clock take real time on a busy machine.
const CLOCK_HEAVY = { timeoutMs: 20_000 }
const posix = (path: string) => path.replace(/\\/g, '/').replace(/^[a-z]:/i, '')
const sample = (t: number) => ({ t, fps: 60, slowestFrameMs: 16.7, slowestPhysicsMs: 2.1, drawCalls: 412, objects: 1203, memMb: 230 })
const telemetry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, startedAt: NOW - 60_000, errorSource: 'logger', errorCount: 0, samples: [sample(NOW - 400)], errors: [], screenshot: null, ...over })

type Opts = { ignored?: number; answer?: string; godot?: boolean; failWrite?: string; projectOnSecondRead?: string; fillRefused?: boolean }

// The engine around the mod: files in memory with their mtimes, git answering for /repo (check-ignore with `ignored`,
// 1 by default: not ignored), AskUserQuestion answering `answer`, and every stat, read, write, command, toast and fill
// recorded.
const engine = (on: Parameters<TestBody>[1], files: Record<string, string>, opts: Opts = {}) => {
  const mtimes: Record<string, number> = Object.fromEntries(Object.keys(files).map(p => [p, NOW - 400]))
  const seen = { stats: [] as string[], reads: [] as string[], writes: [] as string[], commands: [] as string[], asked: [] as string[], toasts: [] as string[], fills: [] as { text: string; mode?: string }[] }
  const state = { ignored: opts.ignored ?? 1, answer: opts.answer ?? 'Install' }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { permissions: { base: 'defaults', set: {} } })
  mock.env(on, { HOME: '/home/test' })
  on('session.id', () => ({ value: 'self-session-id' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20, window: 100, percent: 20 }, rateLimits: [], cost: { usd: 0 } } }))
  on('agent.list', () => ({ value: [] }))
  const isDir = (path: string) => Object.keys(files).some(p => p.startsWith(path + '/'))
  on('fs.exists', (_, e) => ({ value: posix(e.path) in files || isDir(posix(e.path)) }))
  on('fs.stat', (_, e) => {
    const path = posix(e.path)
    seen.stats.push(path)
    if (path in files) return { value: { kind: 'file', size: files[path]!.length, mtimeMs: mtimes[path] ?? NOW, isLink: false } } as never
    return { value: isDir(path) ? { kind: 'dir', size: 0, mtimeMs: NOW, isLink: false } : null } as never
  })
  on('fs.read', (_, e) => {
    const path = posix(e.path)
    seen.reads.push(path)
    if (path.endsWith('hooks/packs/assets/ccinformer_telemetry.gd')) return { value: ASSET } as never
    if (path === '/repo/project.godot') {
      // The editor saving project.godot while the question is open: every read after it sees the new text.
      if (seen.asked.length && opts.projectOnSecondRead !== undefined) return { value: opts.projectOnSecondRead } as never
    }
    return { value: files[path] ?? null } as never
  })
  on('fs.write', (_, e) => {
    const path = posix(e.path)
    if (opts.failWrite === path) throw new Error('disk full')
    seen.writes.push(path)
    files[path] = e.text
    mtimes[path] = (mtimes[path] ?? NOW) + 1000
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = posix(e.path) + '/'
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file', mtimeMs: mtimes[p] ?? NOW })) } as never
  })
  on('process.run', (_, e) => {
    const line = (e as { argv: string[] }).argv.join(' ')
    seen.commands.push(line)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (line === 'git rev-parse --show-toplevel --git-common-dir') return out('/repo\n.git\n')
    if (line === 'git config --get remote.origin.url') return out('git@github.com:lantern/lantern.git\n')
    if (line.startsWith('git check-ignore')) return out('', state.ignored)
    return out('', line.startsWith('git ') ? 0 : 1)
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {}, text: 'ok' }
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    seen.asked.push(question)
    return { result: { questions: [], answers: { [question]: state.answer } }, text: state.answer } as never
  })
  on('prompt.fill', (_, e) => {
    const fill = e as unknown as { text: string; mode?: string }
    seen.fills.push({ text: fill.text, mode: fill.mode })
    return (opts.fillRefused ? { isFilled: false, refusal: 'dialog', text: '', cursor: 0 } : { isFilled: true, text: fill.text, cursor: fill.text.length }) as never
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  // The game writing its file: new text, and a newer mtime.
  const game = (text: string) => {
    files[TELEMETRY] = text
    mtimes[TELEMETRY] = (mtimes[TELEMETRY] ?? NOW) + 1000
  }
  return { clock, seen, state, files, game }
}

const godot = (extra: Record<string, string> = {}) => ({ '/repo/project.godot': PROJECT, ...extra })
const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const openEnv = async ($: Parameters<TestBody>[0], clock: { settle: () => Promise<void> }) => {
  await $.command.run({ ...TYPED, command: 'ccinformer', args: 'env' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.settle()
  return ui
}
// The install's reply, once the pane it opened has finished its refresh.
const install = async ($: Parameters<TestBody>[0], clock: { settle: () => Promise<void> }) => {
  const reply = ((await $.command.run({ ...TYPED, command: 'ccinformer', args: 'pack install-telemetry' })) as { text?: string }).text
  await clock.settle()
  return reply
}
const telemetryStats = (seen: { stats: string[] }) => seen.stats.filter(p => p === TELEMETRY).length

describe('Game telemetry in Now › Env', () => {
  test('a Godot game with a fresh file shows its numbers, and its errors newest first', async ($, on) => {
    const errors = [{ t: NOW - 3000, kind: 'error', msg: 'Node not found: "Player/Gun" (res://scenes/level.tscn:12)' }, { t: NOW - 1000, kind: 'script', msg: 'Invalid call. Nonexistent function "fire"' }]
    const { clock } = engine(on, godot({ [TELEMETRY]: telemetry({ errors, errorCount: 2 }) }))
    await start($)
    const ui = await openEnv($, clock)
    expect(await ui.find({ type: 'Text', text: /GAME TELEMETRY/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '60 fps · min 60' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'slowest frame 16.7 ms · max 16.7 · physics 2.1 ms' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '412 draw calls · 1,203 objects · 230 MB' })).toBeDefined()
    const shown = (await ui.findAll({ type: 'Text', text: /⚠/ })).map(e => e.text)
    expect(shown).toHaveLength(2)
    expect(shown[0]).toMatch(/Nonexistent function "fire"/)
    expect(shown[1]).toMatch(/Node not found/)
    await ui.unmount()
  })

  test('the file is stat-ed each second while Env shows, also after 4 minutes with no turn and no key, and read only when it changed', CLOCK_HEAVY, async ($, on) => {
    const { clock, seen, game } = engine(on, godot({ [TELEMETRY]: telemetry() }))
    await start($)
    const ui = await openEnv($, clock)
    await clock.advance(240_000)
    await clock.settle()
    const before = telemetryStats(seen)
    const reads = seen.reads.filter(p => p === TELEMETRY).length
    await clock.advance(5000)
    await clock.settle()
    expect(telemetryStats(seen) - before).toBeGreaterThanOrEqual(5)
    expect(seen.reads.filter(p => p === TELEMETRY).length).toBe(reads)
    game(telemetry({ samples: [sample(NOW + 245_000)] }))
    await clock.advance(1000)
    await clock.settle()
    expect(seen.reads.filter(p => p === TELEMETRY).length).toBe(reads + 1)
    expect(await ui.find({ type: 'Text', text: /60 fps/ })).toBeDefined()
    await ui.unmount()
  })

  test('while the game runs the processes are read every 30 s with no turn, and at once when it starts or stops', CLOCK_HEAVY, async ($, on) => {
    const { clock, seen, game } = engine(on, godot())
    const processReads = () => seen.commands.filter(c => c.startsWith('ps ') || c.includes('Win32_Process')).length
    await start($)
    const ui = await openEnv($, clock)
    // Past the active window with no game: the list isn't read.
    await clock.advance(250_000)
    await clock.settle()
    let before = processReads()
    await clock.advance(60_000)
    await clock.settle()
    expect(processReads()).toBe(before)
    // The game starts. A sample stamped ahead of the mocked clock keeps it live without a write every second.
    game(telemetry({ samples: [sample(NOW + 3_600_000)] }))
    await clock.advance(2000)
    await clock.settle()
    expect(processReads()).toBe(before + 1)
    before = processReads()
    await clock.advance(60_000)
    await clock.settle()
    expect(processReads()).toBe(before + 2)
    // The game stops: its last sample is from now, so it turns stale 5 s later and the list is read once more.
    game(telemetry({ samples: [sample(NOW + 372_000)] }))
    before = processReads()
    await clock.advance(8000)
    await clock.settle()
    expect(processReads()).toBe(before + 1)
    before = processReads()
    await clock.advance(60_000)
    await clock.settle()
    expect(processReads()).toBe(before)
    await ui.unmount()
  })

  test('nothing is stat-ed on Sessions or with the pane closed', async ($, on) => {
    const { clock, seen } = engine(on, godot({ [TELEMETRY]: telemetry() }))
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'view-sessions' })
    await clock.settle()
    const onSessions = telemetryStats(seen)
    await clock.advance(5000)
    await clock.settle()
    expect(telemetryStats(seen)).toBe(onSessions)
    await $.command.run({ ...TYPED, command: 'ccinformer', args: '' })
    await clock.advance(5000)
    await clock.settle()
    expect(telemetryStats(seen)).toBe(onSessions)
    await ui.unmount()
  })

  test('an old sample, the install placeholder, an older engine, and no file each say so', async ($, on) => {
    const { clock, game } = engine(on, godot({ [TELEMETRY]: telemetry({ samples: [sample(NOW - 60_000)] }) }))
    await start($)
    const ui = await openEnv($, clock)
    expect(await ui.find({ type: 'Text', text: /No sample for 1m00s: the game stopped, or it's paused in the debugger\./ })).toBeDefined()
    game(PLACEHOLDER)
    await clock.advance(1000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /Waiting for the game: start it from the editor or with godot --path \./ })).toBeDefined()
    game(telemetry({ samples: [sample(NOW + 1000)], errorSource: 'none' }))
    await clock.advance(1000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /Errors need Godot 4\.5 or later\./ })).toBeDefined()
    await ui.unmount()
  })

  test('a Godot game without telemetry offers the install', async ($, on) => {
    const { clock } = engine(on, godot())
    await start($)
    const ui = await openEnv($, clock)
    expect(await ui.find({ type: 'Text', text: /Not installed\. \/ccinformer pack install-telemetry adds it to this game \(it asks first\)\./ })).toBeDefined()
    await ui.unmount()
  })

  test('a repo that is no Godot game has no section and stats nothing', async ($, on) => {
    const { clock, seen } = engine(on, { '/repo/package.json': VITE_PKG })
    await start($)
    const ui = await openEnv($, clock)
    await clock.advance(3000)
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /GAME TELEMETRY/ })).toBeUndefined()
    expect(seen.stats.filter(p => p.includes('.local/telemetry'))).toEqual([])
    await ui.unmount()
  })
})

describe('/ccinformer pack install-telemetry', () => {
  test('asks, then writes the script, the placeholder and project.godot, in that order, and lands on Now › Env', async ($, on) => {
    const { clock, seen, files } = engine(on, godot(), { ignored: 0 })
    await start($)
    expect(await install($, clock)).toBe(T.installed)
    expect(seen.asked).toEqual([T.question('/repo')])
    expect(seen.writes).toEqual([SCRIPT, TELEMETRY, '/repo/project.godot'])
    expect(files[SCRIPT]).toBe(ASSET)
    expect(files[TELEMETRY]).toBe(PLACEHOLDER)
    expect(files['/repo/project.godot']).toContain(`[autoload]\n\n${AUTOLOAD_LINE}\n`)
    expect(seen.commands).toContain('git check-ignore -q -- .local/telemetry/')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /Waiting for the game/ })).toBeDefined()
    await ui.unmount()
  })

  test('a folder git does not ignore (only *.json, say), or a git that cannot say: no question and no write', async ($, on) => {
    const { clock, seen, state } = engine(on, godot(), { ignored: 1 })
    await start($)
    expect(await install($, clock)).toBe(T.notIgnored)
    state.ignored = 128
    expect(await install($, clock)).toBe(T.gitUnknown)
    expect(seen.asked).toEqual([])
    expect(seen.writes).toEqual([])
  })

  test('a project.godot that is no Godot project, or none at all: no question and no write', async ($, on) => {
    const { clock, seen, files } = engine(on, godot(), { ignored: 0 })
    files['/repo/project.godot'] = '[application]\nconfig/name="Lantern"\n'
    await start($)
    expect(await install($, clock)).toBe(T.badProject)
    delete files['/repo/project.godot']
    expect(await install($, clock)).toBe(T.noProject('/repo'))
    expect(seen.asked).toEqual([])
    expect(seen.writes).toEqual([])
  })

  test('Cancel writes nothing', async ($, on) => {
    const { clock, seen } = engine(on, godot(), { ignored: 0, answer: 'Cancel' })
    await start($)
    expect(await install($, clock)).toBe(T.declined)
    expect(seen.writes).toEqual([])
  })

  test('a project.godot the editor saved meanwhile is left alone, and the reply gives the line', async ($, on) => {
    const { clock, seen } = engine(on, godot(), { ignored: 0, projectOnSecondRead: PROJECT + 'run/main_scene="res://main.tscn"\n' })
    await start($)
    expect(await install($, clock)).toBe(T.projectChanged)
    expect(seen.writes).not.toContain('/repo/project.godot')
  })

  test('a project.godot write that fails gives the line to add', async ($, on) => {
    const { clock } = engine(on, godot(), { ignored: 0, failWrite: '/repo/project.godot' })
    await start($)
    expect(await install($, clock)).toBe(T.projectFailed)
  })

  test('an up-to-date install asks nothing; a deleted folder asks again', async ($, on) => {
    const { clock, seen, files } = engine(on, godot(), { ignored: 0 })
    await start($)
    await install($, clock)
    expect(await install($, clock)).toBe(T.upToDate)
    expect(seen.asked).toHaveLength(1)
    delete files[TELEMETRY]
    expect(await install($, clock)).toBe(T.installed)
    expect(seen.asked).toHaveLength(2)
  })
})

describe('Screenshot (c) and Add file to prompt (t)', () => {
  const answer = (id: string, shot: Record<string, unknown>) => telemetry({ samples: [sample(NOW + 1000)], screenshot: { id, t: NOW + 1000, ...shot } })
  const requestId = (files: Record<string, string>) => (JSON.parse(files[REQUEST]!) as { id: string }).id

  test('c asks the game, then offers its screenshot to the prompt', async ($, on) => {
    const { clock, seen, files, game } = engine(on, godot({ [TELEMETRY]: telemetry() }), { ignored: 0 })
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'telemetry-shot' })
    await clock.settle()
    expect(seen.commands).toContain('git check-ignore -q -- .local/telemetry/')
    const id = requestId(files)
    expect(id).toMatch(/^\d{13}$/)
    expect(await ui.find({ type: 'Text', text: /Taking a screenshot…/ })).toBeDefined()
    game(answer(id, { file: `shot-${id}.png`, width: 1280, height: 720 }))
    await clock.advance(500)
    await clock.settle()
    expect(seen.fills).toEqual([{ text: `@.local/telemetry/shot-${id}.png `, mode: 'insert' }])
    await ui.unmount()
  })

  test("the game's error is said, and nothing is offered", async ($, on) => {
    const { clock, seen, files, game } = engine(on, godot({ [TELEMETRY]: telemetry() }), { ignored: 0 })
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'telemetry-shot' })
    await clock.settle()
    game(answer(requestId(files), { file: '', error: 'window not drawn' }))
    await clock.advance(500)
    await clock.settle()
    expect(seen.toasts).toContain(T.shotFailed('window not drawn'))
    expect(seen.fills).toEqual([])
    await ui.unmount()
  })

  test('no answer in time says so; a prompt that refuses gives the path', async ($, on) => {
    const { clock, seen, files, game } = engine(on, godot({ [TELEMETRY]: telemetry() }), { ignored: 0, fillRefused: true })
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'telemetry-shot' })
    await clock.settle()
    for (let i = 0; i < SHOT_WAIT_MS / 500 + 1; i += 1) {
      game(telemetry({ samples: [sample(NOW + 1000 * (i + 1))] }))
      await clock.advance(500)
      await clock.settle()
    }
    expect(seen.toasts).toContain(T.shotTimeout)
    await ui.press({ key: 'telemetry-shot' })
    await clock.settle()
    const id = requestId(files)
    game(answer(id, { file: `shot-${id}.png` }))
    await clock.advance(500)
    await clock.settle()
    expect(seen.toasts).toContain(T.shotUnfilled(`/repo/.local/telemetry/shot-${id}.png`))
    await ui.unmount()
  })

  test('c while the game is stopped says so and writes nothing', async ($, on) => {
    const { clock, seen } = engine(on, godot({ [TELEMETRY]: telemetry({ samples: [sample(NOW - 60_000)] }) }), { ignored: 0 })
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'telemetry-shot' })
    await clock.settle()
    expect(seen.toasts).toContain(T.notRunning)
    expect(seen.writes).toEqual([])
    await ui.unmount()
  })

  test('c with the folder no longer ignored writes nothing', async ($, on) => {
    const { clock, seen } = engine(on, godot({ [TELEMETRY]: telemetry() }), { ignored: 1 })
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'telemetry-shot' })
    await clock.settle()
    expect(seen.toasts).toContain(T.shotNotIgnored)
    expect(seen.writes).toEqual([])
    await ui.unmount()
  })

  test('t offers telemetry.json to the prompt', async ($, on) => {
    const { clock, seen } = engine(on, godot({ [TELEMETRY]: telemetry() }))
    await start($)
    const ui = await openEnv($, clock)
    await ui.press({ key: 'telemetry-offer' })
    await clock.settle()
    expect(seen.fills).toEqual([{ text: '@.local/telemetry/telemetry.json ', mode: 'insert' }])
    await ui.unmount()
  })
})
