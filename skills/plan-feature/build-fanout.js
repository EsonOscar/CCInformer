export const meta = {
  name: 'build-fanout',
  description: 'One build wave: per work package a builder, a read-only reviewer against the plan, and one fix round',
  whenToUse: 'Run by the CCInformer plan-feature skill in step 9, once per wave, with args {context, plan, wave, packages: [{key, brief, files, doneWhen, model?, effort?}], reserved, scopedChecks, snapshot: {script, baseline}}',
  phases: [
    { title: 'Build', detail: 'one builder per package, own files only' },
    { title: 'Review', detail: 'read-only check of each package against the plan and git' },
    { title: 'Fix', detail: 'one fix round for packages the review sent back' },
  ],
}

// The packages share one working tree, so they never share a file: each owns its files, and every file more than
// one package needs is reserved for the main session. At most 3 packages (up to 9 agents with a fix round each).
const MAX_PACKAGES = 3

const GIT_RULES = 'Git is read-only for you: no commit, push, stash, checkout, restore, reset, clean or branch switch. The working tree holds other uncommitted work, including the other packages being built right now, and those commands would roll it back.'
const CHECK_RULES = 'Never loosen, skip or delete a test, assertion, lint rule or check to make it pass. If a check looks wrong, report it instead of changing it. A failing check in a file you do not own is not yours: report it, do not touch it.'
const SHARED_RULES = 'Do not install or update dependencies, touch lockfiles, run code generation, or format anything beyond your own files.'

const DEVIATION = {
  type: 'object',
  properties: { what: { type: 'string' }, why: { type: 'string' } },
  required: ['what', 'why'],
}
const CHECK_RUN = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    passed: { type: 'boolean' },
    note: { type: 'string', description: 'For a failure: the failing test or error, briefly' },
  },
  required: ['command', 'passed'],
}
const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Every file you created, changed or deleted, repo-relative' },
    deviations: { type: 'array', items: DEVIATION, description: 'Every place you did something other than the plan and contract say' },
    checksRun: { type: 'array', items: CHECK_RUN },
    neededInReserved: {
      type: 'array',
      items: { type: 'object', properties: { file: { type: 'string' }, what: { type: 'string' } }, required: ['file', 'what'] },
      description: 'What the main session must add to a reserved file for this package to work',
    },
    foundOutsideTask: { type: 'array', items: { type: 'string' }, description: 'One line each, "path: what"; noticed, not fixed' },
    blocked: { type: 'string', description: 'If you stopped: what the plan or contract lacks. Empty when not blocked' },
    summary: { type: 'string', description: 'At most three sentences' },
  },
  required: ['changedFiles', 'deviations', 'checksRun', 'neededInReserved', 'foundOutsideTask', 'blocked', 'summary'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix', 'escalate'], description: 'escalate = fixing it needs a decision or a contract change' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'should-fix', 'nit'] },
          kind: { type: 'string', enum: ['false-claim', 'outside-files', 'weakened-check', 'contract', 'done-when', 'unlisted-deviation', 'scope-creep', 'other'] },
          claim: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          evidence: { type: 'string', description: 'The code, diff or command output that shows it (quote briefly)' },
          minimalFix: { type: 'string' },
        },
        required: ['severity', 'kind', 'claim', 'evidence', 'minimalFix'],
      },
    },
    checksRun: { type: 'array', items: CHECK_RUN },
    summary: { type: 'string', description: 'At most three sentences' },
  },
  required: ['verdict', 'findings', 'checksRun', 'summary'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, how: { type: 'string' } }, required: ['finding', 'how'] } },
    notFixed: { type: 'array', items: { type: 'object', properties: { finding: { type: 'string' }, why: { type: 'string' } }, required: ['finding', 'why'] } },
    changedFiles: { type: 'array', items: { type: 'string' } },
    checksRun: { type: 'array', items: CHECK_RUN },
    summary: { type: 'string', description: 'At most three sentences' },
  },
  required: ['fixed', 'notFixed', 'changedFiles', 'checksRun', 'summary'],
}

const { context, plan, wave, packages, scopedChecks, snapshot } = args
const reserved = args.reserved || []
if (!Array.isArray(packages) || packages.length < 1 || packages.length > MAX_PACKAGES)
  throw new Error(`packages: need 1 to ${MAX_PACKAGES} per wave`)
if (!plan || !snapshot?.script || !snapshot?.baseline)
  throw new Error('plan and snapshot {script, baseline} are required')
packages.forEach(p => {
  if (!p.key || !p.brief || !Array.isArray(p.files) || !p.files.length || !p.doneWhen)
    throw new Error(`package ${p.key || '?'}: needs key, brief, files and doneWhen`)
})
log(`wave ${wave}: ${packages.length} packages (${packages.map(p => p.key).join(', ')})`)

const list = items => items.map(f => `- ${f}`).join('\n') || '- (none)'
const othersOf = p => packages.filter(o => o !== p).map(o => `${o.key}:\n${list(o.files)}`).join('\n') || '(none)'
const spec = p => `${context}

The approved plan is at ${plan}. Read it in full, especially the contract and your package; build against what the code actually contains, not against this summary.

YOUR PACKAGE (${p.key}, wave ${wave}): ${p.brief}
Done when: ${p.doneWhen}

The files you own (only these may change):
${list(p.files)}

Owned by the other packages in this wave (being built at the same time; never touch):
${othersOf(p)}

Reserved for the main session (never touch; say what you need there under neededInReserved):
${list(reserved)}

Scoped checks (fast checks on your own files; never the project's full checks): ${scopedChecks || 'the fastest checks that take file paths: the linter, the test runner on your test files, the type checker where it can be limited to your files'}`

const build = p => agent(`${spec(p)}

You are the BUILDER of this package.
- ${GIT_RULES}
- ${CHECK_RULES}
- ${SHARED_RULES}
- If the plan or contract lacks something you need, or getting it right needs a file you don't own, stop and say so under blocked rather than deciding it yourself or editing outside your files.
- Anything you notice outside your task goes under foundOutsideTask, one line each; don't fix it.
- List every deviation from the plan and contract, however small; an unlisted one found in review sends the package back.
- Run the scoped checks before you finish and report them truthfully.`,
  { label: `build:${p.key}`, phase: 'Build', schema: BUILD_SCHEMA, ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) })

const review = (p, built) => agent(`${spec(p)}

You are the REVIEWER of this package. You are read-only: do not create, edit or delete any file. You may run read-only git commands and the scoped checks. ${GIT_RULES}

The builder's report:
${JSON.stringify(built, null, 2)}

Check, in this order:
1. What changed: run \`bash "${snapshot.script}" --changed "${snapshot.baseline}"\` from the repo. It lists every file changed since the wave began, including other packages' files and the main session's reserved files (ignore both). A file the builder lists that is not in that output is a false claim. A file in that output that matches this package's owned files but the builder did not list is an unlisted change. Read the changes in the owned files (\`git diff\` on them, keeping in mind they may have had uncommitted changes before the wave).
2. Weakened checks: tests, assertions, lint rules or checks in the changed files that were loosened, skipped or deleted.
3. The contract: every name, signature, data shape and user-facing text the plan's contract settles for this package, against the code as it now is.
4. Done when: whether it is met; run the scoped checks yourself.
5. Deviations the builder didn't list, and work beyond the package (scope creep).

Assume the package is wrong until the code says otherwise, but report only what you can show. verdict: pass (no blocker or should-fix), fix (fixable within the owned files), escalate (needs a decision, a contract change or a reserved file).`,
  { label: `review:${p.key}`, phase: 'Review', schema: REVIEW_SCHEMA })

const fix = (p, built, reviewed) => agent(`${spec(p)}

You are fixing this package after review. Fix exactly these findings, nothing else, within the owned files:
${JSON.stringify(reviewed.findings.filter(f => f.severity !== 'nit'), null, 2)}

The builder's report, for context:
${JSON.stringify(built, null, 2)}

- ${GIT_RULES}
- ${CHECK_RULES}
- ${SHARED_RULES}
- A finding you disagree with or can't fix within the owned files goes under notFixed with the reason.
- Run the scoped checks before you finish and report them truthfully.`,
  { label: `fix:${p.key}`, phase: 'Fix', schema: FIX_SCHEMA, ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) })

const results = await pipeline(packages,
  p => build(p).then(built => ({ key: p.key, built })),
  (r, p) => (!r.built || r.built.blocked) ? r : review(p, r.built).then(reviewed => ({ ...r, reviewed })),
  (r, p) => r.reviewed?.verdict === 'fix' ? fix(p, r.built, r.reviewed).then(fixed => ({ ...r, fixed })) : r,
)

const done = results.filter(Boolean)
const missing = packages.filter(p => !done.some(r => r.key === p.key && r.built)).map(p => p.key)
const blocked = done.filter(r => r.built?.blocked).map(r => r.key)
const escalated = done.filter(r => r.reviewed?.verdict === 'escalate').map(r => r.key)
if (missing.length) log(`no build result: ${missing.join(', ')}`)
if (blocked.length) log(`blocked: ${blocked.join(', ')}`)
if (escalated.length) log(`escalated by review: ${escalated.join(', ')}`)
return { wave, results: done, missing, blocked, escalated }
