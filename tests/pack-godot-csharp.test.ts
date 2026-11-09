import { describe, expect, test } from 'claude-code/testing'

import { isRewriteOnly } from '../hooks/git/noise'
import { BUILTINS } from '../hooks/packs/builtins'
import { detect } from '../hooks/packs/detect'
import { GODOT_CSHARP } from '../hooks/packs/godot-csharp'
import { NODE_VITE } from '../hooks/packs/node-vite'
import { resolvePack } from '../hooks/packs/resolve'
import type { PackInput } from '../hooks/packs/resolve'
import { checkPack } from '../hooks/packs/validate'

// An invented game, Lantern: a Godot 4 project with C# scripts, and the same project before it had any.
const CSHARP_PROJECT = '[application]\nconfig/name="Lantern"\nconfig/features=PackedStringArray("4.4", "C#", "Forward Plus")\n\n[dotnet]\n\nproject/assembly_name="Lantern"\n'
const GDSCRIPT_PROJECT = '[application]\nconfig/name="Lantern"\nconfig/features=PackedStringArray("4.4", "Forward Plus")\n'

const input = (markers: Record<string, string | null>): PackInput => ({
  root: '/work/lantern',
  remote: 'git@github.com:Lantern/Lantern.git',
  repoKey: 'work-lantern-git',
  markers,
  userPacks: [],
  storedTrust: null,
  now: 1000,
})

// The process a command line counts as: the first pattern that matches, as Now › Env and the band read it.
const processOf = (line: string): string => GODOT_CSHARP.processes?.find(p => new RegExp(p.match).test(line))?.id ?? ''

describe('godot-csharp', () => {
  test('is a valid built-in', async () => {
    expect(checkPack(GODOT_CSHARP, 'built-in').reasons).toEqual([])
  })

  test('is detected from a project.godot with a [dotnet] section; a GDScript-only project and a plain repo detect nothing', async () => {
    expect(detect(BUILTINS, { 'project.godot': CSHARP_PROJECT })?.id).toBe('godot-csharp')
    expect(detect(BUILTINS, { 'project.godot': GDSCRIPT_PROJECT })).toBeNull()
    expect(detect(BUILTINS, { 'README.md': '# Lantern\n', '.gitignore': '.godot/\n' })).toBeNull()
  })

  test("node-vite's markers still pick node-vite", async () => {
    expect(detect(BUILTINS, { 'package.json': JSON.stringify({ devDependencies: { vite: '^5.0.0' } }) })).toBe(NODE_VITE)
  })

  test('resolvePack reads it as detected', async () => {
    const resolved = resolvePack(input({ 'project.godot': CSHARP_PROJECT, 'package.json': null }))
    expect(resolved.report.layers.find(l => l.layer === 'built-in')).toMatchObject({ source: 'godot-csharp', state: 'loaded', note: 'detected' })
    expect(resolved.pack.id).toBe('godot-csharp')
  })

  test('tells the editor, an export and the game apart, and leaves a file named after Godot alone', async () => {
    expect(processOf('godot -e --path .')).toBe('godot-editor')
    expect(processOf('godot --path . --editor')).toBe('godot-editor')
    expect(processOf(String.raw`C:\Tools\Godot_v4.4-stable_mono_win64.exe --path C:\games\lantern -e`)).toBe('godot-editor')
    expect(processOf('godot --headless --export-release "Windows Desktop" build/lantern.exe')).toBe('godot-export')
    expect(processOf('godot --path .')).toBe('godot-game')
    expect(processOf(String.raw`"C:\Program Files\Godot\Godot_v4.4-stable_mono_win64.exe" --path .`)).toBe('godot-game')
    expect(processOf('./Godot_v4.4-stable_mono_linux.x86_64 scenes/main.tscn')).toBe('godot-game')
    expect(processOf('dotnet build')).toBe('dotnet-build')
    expect(processOf('dotnet test tests/Lantern.Tests.csproj')).toBe('dotnet-test')
    expect(processOf('cat project.godot')).toBe('')
    expect(processOf('grep -r godot docs')).toBe('')
  })

  test("folds the editor's rewrites of a scene, but not a node's real type change", async () => {
    const normalize = GODOT_CSHARP.noise?.find(n => n.id === 'godot-scenes')?.normalize ?? []
    const instanceTypeDropped = [
      '-[node name="Door" type="Node3D" parent="." unique_id=982 instance=ExtResource("2_door")]',
      '+[node name="Door" parent="." unique_id=982 instance=ExtResource("2_door")]',
    ]
    const renumbered = ['-[gd_scene load_steps=4 format=3]', '+[gd_scene load_steps=5 format=3 uid="uid://lantern_a"]']
    expect(isRewriteOnly([instanceTypeDropped, renumbered], normalize)).toBe(true)
    const retyped = ['-[node name="Gauge" type="Label" parent="."]', '+[node name="Gauge" type="Button" parent="."]']
    expect(isRewriteOnly([retyped], normalize)).toBe(false)
  })
})
