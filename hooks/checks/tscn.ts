import type { Finding } from '../../types'
import type { CheckSpec } from '../packs/types'
import { finding } from './findings'

// Godot scenes against their C# scripts, for the tscn-connections and tscn-nodepaths checks: a scene's text read as
// nodes and connections, a script's text as its class and methods, a C# line's node path strings, and what they come
// to as findings. Plain logic: run.ts reads the files and git, and hands their text in.

// A node in a scene: its path from the scene root ('.' for the root itself, 'A/B' below it), the line its header is
// on, its script's res:// path ('' for none), and whether it is an instance of another scene (whose script and
// children live in that scene).
export type TscnNode = { path: string; name: string; line: number; script: string; isInstance: boolean }
// A signal connection the scene declares: from and to are node paths as written ('.' for the root).
export type Connection = { signal: string; from: string; to: string; method: string; line: number }
export type Scene = { nodes: TscnNode[]; connections: Connection[] }
// A C# script's class: its name, what it derives from or implements, and the methods it declares.
export type ScriptInfo = { className: string; bases: string[]; methods: Set<string> }
// A line git grep found: the file from the repo's top folder, its line number and its text.
export type GrepHit = { file: string; line: number; text: string }

// The sections a scene file has; a line inside a multi-line value that happens to start with `[` is none of these.
const SECTION = /^\[(gd_scene|gd_resource|ext_resource|sub_resource|node|connection|editable|resource)\b(.*)\]\s*$/
// key=value pairs in a section header: a quoted string, a call such as ExtResource("1_a"), a [list], or a bare word.
const ATTR = /(\w+)=("(?:[^"\\]|\\.)*"|\w+\([^)]*\)|\[[^\]]*\]|[^\s\]]+)/g
// The id inside ExtResource("1_a") (Godot 4) or ExtResource( 1 ) (Godot 3).
const EXT_ID = /ExtResource\(\s*"?([^")\s]+)"?\s*\)/

const unquote = (value: string): string => (value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value)

const attrsOf = (text: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  for (const m of text.matchAll(ATTR)) attrs[m[1]!] = m[2]!
  return attrs
}

export const parseScene = (text: string): Scene => {
  const ext = new Map<string, { type: string; path: string }>()
  const nodes: TscnNode[] = []
  const connections: Connection[] = []
  let current: TscnNode | null = null
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = i + 1
    const header = raw.match(SECTION)
    if (!header) {
      // A node's own properties: only its script matters here.
      const script = current && raw.match(/^script\s*=\s*(.*)$/)
      const id = script ? script[1]!.match(EXT_ID)?.[1] : undefined
      const res = id ? ext.get(id) : undefined
      if (current && res && res.type === 'Script') current.script = res.path
      return
    }
    current = null
    const attrs = attrsOf(header[2]!)
    if (header[1] === 'ext_resource' && attrs.id) ext.set(unquote(attrs.id), { type: unquote(attrs.type ?? ''), path: unquote(attrs.path ?? '') })
    if (header[1] === 'node' && attrs.name) {
      const name = unquote(attrs.name)
      const parent = attrs.parent === undefined ? null : unquote(attrs.parent)
      const path = parent === null ? '.' : parent === '.' ? name : `${parent}/${name}`
      current = { path, name, line, script: '', isInstance: attrs.instance !== undefined }
      nodes.push(current)
    }
    if (header[1] === 'connection' && attrs.method) {
      const value = (key: string) => unquote(attrs[key] ?? '')
      connections.push({ signal: value('signal'), from: value('from'), to: value('to'), method: value('method'), line })
    }
  })
  return { nodes, connections }
}

// Words that open a statement, which a method regex would otherwise read as a call's name or a return type.
const NOT_NAMES = new Set(['if', 'while', 'for', 'foreach', 'switch', 'return', 'new', 'catch', 'using', 'lock', 'nameof', 'typeof', 'else', 'throw', 'await', 'base', 'this', 'when', 'in', 'is', 'as', 'get', 'set'])
const MODIFIERS = '(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|new|extern|unsafe|partial|abstract|readonly)\\s+)*'
// A method declaration: attributes, modifiers, a return type (generic or array), the name, maybe type parameters, `(`.
const METHOD = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*${MODIFIERS}([\\w.<>\\[\\],?]+)\\s+([A-Za-z_]\\w*)\\s*(?:<[^>()]*>)?\\s*\\(`)
const CLASS = /\bclass\s+([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*(?::\s*([^{\r\n]+))?/

export const scriptInfo = (csText: string): ScriptInfo => {
  const cls = csText.match(CLASS)
  const bases = (cls?.[2] ?? '')
    .split(',')
    .map(b => b.trim().replace(/<.*$/, '').replace(/^.*\./, '').replace(/\s.*$/, ''))
    .filter(b => /^[A-Za-z_]\w*$/.test(b))
  const methods = new Set<string>()
  for (const line of csText.split(/\r?\n/)) {
    const m = line.match(METHOD)
    if (m && !NOT_NAMES.has(m[1]!) && !NOT_NAMES.has(m[2]!)) methods.add(m[2]!)
  }
  return { className: cls?.[1] ?? '', bases, methods }
}

// The node paths a C# line names: string literal arguments of GetNode, GetNodeOrNull, HasNode and FindChild (with or
// without <T>), of new NodePath, and any "%Name" literal. An interpolated $"…" string or a path with {…} can't be read,
// and a ":property" subpath is cut off.
const CALL_PATH = /\b(?:GetNode(?:OrNull)?|HasNode|FindChild)\s*(?:<[^>()]*>)?\s*\(\s*(\$?)"((?:[^"\\]|\\.)*)"|\bnew\s+NodePath\s*\(\s*(\$?)"((?:[^"\\]|\\.)*)"/g
const UNIQUE = /(\$?)"(%[^"\\{}:]+)"/g

export const nodePathsIn = (line: string): string[] => {
  const paths: string[] = []
  const add = (isInterpolated: string, path: string) => {
    if (isInterpolated || !path || path.includes('{')) return
    const cut = path.split(':')[0]!
    if (cut && !paths.includes(cut)) paths.push(cut)
  }
  for (const m of line.matchAll(CALL_PATH)) add(m[1] ?? m[3] ?? '', m[2] ?? m[4] ?? '')
  for (const m of line.matchAll(UNIQUE)) add(m[1]!, m[2]!)
  return paths
}

// The node names a scene had at HEAD and no longer has.
export const removedNames = (head: Scene, now: Scene): string[] => {
  const kept = new Set(now.nodes.map(n => n.name))
  return [...new Set(head.nodes.map(n => n.name).filter(name => !kept.has(name)))]
}

// A res:// path as a path from the repo's top folder, given the folder project.godot is in ('' for the top).
export const resToRepo = (projectDir: string, res: string): string => {
  const rel = res.replace(/^res:\/\//, '')
  return projectDir ? `${projectDir}/${rel}` : rel
}

// A method name that is the engine's (hide, queue_free): a connection to it calls a built-in, not the script.
const isEngineName = (method: string): boolean => /^[a-z][a-z0-9_]*$/.test(method)

// Each connection whose target node's C# script doesn't declare its method. `scriptOf` gives a res:// script's file
// and class, or null when it can't be read; `methodsUp` gives the class's methods with its partial parts and the
// repo's base classes, or null when the chain can't be followed far enough to be sure.
export const connectionFindings = (
  check: CheckSpec,
  scenePath: string,
  scene: Scene,
  scriptOf: (res: string) => { path: string; info: ScriptInfo } | null,
  methodsUp: (info: ScriptInfo) => Set<string> | null,
): Finding[] => {
  const out: Finding[] = []
  for (const c of scene.connections) {
    const target = scene.nodes.find(n => n.path === (c.to || '.'))
    if (!target || target.isInstance || !target.script.endsWith('.cs') || isEngineName(c.method)) continue
    const script = scriptOf(target.script)
    const methods = script ? methodsUp(script.info) : null
    if (!script || !methods || methods.has(c.method)) continue
    out.push(
      finding(check, {
        file: scenePath,
        line: c.line,
        rule: 'missing-method',
        severity: 'error',
        message: `connection "${c.signal}" from ${c.from} calls ${c.method}, which ${script.path} doesn't declare`,
        ciWouldFail: check.class === 'ci',
      }),
    )
  }
  return out
}

// Each node path string in the C# lines found that names a removed node: `removed` maps a name to the scene it was
// removed from.
export const nodePathFindings = (check: CheckSpec, removed: Map<string, string>, hits: GrepHit[]): Finding[] => {
  const out: Finding[] = []
  const seen = new Set<string>()
  for (const hit of hits)
    for (const path of nodePathsIn(hit.text))
      for (const segment of path.split('/')) {
        const name = segment.replace(/^%/, '')
        const scene = removed.get(name)
        const key = `${hit.file}:${hit.line}:${name}`
        if (!scene || seen.has(key)) continue
        seen.add(key)
        const isUnique = segment.startsWith('%') && path === segment
        out.push(
          finding(check, {
            file: hit.file,
            line: hit.line,
            rule: 'removed-node',
            severity: 'error',
            message: isUnique ? `"%${name}" names ${name}, a node removed from ${scene}` : `GetNode path "${path}" names ${name}, a node removed from ${scene}`,
            ciWouldFail: check.class === 'ci',
          }),
        )
      }
  return out
}
