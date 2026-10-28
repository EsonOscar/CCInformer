import type { PackManifest } from './types'

// A Node project built with Vite: generic defaults only. A repo's own values belong in a user pack that extends it.
export const NODE_VITE: PackManifest = {
  schema: 1,
  id: 'node-vite',
  version: '1',
  detect: [
    { file: 'package.json', contains: '"vite"', weight: 2, required: true },
    { file: 'vite.config.ts', weight: 1 },
    { file: 'vite.config.js', weight: 1 },
    { file: 'vite.config.mts', weight: 1 },
  ],
  processes: [
    { id: 'vite-dev', label: 'Vite dev server', match: '\\bvite(\\s+(dev|serve))?(\\s|$)', kind: 'dev' },
    { id: 'vite-build', label: 'Vite build', match: '\\bvite\\s+build\\b', kind: 'build' },
    { id: 'vitest', label: 'Vitest', match: '\\bvitest\\b', kind: 'test' },
    { id: 'playwright', label: 'Playwright', match: '\\bplaywright\\s+test\\b', kind: 'test', heavy: true },
    { id: 'tsc', label: 'TypeScript', match: '\\btsc\\b', kind: 'build' },
  ],
  environments: [{ id: 'local', label: 'local', tone: 'local', hostPatterns: ['localhost', '127.0.0.1', '*.localhost'] }],
  checks: [
    {
      id: 'eslint',
      label: 'ESLint',
      on: ['**/*.{ts,tsx,js,jsx}'],
      analyzer: 'eslint-json',
      cost: 'turn',
      class: 'ci',
      bin: ['node', 'node_modules/eslint/bin/eslint.js'],
    },
  ],
  noise: [
    { id: 'dist', glob: 'dist/**', kind: 'generated' },
    { id: 'coverage', glob: 'coverage/**', kind: 'generated' },
  ],
}

// Every built-in, in the order detection tries them.
export const BUILTINS: PackManifest[] = [NODE_VITE]
