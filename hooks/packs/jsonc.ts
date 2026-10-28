// JSON with comments and trailing commas, as pack and config files are written. The mod has no parser for it, so
// the comments and trailing commas are blanked out (strings left alone) and the rest goes to JSON.parse.
export type Parsed = { value: unknown; error?: undefined } | { value?: undefined; error: string }

export const parseJsonc = (text: string): Parsed => {
  try {
    return { value: JSON.parse(stripTrailingCommas(stripComments(text))) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// Comments become spaces of the same length, so JSON.parse's positions still point at the right place.
const stripComments = (text: string): string => {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i += 1
    }
  }
  return out
}

// Where the string starting at `start` (its opening quote) ends, past its closing quote.
const stringEnd = (text: string, start: number): number => {
  let i = start + 1
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
  return Math.min(i + 1, text.length)
}

// A comma followed only by whitespace before a closing bracket or brace; strings are skipped.
const stripTrailingCommas = (text: string): string => {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j += 1
      if (text[j] === '}' || text[j] === ']') {
        out += ' '
        i += 1
        continue
      }
    }
    out += c
    i += 1
  }
  return out
}
