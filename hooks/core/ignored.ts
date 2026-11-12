import type { Lane } from './lanes'

// The rule for everything the mod writes under a repo's .local/: git must ignore the folder written to.

// Whether git ignores a folder of the repo (the folder itself, so a rule for some of its files doesn't count): true,
// false, or null when git couldn't say.
export async function isIgnored(light: Lane, root: string, dir: string): Promise<boolean | null> {
  const run = await light(['git', 'check-ignore', '-q', '--', dir.replace(/\/*$/, '/')], undefined, root).catch(() => null)
  return run?.exitCode === 0 ? true : run?.exitCode === 1 ? false : null
}
