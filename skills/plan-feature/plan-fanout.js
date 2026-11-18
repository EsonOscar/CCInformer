export const meta = {
  name: 'plan-fanout',
  description: 'Read-only planning fan-out: scouts, 1 to 3 domain planners, adversarial critics (or a re-check of a revised plan)',
  whenToUse: 'Run by the CCInformer plan-feature and plan-handoff skills in plan mode, with args {context, requirements?, priorFindings?, scouts: [{key, brief, agentType?, model?, effort?}], planners, critics?, extraCritics?, agents?} or {context, recheck: {plan, changes}, critics?, extraCritics?, agents?}; agents is {scout?, planner?, critic?}, each {model?, effort?}',
  phases: [
    { title: 'Scout', detail: 'one read-only scout per domain', model: 'sonnet' },
    { title: 'Plan', detail: '1 to 3 planners owning domains that do not overlap', model: 'opus' },
    { title: 'Critique', detail: 'adversarial reviewers, one lens each, structured findings', model: 'opus' },
  ],
}

// At most 10 agents at a time. Each phase waits for the one before (planners need every report, critics every
// plan), so a cap per phase is a cap on how many run at once; the total can be higher.
const MAX_PER_PHASE = 10
const MAX_PLANNERS = 3
// Every agent runs on Opus at high effort at most, whatever model the session runs on: a bigger model orchestrates
// and checks, it doesn't fan out. A model or effort given above the cap, or one not on the lists, is brought down to it.
const MAX_MODEL = 'opus'
const MAX_EFFORT = 'high'
const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const under = (list, value, max) => list.includes(value) && list.indexOf(value) <= list.indexOf(max) ? value : max
const capped = (model, effort) => ({ model: under(MODELS, model, MAX_MODEL), effort: under(EFFORTS, effort, MAX_EFFORT) })
// Scouts gather facts that the planners and critics check against the code, so a faster model is enough there and
// shortens the first phase. Planners and critics run at the cap. A scout whose report the plan will rest on unchecked
// (proving something is absent, access rules) asks for more with its own model/effort, up to the cap.
const SCOUT_MODEL = 'sonnet'
const SCOUT_EFFORT = 'medium'
// What the person set for a kind of agent (args.agents: {<role>: {model?, effort?}}, from the skills' settings file,
// passed on by the skill); a value left out is the default given here, and all of it is brought down to the cap.
const chosen = args && args.agents && typeof args.agents === 'object' ? args.agents : {}
const roleOpts = (role, model, effort) => {
  const set = chosen[role] && typeof chosen[role] === 'object' ? chosen[role] : {}
  return capped(set.model || model, set.effort || effort)
}
const ranOnLine = (ranOn) => 'ran on: ' + Object.entries(ranOn).map(([role, o]) => `${role} ${o.model}/${o.effort}`).join(', ')
// What each agent() call was given, by its label: the run's record keeps the result, and the mod's Work area reads
// an agent's effort from here (the record itself names only its model).
const ranOnAgents = {}
const on = (label, opts) => { ranOnAgents[label] = { model: opts.model, effort: opts.effort }; return opts }
const ROLES = {
  scout: roleOpts('scout', SCOUT_MODEL, SCOUT_EFFORT),
  planner: roleOpts('planner', MAX_MODEL, MAX_EFFORT),
  critic: roleOpts('critic', MAX_MODEL, MAX_EFFORT),
}
const READ_ONLY = 'YOU ARE READ-ONLY: do not create, edit or delete any file; no builds, tests, git, deploys or writes to any database or service. Only read and search.'
const DEFAULT_CRITICS = [
  { key: 'correctness', focus: 'correctness against the actual code (verify every signature and behaviour a plan assumes by reading it), determinism, edge cases, tests or invariants that could pass wrongly (an expected value worked out the way the code works it out, a test that reaches past the public interface), magic numbers, YAGNI.' },
  { key: 'fit', focus: 'whether the plans agree with each other and with the existing code (list every mismatch in the interface between planners, including data shapes, columns and API payloads), naming and project rules, whether the docs updates are complete, and a new module or seam that does not earn its place (deleting it would move no complexity into its callers; nothing varies across it, not even a test stand-in).' },
  { key: 'gaps', focus: 'what no plan covers (from the requirements, the task, the scout reports or the design docs), a requirement or premise the code contradicts (quote both), a bug fix whose checkpoint does not start by reproducing the symptom, with no stated reason none can, contradictions between plans, unmeasurable checkpoints, and ordering risks between the checkpoints (does everything still build and pass after each one?).' },
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

// agent({schema}) throws once a critic's answer has failed validation too often: one bad character anywhere in the
// answer is enough. That critic is then asked once more for one JSON object per line, so a bad line costs only itself:
// a lone backslash (a Windows path) is doubled and the line parsed again, and a line that still won't parse is returned
// as raw text under unparsed. A critic that gives nothing either way is listed in missingCritics, never dropped silently.
const LINES_FORMAT = 'Answer in JSON Lines: one JSON object per line and nothing else. For each finding, one line {"severity": "blocker" | "should-fix" | "nit", "claim": "...", "evidence": "...", "minimalFix": "...", "planner": "...", "file": "...", "line": <number>} (planner, file and line only where there is one). Last, one line {"summary": "..."}. Write paths with forward slashes.'
const FINDING = CRITIQUE_SCHEMA.properties.findings.items
const parseLine = (line) => {
  for (const text of [line, line.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\')]) {
    try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
  }
  return null
}
const isFinding = (f) => FINDING.properties.severity.enum.includes(f.severity) && FINDING.required.every(k => typeof f[k] === 'string' && f[k].trim())
const fromLines = (text) => {
  const findings = []
  const unparsed = []
  let summary = ''
  let any = false
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('```')) continue
    any = true
    const v = parseLine(line)
    if (v && isFinding(v)) findings.push(v)
    else if (v && typeof v.summary === 'string') summary = v.summary
    else unparsed.push(line)
  }
  return any ? { findings, summary, fallback: 'lines', unparsed } : null
}

const critique = (subject) => parallel(critics.map(c => async () => {
  const prompt = `${context}${requirements}\n${READ_ONLY}\n${subject}\n\nYou are an ADVERSARIAL REVIEWER. Assume the plans are wrong until the code says otherwise. Focus: ${c.focus}\nReturn your findings: BLOCKERS (would break, contradict the code or the requirements, or skip a needed approval), SHOULD-FIX, NITS. Each with evidence (file and line where there is one) and the minimal fix. Don't restate the plans. At most about 15 findings.`
  let r
  try {
    r = await agent(prompt, { label: `critic:${c.key}`, phase: 'Critique', schema: CRITIQUE_SCHEMA, ...on(`critic:${c.key}`, ROLES.critic) })
  } catch (e) {
    log(`critic:${c.key}: its structured answer failed (${String((e && e.message) || e).slice(0, 120)}); asking for it again, one finding per line`)
    r = fromLines(await agent(`${prompt}\n\n${LINES_FORMAT}`, { label: `critic:${c.key}:lines`, phase: 'Critique', ...on(`critic:${c.key}:lines`, ROLES.critic) }))
  }
  return r && { key: c.key, ...r }
}))
  .then(rs => rs.filter(Boolean))
const missingOf = (critiques) => {
  const missing = critics.filter(c => !critiques.some(r => r.key === c.key)).map(c => c.key)
  if (missing.length) log(`missing critiques: ${missing.join(', ')}; re-run those lenses as a re-check`)
  return missing
}

checkList('critics', critics)

// Re-check mode: only the critics, on a revised plan, after the blockers of a first run were folded in.
if (args.recheck) {
  const ranOn = { critic: ROLES.critic }
  log(`re-check: ${critics.length} critics`)
  log(ranOnLine(ranOn))
  phase('Critique')
  const critiques = await critique(`The REVISED PLAN:\n\n${args.recheck.plan}\n\nWhat changed since the first review (check these hardest, and whether the fixes introduced new problems):\n${args.recheck.changes}`)
  return { critiques, missingCritics: missingOf(critiques), ranOn, ranOnAgents }
}

const { scouts, planners } = args
checkList('scouts', scouts)
checkList('planners', planners)
if (planners.length > MAX_PLANNERS)
  throw new Error(`planners: at most ${MAX_PLANNERS}, split by domain`)
log(`agents: ${scouts.length} scouts, ${planners.length} planners, ${critics.length} critics (${scouts.length + planners.length + critics.length} in total)`)
log(ranOnLine(ROLES))

phase('Scout')
const reports = (await parallel(scouts.map(s => () =>
  agent(`${context}${requirements}${priorFindings}\n${READ_ONLY}\nSCOUT DOMAIN: ${s.brief}\nReturn a dense report (headings and bullets), at most about 900 words, facts with file:line citations, then a short "Implications for the plan" list. For anything you report as absent (no callers, no other uses), say how you searched; mark what you couldn't confirm as unconfirmed. A claim about a dependency's behaviour cites the installed package's code or types, or its official docs; else it is unconfirmed.`,
    { label: `scout:${s.key}`, phase: 'Scout', ...on(`scout:${s.key}`, capped(s.model || ROLES.scout.model, s.effort || ROLES.scout.effort)), ...(s.agentType ? { agentType: s.agentType } : {}) })
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
- checkpoints in build order, each a thin slice checkable on its own with a measurable "done when" (any prefactor first; a bug fix's checkpoint starting with a repro of the symptom and ending with the fix; a wide change as expand, migrate in batches, contract);
- every action that writes to a shared environment, a database, a service or git, marked "NEEDS APPROVAL";
- how it is deployed and rolled back, and what behaves differently after deploy;
- the tests, especially those that encode business or access rules, each with the seam it goes through.
Say exactly what you need from or give to the other planners. List the defaults you took. End with "Open questions" (only real decisions, at most 5, each with your recommendation), split into "for the user" and "for other stakeholders". At most about 1500 words.`,
    { label: `plan:${p.key}`, phase: 'Plan', ...on(`plan:${p.key}`, ROLES.planner) }).then(r => r && { key: p.key, plan: r })
}))).filter(Boolean)

// Don't review a plan with a hole in it: a missing domain would read as "nothing to say".
const missingPlanners = planners.filter(p => !plans.some(x => x.key === p.key)).map(p => p.key)
if (missingPlanners.length) {
  log(`missing plans: ${missingPlanners.join(', ')}; critique skipped, re-run those planners first`)
  return { reports, plans, missingScouts, missingPlanners, critiques: [], ranOn: ROLES, ranOnAgents }
}

phase('Critique')
const critiques = await critique(`Scout reports:\n\n${section('Scout report', reports, 'report')}\n\nThe plans:\n\n${section('Plan', plans, 'plan')}`)

log(`${reports.length + plans.length + critiques.length} agents returned`)
return { reports, plans, missingScouts, missingPlanners, critiques, missingCritics: missingOf(critiques), ranOn: ROLES, ranOnAgents }
