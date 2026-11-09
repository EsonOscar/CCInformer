import { describe, expect, test } from 'claude-code/testing'

import {
  AUTOLOAD_LINE, CAPTURE_DEADLINE_MS, PLACEHOLDER, REQUEST_MAX_AGE_MS, SHOT_POLL_MS, SHOT_WAIT_MS, STALE_MS,
  hasGame, mention, parseTelemetry, requestText, sameScript, shotOutcome, telemetrySpread, telemetryStatus, withAutoload,
} from '../hooks/env/telemetry'
import { GODOT_CSHARP } from '../hooks/packs/godot-csharp'
import { NODE_VITE } from '../hooks/packs/node-vite'
import type { ResolvedPack } from '../hooks/packs/types'

const NOW = 1_800_000_000_000
const sample = (t: number, fps = 60, slowestFrameMs = 16.7) => ({ t, fps, slowestFrameMs, slowestPhysicsMs: 2.1, drawCalls: 412, objects: 1203, memMb: 230 })
const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, startedAt: NOW - 60_000, errorSource: 'logger', errorCount: 0, samples: [sample(NOW - 500)], errors: [], screenshot: null, ...over })
const read = (raw: string | null, previous = null as ReturnType<typeof parseTelemetry>, now = NOW) => parseTelemetry(raw, NOW - 500, previous, now)
const pack = (manifest: typeof GODOT_CSHARP): ResolvedPack => ({
  id: manifest.id, processes: manifest.processes ?? [], environments: [], checks: [], budgets: [], noise: [],
})

// A project.godot as Godot writes it: a header, then sections in name order, a blank line between them.
const PROJECT = ['; Engine configuration file.', '', 'config_version=5', '', '[application]', '', 'config/name="Lantern"', '', '[display]', '', 'window/size/viewport_width=1280', ''].join('\n')

describe('telemetry contract', () => {
  test('a screenshot that takes the whole capture deadline still lands inside the wait', async () => {
    expect(REQUEST_MAX_AGE_MS + CAPTURE_DEADLINE_MS + 2 * SHOT_POLL_MS).toBeLessThan(SHOT_WAIT_MS)
  })

  test('applies to a pack that knows a game process', async () => {
    expect(hasGame(pack(GODOT_CSHARP))).toBe(true)
    expect(hasGame(pack(NODE_VITE))).toBe(false)
    expect(hasGame(null)).toBe(false)
  })

  test('each status: absent, waiting, live, stale and broken', async () => {
    expect(telemetryStatus(null, NOW)).toBe('absent')
    expect(telemetryStatus(read(PLACEHOLDER), NOW)).toBe('waiting')
    expect(telemetryStatus(read(file()), NOW)).toBe('live')
    expect(telemetryStatus(read(file()), NOW + STALE_MS)).toBe('stale')
    const broken = read(file({ schema: 2 }))
    expect(telemetryStatus(broken, NOW)).toBe('broken')
    expect(broken?.note).toBe('telemetry.json is schema 2; this CCInformer reads 1. Run /ccinformer pack install-telemetry again.')
  })

  test('numbers that are not finite become 0; samples and errors are capped; spread over the samples', async () => {
    const samples = Array.from({ length: 130 }, (_, i) => sample(NOW - 130_000 + i * 1000, 50 + (i % 10), 10 + (i % 7)))
    samples[129] = { ...sample(NOW - 500), fps: 'fast' as unknown as number }
    const errors = Array.from({ length: 25 }, (_, i) => ({ t: NOW - i, kind: i ? 'error' : 'odd', msg: 'x'.repeat(400) }))
    const r = read(file({ samples, errors }))!
    expect(r.samples).toHaveLength(120)
    expect(r.samples[119]!.fps).toBe(0)
    expect(r.errors).toHaveLength(20)
    expect(r.errors[0]!.msg).toHaveLength(300)
    expect(read(file({ errors: [{ t: 1, kind: 'odd', msg: 'm' }] }))!.errors[0]!.kind).toBe('error')
    expect(telemetrySpread(read(file({ samples: [sample(1, 58, 12), sample(2, 61, 31.2)] }))!)).toEqual({ fpsMin: 58, slowestFrameMsMax: 31.2 })
  })

  test('bad JSON or a missing file just after a good read keeps the previous reading', async () => {
    const good = read(file())
    expect(read('{"schema":1,"samp', good)).toBe(good)
    expect(read(null, good, NOW)).toBe(good)
    expect(read(null, good, NOW + STALE_MS)).toBeNull()
    expect(read(null)).toBeNull()
    expect(read('{"schema":1,"samp')?.note).toBe("telemetry.json isn't valid JSON yet.")
  })

  test('the screenshot answer: pending, a file, or why there is none', async () => {
    const id = '1800000000123'
    expect(shotOutcome(read(file()), id)).toEqual({ state: 'pending' })
    expect(shotOutcome(read(file({ screenshot: { id: '1800000000000', file: 'shot-1800000000000.png', t: NOW } })), id)).toEqual({ state: 'pending' })
    expect(shotOutcome(read(file({ screenshot: { id, file: `shot-${id}.png`, t: NOW, width: 1280, height: 720 } })), id)).toEqual({ state: 'ok', file: `shot-${id}.png` })
    expect(shotOutcome(read(file({ screenshot: { id, file: '', t: NOW, error: 'window not drawn' } })), id)).toEqual({ state: 'error', error: 'window not drawn' })
    expect(shotOutcome(read(file({ screenshot: { id, file: '../x.png', t: NOW } })), id)).toEqual({ state: 'error', error: 'save failed' })
    expect(JSON.parse(requestText(id))).toEqual({ id, kind: 'screenshot' })
  })
})

describe('withAutoload', () => {
  test('adds [autoload] where Godot keeps it, between [application] and [display]', async () => {
    const { text, isChanged } = withAutoload(PROJECT, AUTOLOAD_LINE)
    expect(isChanged).toBe(true)
    expect(text).toBe(PROJECT.replace('[display]', `[autoload]\n\n${AUTOLOAD_LINE}\n\n[display]`))
  })

  test('adds it at the end when no section sorts after it, keeping the last newline', async () => {
    const project = ['config_version=5', '', '[application]', '', 'config/name="Lantern"', ''].join('\n')
    expect(withAutoload(project, AUTOLOAD_LINE).text).toBe(`${project.trimEnd()}\n\n[autoload]\n\n${AUTOLOAD_LINE}\n`)
  })

  test('adds the line to an existing section, replaces one of the same name, and leaves an equal one', async () => {
    const withOther = PROJECT.replace('[display]', '[autoload]\n\nMusic="*res://audio/music.gd"\n\n[display]')
    const added = withAutoload(withOther, AUTOLOAD_LINE)
    expect(added.text).toContain(`Music="*res://audio/music.gd"\n${AUTOLOAD_LINE}\n\n[display]`)
    const old = withOther.replace('Music=', 'CCInformerTelemetry="res://addons/old.gd"\nMusic=')
    const replaced = withAutoload(old, AUTOLOAD_LINE)
    expect(replaced.text).toContain(`${AUTOLOAD_LINE}\nMusic=`)
    expect(replaced.text).not.toContain('addons/old.gd')
    expect(withAutoload(added.text, AUTOLOAD_LINE)).toEqual({ text: added.text, isChanged: false, refusal: '' })
  })

  test('keeps CRLF line endings', async () => {
    const crlf = PROJECT.replace(/\n/g, '\r\n')
    const { text } = withAutoload(crlf, AUTOLOAD_LINE)
    expect(text).toContain(`[autoload]\r\n\r\n${AUTOLOAD_LINE}\r\n\r\n[display]`)
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  })

  test('refuses an empty file and one without config_version=', async () => {
    for (const project of ['', '[application]\nconfig/name="Lantern"\n']) {
      const r = withAutoload(project, AUTOLOAD_LINE)
      expect(r.isChanged).toBe(false)
      expect(r.text).toBe(project)
      expect(r.refusal).toMatch(/config_version=/)
    }
  })

  test('the same script whatever its line endings', async () => {
    expect(sameScript('extends Node\r\nvar a = 1\r\n', 'extends Node\nvar a = 1\n')).toBe(true)
    expect(sameScript('extends Node\n', 'extends Node2D\n')).toBe(false)
  })
})

describe('mention', () => {
  test('relative to the session folder, in either direction, with forward slashes', async () => {
    expect(mention('/work/lantern', '/work/lantern', 'shot-1.png')).toBe('@.local/telemetry/shot-1.png')
    expect(mention('/work/lantern', '/work', 'telemetry.json')).toBe('@lantern/.local/telemetry/telemetry.json')
    expect(mention('/work/lantern', '/work/lantern/scenes/level', 'telemetry.json')).toBe('@../../.local/telemetry/telemetry.json')
  })

  test("Windows: backslashes and drive-letter case don't matter", async () => {
    expect(mention('C:/Games/Lantern', String.raw`c:\Games\Lantern`, 'telemetry.json')).toBe('@.local/telemetry/telemetry.json')
    expect(mention('C:/Games/Lantern', String.raw`C:\games\lantern\scenes`, 'telemetry.json')).toBe('@../.local/telemetry/telemetry.json')
  })

  test('the absolute path when neither folder holds the other, quoted when it has a space', async () => {
    expect(mention('C:/Users/dev/Games/Lantern', String.raw`C:\Users\DEV~1\Games\Lantern`, 'telemetry.json')).toBe('@c:/Users/dev/Games/Lantern/.local/telemetry/telemetry.json')
    expect(mention('/work/my game', '/work/my game', 'shot-1.png')).toBe('@.local/telemetry/shot-1.png')
    expect(mention('/work/my game', '/elsewhere', 'shot-1.png')).toBe('@"/work/my game/.local/telemetry/shot-1.png"')
  })
})
