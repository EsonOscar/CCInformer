import { describe, expect, test } from 'claude-code/testing'

import { connectionFindings, nodePathFindings, nodePathsIn, parseScene, removedNames, resToRepo, scriptInfo } from '../hooks/checks/tscn'
import type { ScriptInfo } from '../hooks/checks/tscn'
import type { CheckSpec } from '../hooks/packs/types'

// An invented lobby, written from Godot 4's documented scene format: a root with a C# script, a side bar with
// a gauge and a marquee, a play button wired to the root, and an instanced pennant scene.
const LOBBY = [
  '[gd_scene load_steps=3 format=3 uid="uid://kestrel_lobby"]',
  '',
  '[ext_resource type="Script" uid="uid://kestrel_script" path="res://atrium/Lobby.cs" id="1_a"]',
  '[ext_resource type="PackedScene" path="res://atrium/pennant.tscn" id="2_b"]',
  '',
  '[node name="Lobby" type="Control"]',
  'script = ExtResource("1_a")',
  '',
  '[node name="Sidebar" type="VBoxContainer" parent="."]',
  '',
  '[node name="Gauge" type="ProgressBar" parent="Sidebar" unique_id=11]',
  'unique_name_in_owner = true',
  '',
  '[node name="Marquee" type="Label" parent="Sidebar" index="1"]',
  '',
  '[node name="PlayButton" type="Button" parent="."]',
  '',
  '[node name="Pennant" parent="." unique_id=12 instance=ExtResource("2_b")]',
  '',
  '[connection signal="pressed" from="PlayButton" to="." method="OnPlayPressed"]',
  '[connection signal="pressed" from="PlayButton" to="." method="OnLeavePressed" flags=3]',
  '[connection signal="pressed" from="PlayButton" to="Pennant" method="OnPennantPressed"]',
  '[connection signal="pressed" from="PlayButton" to="Sidebar" method="OnSidebarPressed"]',
  '[connection signal="pressed" from="PlayButton" to="." method="hide"]',
  '',
].join('\n')

const LOBBY_CS = [
  'using Godot;',
  'namespace Kestrel.Atrium;',
  '',
  'public partial class Lobby : LobbyBase, IDisposable',
  '{',
  '    [Export] public int Crest { get; set; }',
  '    public override void _Ready() { }',
  '    [Signal]',
  '    public void OnPlayPressed() => StartRound();',
  '    private async Task<bool> LoadAsync(string name) { return true; }',
  '    static T Find<T>(Node from) where T : Node => null;',
  '    void StartRound()',
  '    {',
  '        if (Crest > 0) Repaint();',
  '        return;',
  '    }',
  '}',
].join('\n')

const check = (analyzer: 'tscn-connections' | 'tscn-nodepaths', cls: 'advise' | 'ci' = 'advise'): CheckSpec => ({
  id: analyzer === 'tscn-connections' ? 'scene-connections' : 'scene-nodepaths',
  label: analyzer === 'tscn-connections' ? 'Scene connections' : 'Scene node paths',
  on: ['**/*.tscn', '**/*.cs'],
  analyzer,
  cost: 'turn',
  class: cls,
})
const brief = (fs: { file: string; line?: number; rule?: string; message: string; ciWouldFail: boolean }[]) =>
  fs.map(f => `${f.file}:${f.line} ${f.rule} ${f.message}${f.ciWouldFail ? ' [ci]' : ''}`)

describe('scene files', () => {
  test('nodes get their path from the root, their script through its ext_resource, and instances are marked', async () => {
    const scene = parseScene(LOBBY)
    expect(scene.nodes.map(n => [n.path, n.line, n.script, n.isInstance])).toEqual([
      ['.', 6, 'res://atrium/Lobby.cs', false],
      ['Sidebar', 9, '', false],
      ['Sidebar/Gauge', 11, '', false],
      ['Sidebar/Marquee', 14, '', false],
      ['PlayButton', 16, '', false],
      ['Pennant', 18, '', true],
    ])
    expect(scene.connections.map(c => [c.signal, c.from, c.to, c.method, c.line])[1]).toEqual(['pressed', 'PlayButton', '.', 'OnLeavePressed', 21])
  })

  test('CRLF, attributes in any order, and Godot 3 numeric ids', async () => {
    const old = [
      '[gd_scene load_steps=2 format=2]',
      '[ext_resource path="res://atrium/Lobby.cs" type="Script" id=1]',
      '[node type="Control" name="Lobby"]',
      'script = ExtResource( 1 )',
      '[node parent="." index="0" type="Label" name="Marquee"]',
    ].join('\r\n')
    expect(parseScene(old).nodes.map(n => [n.path, n.script])).toEqual([
      ['.', 'res://atrium/Lobby.cs'],
      ['Marquee', ''],
    ])
  })

  test('a line inside a multi-line value that starts with [ is not a section', async () => {
    const scene = parseScene(['[node name="Lobby" type="Control"]', 'data = {', '[0, 1]', '}', '[node name="Gauge" type="ProgressBar" parent="."]'].join('\n'))
    expect(scene.nodes.map(n => n.path)).toEqual(['.', 'Gauge'])
  })

  test('res:// paths from the folder project.godot is in', async () => {
    expect(resToRepo('', 'res://atrium/Lobby.cs')).toBe('atrium/Lobby.cs')
    expect(resToRepo('game', 'res://atrium/Lobby.cs')).toBe('game/atrium/Lobby.cs')
  })
})

describe('C# scripts', () => {
  test('the class, its bases, and every method whatever its modifiers, attributes, generics or body form', async () => {
    const info = scriptInfo(LOBBY_CS)
    expect([info.className, info.bases]).toEqual(['Lobby', ['LobbyBase', 'IDisposable']])
    expect([...info.methods].sort()).toEqual(['Find', 'LoadAsync', 'OnPlayPressed', 'StartRound', '_Ready'])
  })

  test('node paths: GetNode and its kin, NodePath and %Name literals; interpolated strings and {…} skipped, :property cut', async () => {
    expect(nodePathsIn('var g = GetNode<ProgressBar>("Sidebar/Gauge");')).toEqual(['Sidebar/Gauge'])
    expect(nodePathsIn('GetNodeOrNull("Sidebar/Marquee:modulate")')).toEqual(['Sidebar/Marquee'])
    expect(nodePathsIn('if (HasNode("../Sidebar")) FindChild("Marquee");')).toEqual(['../Sidebar', 'Marquee'])
    expect(nodePathsIn('var p = new NodePath("Sidebar");')).toEqual(['Sidebar'])
    expect(nodePathsIn('GetNode<ProgressBar>("%Gauge")')).toEqual(['%Gauge'])
    expect(nodePathsIn('const string Name = "%Gauge";')).toEqual(['%Gauge'])
    expect(nodePathsIn('GetNode($"Sidebar/{name}"); GetNode($"Sidebar"); GetNode("Row{i}");')).toEqual([])
    expect(nodePathsIn('GD.Print($"{Crest} crests");')).toEqual([])
  })
})

describe('tscn-connections', () => {
  const lobbyInfo = scriptInfo(LOBBY_CS)
  const scriptOf = (res: string) => (res === 'res://atrium/Lobby.cs' ? { path: 'atrium/Lobby.cs', info: lobbyInfo } : null)

  test("a connection whose method the target's script doesn't declare is flagged at its line", async () => {
    const found = connectionFindings(check('tscn-connections'), 'atrium/lobby.tscn', parseScene(LOBBY), scriptOf, info => info.methods)
    expect(brief(found)).toEqual(['atrium/lobby.tscn:21 missing-method connection "pressed" from PlayButton calls OnLeavePressed, which atrium/Lobby.cs doesn\'t declare'])
    expect(found[0]!.severity).toBe('error')
    expect(brief(connectionFindings(check('tscn-connections', 'ci'), 'atrium/lobby.tscn', parseScene(LOBBY), scriptOf, info => info.methods))[0]).toContain('[ci]')
  })

  test('skipped: an instanced target, a node with no script, an engine method, a script it cannot read, a class chain it cannot follow', async () => {
    // OnPennantPressed (instance), OnSidebarPressed (no script) and hide (an engine name) are never flagged above.
    const noScript = connectionFindings(check('tscn-connections'), 'atrium/lobby.tscn', parseScene(LOBBY), () => null, info => info.methods)
    const unresolved = connectionFindings(check('tscn-connections'), 'atrium/lobby.tscn', parseScene(LOBBY), scriptOf, () => null)
    expect([noScript, unresolved]).toEqual([[], []])
  })

  test('a method its base class declares counts', async () => {
    const withBase = (info: ScriptInfo) => new Set([...info.methods, 'OnLeavePressed'])
    expect(connectionFindings(check('tscn-connections'), 'atrium/lobby.tscn', parseScene(LOBBY), scriptOf, withBase)).toEqual([])
  })
})

describe('tscn-nodepaths', () => {
  const now = parseScene(LOBBY.replace('[node name="Gauge" type="ProgressBar" parent="Sidebar" unique_id=11]\nunique_name_in_owner = true\n', ''))

  test('the names a scene had at HEAD and lost', async () => {
    expect(removedNames(parseScene(LOBBY), now)).toEqual(['Gauge'])
    expect(removedNames(parseScene(LOBBY), parseScene(LOBBY))).toEqual([])
  })

  test('each C# path naming a removed node is flagged at its line, a %Name with its own message, each once', async () => {
    const removed = new Map([['Gauge', 'atrium/lobby.tscn']])
    const hits = [
      { file: 'atrium/Lobby.cs', line: 12, text: '        var g = GetNode<ProgressBar>("Sidebar/Gauge");' },
      { file: 'atrium/Lobby.cs', line: 13, text: '        GetNode<ProgressBar>("%Gauge").Value = 1; GetNode("%Gauge");' },
      { file: 'atrium/Lobby.cs', line: 14, text: '        GD.Print("Gauge");' },
      { file: 'atrium/Lobby.cs', line: 15, text: '        GetNode("Sidebar/Marquee");' },
    ]
    expect(brief(nodePathFindings(check('tscn-nodepaths'), removed, hits))).toEqual([
      'atrium/Lobby.cs:12 removed-node GetNode path "Sidebar/Gauge" names Gauge, a node removed from atrium/lobby.tscn',
      'atrium/Lobby.cs:13 removed-node "%Gauge" names Gauge, a node removed from atrium/lobby.tscn',
    ])
  })

  test('a node named like its type or its script file is still a name', async () => {
    const head = parseScene(['[node name="Lobby" type="Control"]', '[node name="Label" type="Label" parent="."]', '[node name="Marquee" type="Label" parent="."]'].join('\n'))
    const gone = parseScene('[node name="Lobby" type="Control"]')
    expect(removedNames(head, gone)).toEqual(['Label', 'Marquee'])
    const hits = [{ file: 'atrium/Marquee.cs', line: 3, text: 'GetNode<Label>("Label"); GetNode("../Marquee");' }]
    const removed = new Map([['Label', 'atrium/lobby.tscn'], ['Marquee', 'atrium/lobby.tscn']])
    expect(nodePathFindings(check('tscn-nodepaths'), removed, hits).map(f => f.message.split(' names ')[1]!.split(',')[0])).toEqual(['Label', 'Marquee'])
  })
})
