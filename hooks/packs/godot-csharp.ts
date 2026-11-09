import type { PackManifest } from './types'

// A Godot 4 project with C# scripts: generic defaults only. A game's own values belong in a user pack that extends it.
export const GODOT_CSHARP: PackManifest = {
  schema: 1,
  id: 'godot-csharp',
  version: '1',
  // Godot writes a [dotnet] section into project.godot once a project has C# scripts.
  detect: [{ file: 'project.godot', contains: '[dotnet]', weight: 2, required: true }],
  // The first match wins, so the editor and an export come before the game. Godot's binary is named per version and
  // platform (Godot_v4.4-stable_mono_win64.exe), so it is matched where a command starts or after a path separator.
  processes: [
    { id: 'godot-editor', label: 'Godot editor', match: '(^|[\\\\/])[Gg]odot[\\w.-]*"?\\s.*(-e|--editor)(\\s|$)', kind: 'editor', heavy: true },
    { id: 'godot-export', label: 'Godot export', match: '(^|[\\\\/])[Gg]odot[\\w.-]*"?\\s.*--export-(release|debug|pack)(\\s|$)', kind: 'build' },
    { id: 'godot-game', label: 'Godot game', match: '(^|[\\\\/])[Gg]odot[\\w.-]*"?(\\s|$)', kind: 'game', heavy: true },
    { id: 'dotnet-build', label: 'dotnet build', match: '\\bdotnet\\s+build\\b', kind: 'build' },
    { id: 'dotnet-test', label: 'dotnet test', match: '\\bdotnet\\s+test\\b', kind: 'test' },
  ],
  // Scenes against their C# scripts, compared inside the mod, so they need no repo trust.
  checks: [
    { id: 'tscn-connections', label: 'Scene connections', on: ['**/*.tscn', '**/*.cs'], analyzer: 'tscn-connections', cost: 'turn', class: 'advise' },
    { id: 'tscn-nodepaths', label: 'Scene node paths', on: ['**/*.tscn', '**/*.cs'], analyzer: 'tscn-nodepaths', cost: 'turn', class: 'advise' },
  ],
  noise: [
    { id: 'godot-cache', glob: '**/.godot/**', kind: 'generated' },
    { id: 'godot-import', glob: '**/*.import', kind: 'generated' },
    { id: 'godot-uid', glob: '**/*.uid', kind: 'generated' },
    // What the editor renumbers on save: uids, the header's load_steps, node ids, and the type it drops from an
    // instanced node's header.
    {
      id: 'godot-scenes',
      glob: '**/*.{tscn,tres}',
      kind: 'editor-rewrite',
      normalize: ['uid="[^"]*"', 'load_steps=\\d+', 'unique_id=\\d+', 'type="[^"]*"(?=.*instance=)'],
    },
  ],
}
