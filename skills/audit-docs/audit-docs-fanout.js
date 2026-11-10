export const meta = {
  name: 'audit-docs-fanout',
  description: 'Read-only docs audit fan-out: auditors with slices that do not overlap, then adversarial verifiers; returns a compact summary and the full changelist',
  whenToUse: 'Run by the audit-docs skill in plan mode, with args {context, root, date, history, docs, auditors, verifiers?, agents?}; agents is {auditor?, verifier?}, each {model?, effort?}',
  phases: [
    { title: 'Audit', detail: 'one read-only auditor per slice', model: 'opus' },
    { title: 'Verify', detail: 'adversarial verifiers, each owning some rows, keep also as a verdict-only second opinion', model: 'opus' },
  ],
}

// The user's rule: at most 10 agents at a time. Verify waits for Audit, so a cap per phase caps how many run at once.
const MAX_PER_PHASE = 10
// Every agent runs on Opus at high effort at most, whatever model the session runs on: a bigger model orchestrates
// and checks, it doesn't fan out. A model or effort given above the cap, or one not on the lists, is brought down to it.
const MAX_MODEL = 'opus'
const MAX_EFFORT = 'high'
const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const under = (list, value, max) => list.includes(value) && list.indexOf(value) <= list.indexOf(max) ? value : max
const capped = (model, effort) => ({ model: under(MODELS, model, MAX_MODEL), effort: under(EFFORTS, effort, MAX_EFFORT) })
// What the person set for a kind of agent (args.agents: {<role>: {model?, effort?}}, from the skills' settings file,
// passed on by the skill); a value left out is the default given here, and all of it is brought down to the cap.
const chosen = args && args.agents && typeof args.agents === 'object' ? args.agents : {}
const roleOpts = (role, model, effort) => {
  const set = chosen[role] && typeof chosen[role] === 'object' ? chosen[role] : {}
  return capped(set.model || model, set.effort || effort)
}
const ranOnLine = (ranOn) => 'ran on: ' + Object.entries(ranOn).map(([role, o]) => `${role} ${o.model}/${o.effort}`).join(', ')
const ROLES = {
  auditor: roleOpts('auditor', MAX_MODEL, MAX_EFFORT),
  verifier: roleOpts('verifier', MAX_MODEL, MAX_EFFORT),
}
const WORDS_CAP = 8000
const WORDS_CAP_EXTRACT = 3000
// The completion preview shows only the first few KB of the result, so the summary (first key) stays small.
const SUMMARY_MAX = 5000
const SUMMARY_IDS = 60
// The same lists live in apply_changes.py; tests/test_apply.py compares them.
const KINDS = ['current', 'instructions', 'record', 'changelog', 'archive', 'history', 'generated', 'translation', 'copy', 'parsed', 'index', 'third_party', 'code']
const ACTIONS = ['EDIT', 'MOVE', 'DELETE', 'ADD', 'ASK']
const CATEGORIES = ['DRIFT', 'STALE_STATUS', 'HISTORY_LEAK', 'BROKEN_REF', 'CONTRADICTION', 'MISPLACED', 'INCOMPLETE_LIST', 'DUPLICATE']
const KEY = /^[a-z0-9]+$/
const KIND_RULES = {
  current: 'full audit.',
  instructions: 'CLAUDE.md, rules, agents, SKILL.md: a model reads new_text as an order, so literal text only; check it against hooks and settings.',
  record: 'ADRs, decisions, dated reports, learnings: never moved, deleted or reworded; only EDIT the status field, the index and cross-references; a superseded record is an ASK for a new one.',
  changelog: 'history by nature: no HISTORY_LEAK; entries never move; only EDIT broken references.',
  archive: 'snapshots and archived docs: not audited for drift; a valid link target; ASK only.',
  history: 'the history file: read only for current rules that live only here (MOVE them out or ADD them to a current doc).',
  generated: 'never edited; an ASK says what regenerates it.',
  translation: 'not a duplicate of its source (of); a difference is an ASK; keep its language, never translate while fixing.',
  copy: 'a template or skill copy of its source (of): equal on purpose; a difference is an ASK.',
  parsed: 'a tool reads it (parser): keep what the tool reads (ids, checkpoint rows, headings, table columns, nav entries).',
  index: 'stays in step with the files it lists (of).',
  third_party: 'received text: never edited; ASK only.',
  code: 'only EDIT doc references in comments.',
}
const READ_ONLY = 'YOU ARE READ-ONLY: do not create, edit or delete any file; no builds, tests or git. Only read and search.'
const RULES = `CLASSIFICATION (when in doubt, it stays):
- Stays in the current docs: every current rule, number, error text, name, mistake path, and reason for the current design, at any length.
- History: dates and stamps, how a feature was planned, old behaviour and its fixes, superseded designs, statuses and verdicts, stories of how something was found out. A "last updated" stamp is just deleted.
- Drift and contradictions are settled by the code. Design that isn't built yet (planned systems, later ideas, open questions) is not drift. If the code looks like the bug, or the doc may be the intended design, the action is ASK.
- A duplicate is ASK: name the section that owns the rule; an option can turn the other copy into "(see X)".
- Leak patterns (hits need judgement): dates (20NN-NN), since, used to, no longer, last updated; these are English examples, the context names the words for other languages.
HOW A ROW SAYS WHAT CHANGES (the apply script refuses anything else):
- file, start, end: the lines in the file as you read them, 1-based and inclusive. first_line and last_line: the start of those lines, copied exactly (at least 20 characters, or the whole line if shorter; you may stop before a backslash). last_line may be left out when end = start.
- quote: only when start = end, an exact part of that line, found once; then new_text replaces only the quote. Without a quote, new_text replaces the whole range.
- new_text is the literal text that lands in the file, nothing else: never an instruction like "(delete the sentence)", never "[lines 3-9]", never the text before or after a quote again. Instructions and explanations go in note.
- EDIT: a range and new_text. To delete part of a line, give the quote and an empty new_text.
- DELETE: a range, no new_text.
- MOVE: a range and a destination; NO new_text (the apply script copies the lines itself); leave is text that stays in the source instead; strip lists exact stamps to drop from the moved copy.
- ADD: a destination and new_text; give the source range too when the text comes from somewhere.
- ASK: a range, the question in problem, and 1 to 4 options, the recommended one first; an option inherits file and range unless it names its own; an option with no action means "leave it as is".
- destination: { file, section, after?, create? }. section is the exact heading line, or null for the end of the file; after is the start of a line inside the section to insert after; create: true appends a missing heading once at the end. For the history file, section is a plain label.`

const DEFAULT_VERIFIERS = [
  { key: 'keep', owns: ['MOVE', 'DELETE', 'HISTORY_LEAK', 'MISPLACED', 'DUPLICATE'], focus: 'every row you own: does it remove a current rule, number, name, error text, mistake path or reason? Those stay; when in doubt it stays. Does the range cover exactly the text meant (not a line more or less)? Rows under SECOND OPINION: verdict only, CONFIRMED or REJECTED, never AMENDED.' },
  { key: 'evidence', owns: ['DRIFT', 'BROKEN_REF', 'CONTRADICTION', 'INCOMPLETE_LIST', 'STALE_STATUS'], focus: 'every row you own: re-read the cited code and docs. Is the claim true, and does new_text match the code exactly (names, numbers, texts)? Design that is not built yet is not drift. If the code looks like the bug, or the doc may be the intended design, amend the action to ASK.' },
  { key: 'missed', owns: [], focus: 'what the auditors missed: the seams between slices, current rules that only live in the history file, references (sections, files, identifiers, line numbers) that no longer resolve, and leak-pattern hits that really are history. You own no rows; report new ones under missed.' },
]

const str = { type: 'string' }
const int = { type: 'integer', minimum: 1 }
const DESTINATION = { type: 'object', required: ['file'], properties: {
  file: str, section: { type: ['string', 'null'], description: 'the exact heading line, or null for the end of the file; for the history file a plain label' },
  after: { type: 'string', description: 'the start of a line inside the section to insert after' }, create: { type: 'boolean' },
} }
const CORE = {
  action: { type: 'string', enum: ACTIONS }, file: str, start: int, end: int,
  first_line: { type: 'string', description: 'the start of line start, copied exactly' },
  last_line: { type: 'string', description: 'the start of line end, copied exactly' },
  quote: { type: 'string', description: 'only when start = end: an exact part of that line' },
  new_text: { type: 'string', description: 'literal text only' },
  leave: { type: 'string', description: 'MOVE: text that stays in the source' },
  strip: { type: 'array', items: str, description: 'MOVE: exact stamps dropped from the moved copy' },
  destination: DESTINATION,
}
const OPTION = { type: 'object', required: ['label'], properties: { label: str, ...CORE } }
const CHANGE = { type: 'object', required: ['category', 'action', 'file', 'problem', 'evidence'], properties: {
  category: { type: 'string', enum: CATEGORIES }, ...CORE,
  options: { type: 'array', maxItems: 4, items: OPTION },
  problem: str, note: { type: 'string', description: 'explanations and instructions; never applied' },
  evidence: { type: 'array', items: str, description: 'file:line you read to check it' },
} }
const AUDIT = { type: 'object', required: ['slice', 'changes'], properties: {
  slice: { type: 'string', description: 'what you read, as file:line ranges' }, changes: { type: 'array', items: CHANGE },
} }
const VERIFY = { type: 'object', required: ['verdicts', 'missed'], properties: {
  verdicts: { type: 'array', items: { type: 'object', required: ['id', 'verdict', 'reason'], properties: {
    id: str, verdict: { type: 'string', enum: ['CONFIRMED', 'REJECTED', 'AMENDED'] }, reason: { type: 'string', description: 'with file:line' }, amended: CHANGE,
  } } },
  missed: { type: 'array', items: CHANGE },
} }

const fail = (why) => { throw new Error(`audit-docs args: ${why}`) }

function validateArgs(a, verifiers) {
  if (!a.date || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) fail('date (YYYY-MM-DD) is required')
  if (!Array.isArray(a.docs) || !a.docs.length) fail('docs is required')
  for (const d of a.docs) if (!KINDS.includes(d.kind)) fail(`unknown kind "${d.kind}" for ${d.file}`)
  for (const [name, list] of [['auditors', a.auditors], ['verifiers', verifiers]]) {
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PER_PHASE) fail(`${name}: need 1 to ${MAX_PER_PHASE}`)
    for (const x of list) if (!KEY.test(x.key || '') || x.key === 'user') fail(`${name}: key "${x.key}" must match [a-z0-9]+ and not be "user"`)
  }
  const seen = {}
  for (const au of a.auditors) {
    const cap = au.role === 'extract' ? WORDS_CAP_EXTRACT : WORDS_CAP
    if (!(au.words > 0) || au.words > cap) fail(`auditor ${au.key}: words must be 1 to ${cap}`)
    for (const r of au.ranges || []) {
      for (const o of seen[r.file] || []) if (r.start <= o.end && o.start <= r.end) fail(`auditors ${o.key} and ${au.key} overlap in ${r.file}`)
      ;(seen[r.file] = seen[r.file] || []).push({ ...r, key: au.key })
    }
  }
  if (!verifiers.some(v => v.key === 'keep')) fail('a keep verifier is required (it gives the second opinion)')
  if (!verifiers.some(v => (v.owns || []).includes('MOVE'))) fail('no verifier owns MOVE')
  for (const c of CATEGORIES) if (!verifiers.some(v => (v.owns || []).includes(c))) fail(`no verifier owns ${c}`)
}

const idSort = (id) => {
  const m = /^([a-z0-9]+)-(x?)(\d+)$/.exec(id) || [null, id, '', '0']
  return [m[1], m[2] ? 1 : 0, Number(m[3])]
}
const byId = (a, b) => {
  const x = idSort(a.id), y = idSort(b.id)
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || x[2] - y[2]
}

function structural(c) {
  const has = (k) => c[k] !== undefined && c[k] !== null
  const range = has('start') && has('end') && has('first_line')
  const need = {
    EDIT: range && typeof c.new_text === 'string', DELETE: range, MOVE: range && has('destination'),
    ADD: has('destination') && typeof c.new_text === 'string', ASK: range && Array.isArray(c.options) && c.options.length > 0,
  }
  if (!need[c.action]) return `missing field for ${c.action}`
  if (has('start') && has('end') && c.end < c.start) return 'end < start'
  if (has('quote') && c.end > c.start) return 'quote with end > start'
  if (c.action === 'MOVE' && has('new_text')) return 'MOVE with new_text'
  return null
}

// Overlaps between rows that remove or replace text; ASKs and ADDs are settled after picks, by apply_changes.py check.
function overlaps(changes) {
  const out = []
  const live = changes.filter(c => ['EDIT', 'MOVE', 'DELETE'].includes(c.action) && c.start && c.end)
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j]
    if (a.file !== b.file || a.start > b.end || b.start > a.end) continue
    if (a.quote && b.quote && a.start === b.start) continue
    out.push([a.id, b.id])
  }
  return out
}

function secondOpinion(c) {
  if (c.action !== 'EDIT') return false
  if (c.end > c.start) return true
  const text = c.new_text || ''
  return c.quote ? text.length < c.quote.length : text.length < (c.first_line || '').length
}

function capIds(list) {
  return list.length > SUMMARY_IDS ? [...list.slice(0, SUMMARY_IDS), `+${list.length - SUMMARY_IDS} more`] : list
}

const { context } = args
const verifiers = args.verifiers || DEFAULT_VERIFIERS
validateArgs(args, verifiers)
const docsOf = Object.fromEntries(args.docs.map(d => [d.file, d]))
const kindsPresent = [...new Set(args.docs.map(d => d.kind))]
const docLines = args.docs.map(d => `- ${d.file}: ${d.kind}${d.tracked ? '' : ', untracked'}${d.language ? `, ${d.language}` : ''}${d.of ? `, of ${d.of}` : ''}${d.parser ? `, read by ${d.parser}` : ''}`).join('\n')
const kindLines = kindsPresent.map(k => `- ${k}: ${KIND_RULES[k]}`).join('\n')
const historyLine = args.history ? `History file: ${args.history.file} (MOVE and ADD of history text go there, with a plain label as section).` : 'No history file: history text is deleted with DELETE or EDIT.'
const head = `${context}\n${READ_ONLY}\n${RULES}\nDOCS IN SCOPE (a row for any other file is set aside):\n${docLines}\nDOC KINDS PRESENT (each doc's rule):\n${kindLines}\n${historyLine}`

log(ranOnLine(ROLES))
phase('Audit')
const audits = (await parallel(args.auditors.map(a => () => {
  const ranges = (a.ranges || []).map(r => `${r.file}:${r.start}-${r.end}`).join(', ')
  const role = a.role === 'extract'
    ? 'EXTRACT SLICE: these ranges move to history whole. Report each as one MOVE to the history file. Report every current rule, gotcha, number or reason that lives only here as an ADD to the current doc and section where it belongs (create: true for a new section), in that doc\'s style, with the source range. Never put moved text in new_text.'
    : 'Read every line of your slice and check each claim against what it describes, citing file:line.'
  return agent(`${head}\nYOUR SLICE (other auditors cover the rest): ${ranges}\n${a.brief}\n${role}\nQuote anchors exactly. Report only problems; a clean slice returns an empty changes list.`,
    { label: `audit:${a.key}`, phase: 'Audit', schema: AUDIT, ...ROLES.auditor })
    .then(r => r && { key: a.key, ...r })
}))).filter(Boolean)

const changes = audits.flatMap(a => (a.changes || []).map((c, i) => ({ ...c, id: `${a.key}-${i + 1}` })))
const ownerOf = (c) => verifiers.find(v => (v.owns || []).includes(c.action) || (v.owns || []).includes(c.category))
const index = changes.map(c => `${c.id} ${c.file} ${c.start || ''}-${c.end || ''} ${c.action}`).join('\n')
const slices = audits.map(a => `- ${a.key}: ${a.slice}`).join('\n')

const verifyPrompt = (v, owned, second) => `${head}\nThe auditors' slices:\n${slices}\n\nIndex of all rows (id file start-end action):\n${index}\n\n` +
  (owned.length ? `BEGIN OWNED (JSON; give a verdict for each)\n${JSON.stringify(owned)}\nEND OWNED\n\n` : '') +
  (second.length ? `BEGIN SECOND OPINION (JSON; verdict only, CONFIRMED or REJECTED)\n${JSON.stringify(second)}\nEND SECOND OPINION\n\n` : '') +
  `You are an ADVERSARIAL VERIFIER. Assume each row and each new_text is wrong until the source says otherwise. Check that first_line and last_line really start lines start and end. Focus: ${v.focus}\nAMENDED carries the full corrected row. Put what the auditors missed under "missed".`

phase('Verify')
const plan = verifiers.map(v => ({
  v,
  owned: changes.filter(c => ownerOf(c) === v),
  second: v.key === 'keep' ? changes.filter(c => ownerOf(c) !== v && secondOpinion(c)) : [],
}))
const verifications = await parallel(plan.map(p => () =>
  agent(verifyPrompt(p.v, p.owned, p.second), { label: `verify:${p.v.key}`, phase: 'Verify', schema: VERIFY, ...ROLES.verifier })
    .then(r => r && { key: p.v.key, ...r })))

const incomplete = [
  ...args.auditors.filter(a => !audits.some(x => x.key === a.key)).map(a => `audit:${a.key}`),
  ...verifiers.filter((v, i) => !verifications[i]).map(v => `verify:${v.key}`),
]
const verdictOf = (key, id) => {
  const r = verifications.find(x => x && x.key === key)
  return r ? (r.verdicts || []).find(x => x.id === id) : undefined
}

const final = []
const rejected = []
const secondRejected = []
for (const c of changes) {
  const owner = ownerOf(c)
  const own = owner ? verdictOf(owner.key, c.id) : undefined
  const sec = owner && owner.key !== 'keep' && secondOpinion(c) ? verdictOf('keep', c.id) : undefined
  const amended = own && own.verdict === 'AMENDED' && own.amended ? { ...own.amended, id: c.id } : undefined
  if (own && own.verdict === 'REJECTED') { rejected.push({ id: c.id, by: owner.key, reason: own.reason, original: c }); continue }
  if (sec && sec.verdict === 'REJECTED') {
    rejected.push({ id: c.id, by: 'keep', reason: sec.reason, original: c, ...(amended ? { amended } : {}) })
    secondRejected.push(c.id)
    continue
  }
  if (amended) final.push({ ...amended, verified_by: owner.key, verdict: 'AMENDED', action_changed: amended.action !== c.action })
  else if (own && own.verdict === 'CONFIRMED') final.push({ ...c, verified_by: owner.key, verdict: 'CONFIRMED' })
  else final.push({ ...c, verified_by: '', verdict: 'UNVERIFIED' })
}
for (const r of verifications) {
  if (!r) continue
  ;(r.missed || []).forEach((m, i) => final.push({ ...m, id: `${r.key}-x${i + 1}`, verified_by: '', verdict: 'UNVERIFIED' }))
}

// An amendment that changed a row's action gets keep's verdict-only look too.
const changed = final.filter(c => c.action_changed && c.verified_by !== 'keep')
let agents = audits.length + verifications.filter(Boolean).length
if (changed.length) {
  const keep = verifiers.find(v => v.key === 'keep')
  const r = await agent(verifyPrompt(keep, [], changed), { label: 'verify:keep-changed', phase: 'Verify', schema: VERIFY, ...ROLES.verifier })
  agents += 1
  if (!r) incomplete.push('verify:keep-changed')
  for (const c of changed) {
    const v = r && (r.verdicts || []).find(x => x.id === c.id)
    if (v && v.verdict === 'REJECTED') {
      final.splice(final.indexOf(c), 1)
      rejected.push({ id: c.id, by: 'keep', reason: v.reason, original: changes.find(x => x.id === c.id), amended: c })
      secondRejected.push(c.id)
    }
  }
}

const blocked = []
for (const c of final) {
  delete c.action_changed
  const d = docsOf[c.file]
  c.kind = d ? d.kind : ''
  c.tracked = d ? !!d.tracked : false
  const why = d ? structural(c) : 'outside docs'
  if (why) { c.blocked = why; blocked.push({ id: c.id, why }) }
}
for (const [a, b] of overlaps(final)) blocked.push({ id: `${a}+${b}`, why: 'overlap' })
final.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.start || 0) - (b.start || 0)) || byId(a, b))
rejected.sort(byId)

const counts = Object.fromEntries(ACTIONS.map(x => [x, final.filter(c => c.action === x).length]))
counts.rejected = rejected.length
counts.extras = final.filter(c => /-x\d+$/.test(c.id)).length
counts.unverified = final.filter(c => c.verdict === 'UNVERIFIED').length
const byFile = {}
for (const c of final) byFile[c.file] = (byFile[c.file] || 0) + 1
const summary = {
  counts, by_file: byFile, incomplete,
  blocked: blocked.slice(0, SUMMARY_IDS), asks: capIds(final.filter(c => c.action === 'ASK').map(c => c.id)),
  rejected: capIds(rejected.map(r => r.id)), rejected_by_second_opinion: capIds(secondRejected),
  unverified: capIds(final.filter(c => c.verdict === 'UNVERIFIED').map(c => c.id)),
  files: { tracked: args.docs.filter(d => d.tracked).map(d => d.file), untracked: args.docs.filter(d => !d.tracked).map(d => d.file) },
}
if (JSON.stringify(summary).length > SUMMARY_MAX) summary.note = 'summary cut; run apply_changes.py summary for the full lists'
log(`${agents} agents returned, ${final.length} rows, ${rejected.length} rejected, incomplete: ${incomplete.join(', ') || 'none'}`)
return { summary, run: { date: args.date, root: args.root || '', history: args.history || null, agents, ranOn: ROLES }, docs: args.docs, changes: final, rejected }
