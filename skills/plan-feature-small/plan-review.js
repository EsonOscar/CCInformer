export const meta = {
  name: 'plan-review',
  description: 'One read-only critic reviews a drafted plan against the code, every lens in its own section',
  whenToUse: "Run by the CCInformer plan-feature-small skill (rounds 1 and 2, and the final check) and by plan-feature and plan-handoff (the final check), in plan mode, with args {context, requirements, plan, files, round: 1 | 2 | 'final', lenses?, previous? (round 2), changes? (final)}",
  phases: [{ title: 'Review', detail: 'one adversarial critic, every lens', model: 'opus' }],
}

// plan-feature-small's review: one critic, kept fast. It reads the plan file and the files the plan touches, and goes
// further only to back up a finding. The main session checks what it finds and decides the replan; a second round is
// for a blocker only (needsRound2), and there is never a third. Once the main session has folded in the last round
// and the user's answers, a final check looks only at what it changed since (round 'final'), once, with no round after.
const MODEL = 'opus'
const EFFORT = 'medium'
const MAX_FILES = 30
const MAX_LENSES = 3
const MAX_FINDINGS = 10
const READ_ONLY = 'YOU ARE READ-ONLY: do not create, edit or delete any file; no builds, tests, git, deploys or writes to any database or service. Only read and search.'
const DEFAULT_LENSES = [
  { key: 'correctness', focus: 'correctness against the actual code (verify every signature and behaviour the plan assumes by reading it), edge cases, tests or invariants that could pass wrongly, YAGNI.' },
  { key: 'fit', focus: 'whether the plan agrees with the existing code and the project rules (naming, structure, the docs that must change), and every mismatch in the shapes and names it uses.' },
  { key: 'gaps', focus: 'what the plan leaves out from the requirements and the task, contradictions inside it, checkpoints that cannot be measured, and whether everything still builds and passes after each checkpoint.' },
]
const FINDING = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['blocker', 'should-fix', 'nit'] },
    claim: { type: 'string', description: 'What is wrong or missing, in one or two sentences' },
    file: { type: 'string', description: 'The repo file the evidence is in, if any' },
    line: { type: 'integer' },
    evidence: { type: 'string', description: 'The code or doc fact that shows it (quote briefly)' },
    minimalFix: { type: 'string' },
  },
  required: ['severity', 'claim', 'evidence', 'minimalFix'],
}

const fail = (what) => { throw new Error(`plan-review args: ${what}`) }
const a = args || {}
if (typeof a.context !== 'string' || !a.context.trim()) fail('context must be text')
if (typeof a.requirements !== 'string' || !a.requirements.trim()) fail('requirements must be text')
if (typeof a.plan !== 'string' || !a.plan.trim()) fail("plan must be the plan file's path")
if (!Array.isArray(a.files) || a.files.length < 1 || a.files.length > MAX_FILES || !a.files.every(f => typeof f === 'string' && f.trim()))
  fail(`files must list 1 to ${MAX_FILES} paths the plan touches`)
if (a.round !== 1 && a.round !== 2 && a.round !== 'final') fail("round must be 1, 2 or 'final'")
const isFinal = a.round === 'final'
if (isFinal && (typeof a.changes !== 'string' || !a.changes.trim())) fail('the final check needs changes: what changed since the last review')
const extra = a.lenses ?? []
if (!Array.isArray(extra) || extra.length > MAX_LENSES) fail(`lenses must be a list of at most ${MAX_LENSES}`)
for (const l of extra)
  if (!l || !/^[a-z][a-z0-9-]*$/.test(l.key) || DEFAULT_LENSES.some(d => d.key === l.key) || typeof l.focus !== 'string' || !l.focus.trim())
    fail('each lens needs a lowercase key of its own and a focus')
if (new Set(extra.map(l => l.key)).size !== extra.length) fail('lens keys must differ')
if (a.round === 2 && (!a.previous || !Array.isArray(a.previous.findings) || typeof a.previous.changes !== 'string'))
  fail('round 2 needs previous: {findings, changes}')
const lenses = [...DEFAULT_LENSES, ...extra]

const SCHEMA = {
  type: 'object',
  properties: {
    lenses: {
      type: 'object',
      properties: Object.fromEntries(lenses.map(l => [l.key, {
        type: 'object',
        properties: {
          checked: { type: 'array', items: { type: 'string' }, description: 'The files this lens checked the plan against' },
          findings: { type: 'array', items: FINDING },
        },
        required: ['checked', 'findings'],
      }])),
      required: lenses.map(l => l.key),
    },
    summary: { type: 'string', description: 'At most three sentences' },
  },
  required: ['lenses', 'summary'],
}

const roundTwo = a.round === 2
  ? `\nTHIS IS ROUND 2. Round 1 found:\n${JSON.stringify(a.previous.findings, null, 1)}\nWhat changed since:\n${a.previous.changes}\nCheck these changes hardest, and whether the fixes broke something. Don't repeat a finding the changes fixed.\n`
  : isFinal
    ? `\nTHIS IS THE FINAL CHECK. The plan was reviewed before; since then the main session made these changes:\n${a.changes.trim()}\nCheck only these changes: is each one right against the code, and did it break anything else in the plan (a cross-reference, another checkpoint, the contract, a "done when" or test that would now pass wrongly)? Also flag a part these changes depend on that looks altered but isn't listed. Don't re-review the rest of the plan.\n`
    : ''
const prompt = `${a.context}

REQUIREMENTS (judge the plan against these):
${a.requirements}

${READ_ONLY}

Read the plan at ${a.plan}. Then read these files first, the ones the plan touches:
${a.files.map(f => `- ${f}`).join('\n')}
Go beyond them only to back up a finding: this review must be quick.
${roundTwo}
You are an ADVERSARIAL REVIEWER. Assume the plan is wrong until the code says otherwise. Review it through each lens, and fill every lens's section, with the files it checked:
${lenses.map(l => `- ${l.key}: ${l.focus}`).join('\n')}

Each finding: BLOCKER (would break, contradict the code or the requirements, or skip a needed approval), SHOULD-FIX or NIT, with evidence (file and line where there is one) and the minimal fix. Don't restate the plan. At most about ${MAX_FINDINGS} findings in all, the most serious first.`

phase('Review')
log(`${isFinal ? 'final check' : `round ${a.round}`}: one critic, ${lenses.length} lenses, ${a.files.length} files to read first`)
const review = await agent(prompt, { label: 'critic', phase: 'Review', model: MODEL, effort: EFFORT, schema: SCHEMA })
if (!review) return { round: a.round, error: `the critic returned nothing; run ${isFinal ? 'the final check' : 'this round'} again` }

const all = Object.values(review.lenses || {}).flatMap(l => (l && Array.isArray(l.findings) ? l.findings : []))
const count = (s) => all.filter(f => f && f.severity === s).length
const counts = { blocker: count('blocker'), shouldFix: count('should-fix'), nit: count('nit') }
return { round: a.round, lenses: review.lenses, summary: review.summary, counts, needsRound2: a.round === 1 && counts.blocker > 0 }
