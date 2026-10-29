export const meta = {
  name: 'plan-fanout',
  description: 'Read-only planning fan-out: scouts, 1 to 3 domain planners, adversarial critics (or a re-check of a revised plan)',
  whenToUse: 'Run by the CCInformer plan-feature and plan-handoff skills in plan mode, with args {context, requirements?, priorFindings?, scouts: [{key, brief, agentType?, model?, effort?}], planners, critics?, extraCritics?} or {context, recheck: {plan, changes}, critics?, extraCritics?}',
  phases: [
    { title: 'Scout', detail: 'one read-only scout per domain', model: 'sonnet' },
    { title: 'Plan', detail: '1 to 3 planners owning domains that do not overlap' },
    { title: 'Critique', detail: 'adversarial reviewers, one lens each, structured findings' },
  ],
}

// At most 10 agents at a time. Each phase waits for the one before (planners need every report, critics every
// plan), so a cap per phase is a cap on how many run at once; the total can be higher.
const MAX_PER_PHASE = 10
const MAX_PLANNERS = 3
// Scouts gather facts that the planners and critics check against the code, so a faster model is enough there and
// shortens the first phase. Planners and critics inherit the session's model and effort. A scout whose report the
// plan will rest on unchecked (proving something is absent, access rules) asks for more with its own model/effort.
const SCOUT_MODEL = 'sonnet'
const SCOUT_EFFORT = 'medium'
const READ_ONLY = 'YOU ARE READ-ONLY: do not create, edit or delete any file; no builds, tests, git, deploys or writes to any database or service. Only read and search.'
const DEFAULT_CRITICS = [
  { key: 'correctness', focus: 'correctness against the actual code (verify every signature and behaviour a plan assumes by reading it), determinism, edge cases, tests or invariants that could pass wrongly or only repeat the code, magic numbers, YAGNI.' },
  { key: 'fit', focus: 'whether the plans agree with each other and with the existing code (list every mismatch in the interface between planners, including data shapes, columns and API payloads), naming and project rules, and whether the docs updates are complete.' },
  { key: 'gaps', focus: 'what no plan covers (from the requirements, the task, the scout reports or the design docs), contradictions between plans, unmeasurable checkpoints, and ordering risks between the checkpoints (does everything still build and pass after each one?).' },
]
// Structured findings, so the main session can check each one against the code and none gets lost in prose.
const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'should-fix', 'nit'] },
          claim: { type: 'string', description: 'What is wrong or missing, in one or two sentences' },
          planner: { type: 'string', description: 'The planner key it concerns, or "all"' },
          file: { type: 'string', description: 'The repo file the evidence is in, if any' },
          line: { type: 'integer' },
          evidence: { type: 'string', description: 'The code or doc fact that shows it (quote briefly)' },
          minimalFix: { type: 'string' },
        },
        required: ['severity', 'claim', 'evidence', 'minimalFix'],
      },
    },
    summary: { type: 'string', description: 'At most three sentences' },
  },
  required: ['findings', 'summary'],
}

const { context } = args
const requirements = args.requirements ? `\nREQUIREMENTS (judge everything against these):\n${args.requirements}\n` : ''
const priorFindings = args.priorFindings ? `\nPRIOR FINDINGS (from earlier research: verify what you rely on, don't redo it):\n${args.priorFindings}\n` : ''
const critics = [...(args.critics || DEFAULT_CRITICS), ...(args.extraCritics || [])]
const checkList = (name, list) => {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PER_PHASE)
    throw new Error(`${name}: need 1 to ${MAX_PER_PHASE}`)
}
const section = (kind, items, field) => items.map(x => `### ${kind}: ${x.key}\n${x[field]}`).join('\n\n')

const critique = (subject) => parallel(critics.map(c => () =>
  agent(`${context}${requirements}\n${READ_ONLY}\n${subject}\n\nYou are an ADVERSARIAL REVIEWER. Assume the plans are wrong until the code says otherwise. Focus: ${c.focus}\nReturn your findings: BLOCKERS (would break, contradict the code or the requirements, or skip a needed approval), SHOULD-FIX, NITS. Each with evidence (file and line where there is one) and the minimal fix. Don't restate the plans. At most about 15 findings.`,
    { label: `critic:${c.key}`, phase: 'Critique', schema: CRITIQUE_SCHEMA })
    .then(r => r && { key: c.key, ...r })))
  .then(rs => rs.filter(Boolean))

checkList('critics', critics)

// Re-check mode: only the critics, on a revised plan, after the blockers of a first run were folded in.
if (args.recheck) {
  log(`re-check: ${critics.length} critics`)
  phase('Critique')
  const critiques = await critique(`The REVISED PLAN:\n\n${args.recheck.plan}\n\nWhat changed since the first review (check these hardest, and whether the fixes introduced new problems):\n${args.recheck.changes}`)
  return { critiques }
}

const { scouts, planners } = args
checkList('scouts', scouts)
checkList('planners', planners)
if (planners.length > MAX_PLANNERS)
  throw new Error(`planners: at most ${MAX_PLANNERS}, split by domain`)
log(`agents: ${scouts.length} scouts, ${planners.length} planners, ${critics.length} critics (${scouts.length + planners.length + critics.length} in total)`)

phase('Scout')
const reports = (await parallel(scouts.map(s => () =>
  agent(`${context}${requirements}${priorFindings}\n${READ_ONLY}\nSCOUT DOMAIN: ${s.brief}\nReturn a dense report (headings and bullets), at most about 900 words, facts with file:line citations, then a short "Implications for the plan" list. For anything you report as absent (no callers, no other uses), say how you searched; mark what you couldn't confirm as unconfirmed.`,
    { label: `scout:${s.key}`, phase: 'Scout', model: s.model || SCOUT_MODEL, effort: s.effort || SCOUT_EFFORT, ...(s.agentType ? { agentType: s.agentType } : {}) })
    .then(r => r && { key: s.key, report: r })))).filter(Boolean)
const missingScouts = scouts.filter(s => !reports.some(r => r.key === s.key)).map(s => s.key)
if (missingScouts.length)
  log(`missing scout reports: ${missingScouts.join(', ')}`)

phase('Plan')
const plans = (await parallel(planners.map(p => () => {
  const others = planners.filter(o => o !== p).map(o => o.key).join(', ') || 'none'
  return agent(`${context}${requirements}\n${READ_ONLY}\nScout reports (verify anything you rely on by reading the cited code):\n\n${section('Scout report', reports, 'report')}\n\nPLANNER DOMAIN (you own only this; the other planners: ${others}): ${p.brief}
Give:
- exact files, new types and members with signatures;
- the files another planner's domain also has to change (barrels, route tables, translation tables, config, shared types);
- the data contract you touch (columns, constraints, access rules, API or JSON shapes, storage paths);
- the user-facing texts (UI strings) you add;
- checkpoints in build order, each with a measurable "done when";
- every action that writes to a shared environment, a database, a service or git, marked "NEEDS APPROVAL";
- how it is deployed and rolled back, and what behaves differently after deploy;
- the tests, especially those that encode business or access rules.
Say exactly what you need from or give to the other planners. List the defaults you took. End with "Open questions" (only real decisions, at most 5, each with your recommendation), split into "for the user" and "for other stakeholders". At most about 1500 words.`,
    { label: `plan:${p.key}`, phase: 'Plan' }).then(r => r && { key: p.key, plan: r })
}))).filter(Boolean)

// Don't review a plan with a hole in it: a missing domain would read as "nothing to say".
const missingPlanners = planners.filter(p => !plans.some(x => x.key === p.key)).map(p => p.key)
if (missingPlanners.length) {
  log(`missing plans: ${missingPlanners.join(', ')}; critique skipped, re-run those planners first`)
  return { reports, plans, missingScouts, missingPlanners, critiques: [] }
}

phase('Critique')
const critiques = await critique(`Scout reports:\n\n${section('Scout report', reports, 'report')}\n\nThe plans:\n\n${section('Plan', plans, 'plan')}`)

log(`${reports.length + plans.length + critiques.length} agents returned`)
return { reports, plans, missingScouts, missingPlanners, critiques }
