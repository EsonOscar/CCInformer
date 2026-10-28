// An ESLint suppressions file (eslint-suppressions.json): per file, per rule, how many violations are let through.
export type Suppressions = Record<string, Record<string, { count: number }>>

// The file's text read as suppressions; anything else (missing, broken, another shape) suppresses nothing.
export const parseSuppressions = (text: string): Suppressions => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Suppressions = {}
  for (const [file, rules] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rules !== 'object' || rules === null) continue
    for (const [rule, entry] of Object.entries(rules as Record<string, unknown>)) {
      const count = (entry as { count?: unknown } | null)?.count
      if (typeof count === 'number' && count > 0) (out[file] ??= {})[rule] = { count }
    }
  }
  return out
}

// ESLint's own rule, for one file: a rule's violations are all suppressed when there are no more of them than the
// file's count, and all reported when there are more. A count above the violations, or a rule with none left, is
// unused, and ESLint fails a run with an unused suppression. `rules` limits this to the rules a check evaluated.
export const suppress = (
  forFile: Record<string, { count: number }> | undefined,
  violations: Record<string, number>,
  rules?: string[],
): { suppressed: string[]; unused: { rule: string; count: number }[] } => {
  const suppressed: string[] = []
  const unused: { rule: string; count: number }[] = []
  for (const [rule, { count }] of Object.entries(forFile ?? {})) {
    if (rules && !rules.includes(rule)) continue
    const found = violations[rule] ?? 0
    if (found > 0 && found <= count) suppressed.push(rule)
    if (found < count) unused.push({ rule, count: count - found })
  }
  return { suppressed, unused }
}
