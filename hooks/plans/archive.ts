import type { Platform } from '../env/procs'
import { powershell } from '../env/procs'

// Archiving a plan: where it goes, how the references to it change, and the words around it. Paths are repo-relative
// with `/`, and a folder at the repo's top is ''.

const DAY_MS = 24 * 60 * 60_000
const FILES_NAMED = 6

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
export const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// `rel` from `dir`, with `.` and `..` worked out; a path above the top keeps its leading `..`.
const resolve = (dir: string, rel: string): string => {
  const out: string[] = []
  for (const part of (dir ? dir + '/' + rel : rel).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

// The path that leads from `dir` to `to`.
const relative = (dir: string, to: string): string => {
  const from = dir ? dir.split('/') : []
  const parts = to.split('/')
  let same = 0
  while (same < from.length && same < parts.length - 1 && from[same] === parts[same]) same++
  return [...from.slice(same).map(() => '..'), ...parts.slice(same)].join('/')
}

// A Markdown link's target: `[text](target)`, or `[text](target "title")`.
const LINK = /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g
// A target that isn't a relative path: a URL (or a drive letter), an anchor alone, or an absolute path.
const isRelative = (target: string) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#') && !target.startsWith('/') && !target.startsWith('<')
const splitAnchor = (target: string): [string, string] => {
  const at = target.indexOf('#')
  return at < 0 ? [target, ''] : [target.slice(0, at), target.slice(at)]
}

// The relative link targets in a Markdown text, without their anchors.
export const markdownLinks = (text: string): string[] =>
  [...text.matchAll(LINK)].map(m => m[2]!).filter(isRelative).map(t => splitAnchor(t)[0]).filter(Boolean)

// Where a plan is archived: `.local/plans/archive` for one in `.local/plans`, else the pack's archive folder (none
// when it names none).
export const archiveDirFor = (path: string, spec: { archiveDir?: string } | undefined): string | null => {
  if (dirOf(path) === '.local/plans') return '.local/plans/archive'
  const dir = spec?.archiveDir?.replace(/\/+$/, '')
  return dir || null
}

export const archivePath = (path: string, dir: string): string => `${dir}/${baseOf(path)}`

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A text with its references to `from` moved to `to`: Markdown links that lead there from `fileDir`, and plain
// mentions of the path. A file outside the repo (`fileDir` null) has only its plain mentions changed.
export const rewriteRefs = (text: string, fileDir: string | null, from: string, to: string): string => {
  const linked =
    fileDir === null
      ? text
      : text.replace(LINK, (all, open: string, target: string, close: string) => {
          if (!isRelative(target)) return all
          const [path, anchor] = splitAnchor(target)
          return path && resolve(fileDir, path) === from ? open + relative(fileDir, to) + anchor + close : all
        })
  // A mention starts after anything but a letter, digit, `.`, `-` or `_`, and ends before anything but those.
  return linked.replace(new RegExp(`(^|[^\\w.-])${escape(from)}(?![\\w-])`, 'g'), (_, before: string) => before + to)
}

// The moved plan's own relative links, leading from its new folder to where they led before.
export const moveOwnLinks = (text: string, fromDir: string, toDir: string): string =>
  text.replace(LINK, (all, open: string, target: string, close: string) => {
    if (!isRelative(target)) return all
    const [path, anchor] = splitAnchor(target)
    return path ? open + relative(toDir, resolve(fromDir, path)) + anchor + close : all
  })

// The command that removes a file (the host has no delete): PowerShell's Remove-Item, or rm.
export const removeCommand = (platform: Platform, absPath: string): string[] =>
  platform === 'windows' ? powershell(`Remove-Item -LiteralPath '${absPath.replace(/'/g, "''")}' -ErrorAction Stop`) : ['rm', '--', absPath]

export const isReminderDue = (lastAt: number | null, now: number): boolean => lastAt === null || now - lastAt >= DAY_MS

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

// The archive dialog: the move, the files whose references change, and the checkpoints still open.
export const archiveQuestion = (from: string, to: string, files: string[], open: number): string => {
  const named = files.slice(0, FILES_NAMED).join(', ') + (files.length > FILES_NAMED ? `, and ${files.length - FILES_NAMED} more` : '')
  const refs = files.length ? ` and update references in ${files.length} ${plural(files.length, 'file', 'files')} (${named})` : ''
  const still = open ? ` ${open} ${plural(open, 'checkpoint is', 'checkpoints are')} still open.` : ''
  return `Move ${from} to ${to}${refs}?${still}`
}

export const reminderText = (count: number): string =>
  count === 1
    ? '1 finished plan: archive it in Work › Plans (select it, then a)'
    : `${count} finished plans: archive them in Work › Plans (select one, then a)`
