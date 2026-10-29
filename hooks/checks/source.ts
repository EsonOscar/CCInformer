// JavaScript and TypeScript source as the regex checks read it, closer to what ESLint's selectors see: comments and
// regex literals left out, and a match in a template string placed on the line ESLint reports it on.

// The files read as JS or TS source; any other file is matched line by line as it is.
export const isScript = (file: string): boolean => /\.[mc]?[jt]sx?$/.test(file)

// The last code character before a `/` that makes it start a regex rather than divide. `<` and `>` are left out, so a
// JSX closing tag (`</div>`) or an arrow's `>` never opens one.
const BEFORE_REGEX = '(,=:[!&|?{};+-*%~^'

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex'

// `code` is the text with every comment and regex literal blanked to spaces (newlines kept, so lines and columns stay);
// `lineOf[i]` is the 1-based line a match starting at `i` is reported on: its own line, except inside a template
// string, where ESLint reports the line that part of the string starts on (its backtick, or the `}` closing a `${...}`
// before it). Quotes and regexes end at a line's end, so a stray apostrophe in JSX text confuses only its own line.
export const scriptSource = (text: string): { code: string; lineOf: number[] } => {
  const out = text.split('')
  const lineOf: number[] = new Array(text.length)
  // Each open `${...}`: how deep its braces are, so its own `}` leads back into the template string.
  const templates: number[] = []
  let mode: Mode = 'code'
  let line = 1
  let quasiLine = 1
  let prev = ''
  let isInClass = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    lineOf[i] = mode === 'template' ? quasiLine : line
    if (c === '\n') {
      line += 1
      if (mode !== 'block' && mode !== 'template') mode = 'code'
      continue
    }
    if (mode === 'line') out[i] = ' '
    else if (mode === 'block') {
      out[i] = ' '
      if (c === '*' && next === '/') {
        out[i + 1] = ' '
        lineOf[i + 1] = line
        i += 1
        mode = 'code'
      }
    } else if (mode === 'single' || mode === 'double') {
      if (c === '\\') lineOf[++i] = line
      else if (c === (mode === 'single' ? "'" : '"')) mode = 'code'
    } else if (mode === 'regex') {
      // A regex literal's body is blanked too: ESLint's selectors look at strings and elements, never inside one.
      out[i] = ' '
      if (c === '\\') {
        out[i + 1] = ' '
        lineOf[++i] = line
      } else if (c === '[') isInClass = true
      else if (c === ']') isInClass = false
      else if (c === '/' && !isInClass) mode = 'code'
    } else if (mode === 'template') {
      if (c === '\\') lineOf[++i] = quasiLine
      else if (c === '`') mode = 'code'
      else if (c === '$' && next === '{') {
        lineOf[++i] = quasiLine
        templates.push(0)
        mode = 'code'
        prev = '{'
      }
    } else {
      if (c === '/' && next === '/') {
        out[i] = ' '
        mode = 'line'
      } else if (c === '/' && next === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        lineOf[++i] = line
        mode = 'block'
      } else if (c === "'") mode = 'single'
      else if (c === '"') mode = 'double'
      else if (c === '`') {
        mode = 'template'
        quasiLine = line
      } else if (c === '/' && (prev === '' || BEFORE_REGEX.includes(prev))) {
        mode = 'regex'
        isInClass = false
      } else if (c === '{' && templates.length) templates[templates.length - 1]! += 1
      else if (c === '}' && templates.length) {
        if (templates[templates.length - 1] === 0) {
          templates.pop()
          mode = 'template'
          quasiLine = line
        } else templates[templates.length - 1]! -= 1
      }
      if (!/\s/.test(c)) prev = c
    }
  }
  return { code: out.join(''), lineOf }
}
