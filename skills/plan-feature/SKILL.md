---
name: plan-feature
description: Multi-agent planning in plan mode, then the build. Scope inline (requirements, the project's planning settings, prior findings), run the plan-fanout workflow (read-only scouts, 1 to 3 domain planners, adversarial critics with structured findings), check every finding against the code yourself and fold in the real ones, ask the user only the real decisions, write the plan file with a fixed contract, checkpoints with exit criteria and approval gates; once approved, implement it yourself (code, tests and docs), with agents only for menial or quick tasks, or, when the plan splits into work packages, run them in waves through the build-fanout workflow (builder, read-only reviewer, one fix round per package) while you build the shared files and integrate. Use when the user asks to plan a feature or step "with a workflow", or runs /ccinformer:plan-feature.
argument-hint: <task to plan>
---

Plan: $ARGUMENTS

"You" below is the main session. The user doesn't read the scout, planner or critic output: you read it, check it, and bring the user only the decisions and a short account of what changed.

1. Plan mode must be on. If it isn't, stop and ask the user to switch to it. Workflow agents inherit plan mode, and that is what keeps them read-only. Plan mode's own Agent tool allows only 3 agents per phase, so the fan-out goes through the workflow below.
2. Scope inline first, just enough to name the domains:
   - the project CLAUDE.md and its **planning settings**: a committed Planning section (a `## Planning` heading in CLAUDE.md, or `.claude/planning.md`), then the private `.local/ccinformer-planning.md`, which adds to it or overrides it. They give the standing scouts, extra critic lenses, the project's checks (full, and scoped: fast checks on a few files), which actions need approval, the commit/PR/docs rules and where plans go. With neither, use the defaults here, and note what this run learns for step 9's finish;
   - the design and architecture docs (ADRs, module docs, specs): headings, then what the task touches;
   - the recent git log and the files the task touches;
   - research already done in this session or written down (reports, plans, explorer results): this becomes `priorFindings`, so the scouts verify it instead of redoing it.
3. Write the **requirements** down before any agent runs, a few lines each:
   - the goal, and who it is for (users, roles);
   - measurable success criteria;
   - deadline and stakeholders;
   - what is out of scope.

   What the user hasn't confirmed is marked as open.
4. Choose the agents:
   - Scouts: one per subsystem the task touches, plus the standing scouts from the planning settings. Add a scout only for ground no other scout covers. A scout can use another agent type (`agentType`), for example `claude-code-guide` for questions about Claude Code itself.
   - Models: scouts run on Sonnet at medium effort (the script's default), since the planners and critics check what they report against the code; planners and critics inherit this session's model and effort. Give a scout `model: 'opus', effort: 'high'` when the plan will rest on its report without anyone re-reading the code: proving something is absent across the codebase, access rules, migration safety.
   - Planners: 1 to 3. Their domains don't overlap and together cover the whole task: every file belongs to exactly one planner, and each brief says which.
   - Critics: the workflow's defaults (correctness, fit, gaps), plus the planning settings' lenses as `extraCritics`, plus a lens for any concrete risk (security and access rules, data or migration safety, performance, i18n or design system).
   - At most 10 agents per phase (the script refuses more). Respect the session's workflow size guideline. Tell the user the counts in one line before starting.
5. Read this skill's `plan-fanout.js` (next to this file) and run the Workflow tool with its whole content as `script` (a `scriptPath` only works for files inside the working directory or an added directory, so passing it inline works from any project), and args:
   `{ context, requirements, priorFindings?, scouts: [{key, brief, agentType?, model?, effort?}], planners: [{key, brief}], critics?, extraCritics?: [{key, focus}] }`.
   `context` holds: a map of the project (paths), the task as decided so far, and rules specific to this task. Don't paste CLAUDE.md rules: the agents get CLAUDE.md themselves.
   If the result lists `missingPlanners`, the critique was skipped: re-run those planners before going on.
6. Check the review yourself. The critics return structured findings (severity, claim, evidence, file and line, minimal fix). Don't trust them blindly:
   - check every blocker and should-fix against the code;
   - fold in the real ones and drop the wrong ones;
   - if a finding needs facts nobody gathered, run a small follow-up.

   If the fixes changed the plan substantially, run a re-check: the same script with `{ context, requirements, recheck: { plan, changes } }`, critics only. Write the revised plan into the plan file first and pass its path as `plan` ("Read the full revised plan at <path>, then verify it against the code"): the critics read it themselves, so the plan isn't pasted into every prompt. A change you make after the last re-check is folded in without another review; name it in the plan's Context.
7. Ask the real decisions with AskUserQuestion, the recommended option first.
   - Decisions for other stakeholders (a repo owner, a team) go in the plan as open questions; don't ask the user to answer for them.
   - Take defaults for the rest and list them in the plan.
   - When an option adds scope, its description gives its size (small, medium, large, and why). Scope the user adds that no planner covered gets a **follow-up**: ask its own decisions first, then one Plan agent with the settled contract and only the new scope, then fold its plan in, check it against the code like a critic's finding, and run the re-check from step 6 over the whole plan.
8. Write the plan file, with:
   - **Context**: why, what was asked, "planned with a workflow of N agents", the blockers the review found and how they were folded in (one line each), and what changed after the last re-check without another review (read those parts hardest while building).
   - **Requirements and success criteria**, as confirmed.
   - **The user's decisions**, the defaults taken, and the open questions for stakeholders.
   - **The contract**: the exact public names and signatures, the data contract (columns, constraints, access rules, API or JSON shapes, storage paths) and the user-facing texts (UI strings) that cross between domains. The planners' versions always disagree somewhere, so settle each one once here. This is what you build against, so nothing gets re-decided mid-build.
   - **Checkpoints**, in the project's order, each with a measurable "done when". Define each where CCInformer's plan board (Work › Plans) finds it: its id at the start of a heading (`### CP1: title`), of a table row (`| CP1 | title | done when |`) or of a bold label (`- **CP1, title:**`), followed by punctuation. Ids look like `CP1`, `C1`, `R1` or `PR 1`. Its status goes on that same line, and nowhere else: nothing while open, `done` once its "done when" holds, `merged as #N` once its PR merges, `dropped` if abandoned.
   - **Work packages**, only when the build splits into 2 or more substantial pieces with separate files (else write "built in the main session"):
     - checkpoint 0 is the contract in code (shared types, signatures, stubs, keys and texts), built by you, so the project compiles before any package starts;
     - per package: a key, the files it owns (no file in two packages), the part of the contract it implements, its "done when", and its wave (a package that needs another's output goes in a later wave; at most 3 per wave);
     - the **reserved files**: every file more than one package needs (the planners list them: barrels, route tables, translation tables, config, shared types), plus lockfiles and generated code. You build these; packages only say what they need there.
   - **Approval gates**: every action that writes to a shared environment, a database, a service or git, marked "⚠ needs the user's OK", at the checkpoint where it happens.
   - **Rollout**: how it is deployed (CI, migration order, functions), what behaves differently after deploy, how it is rolled back. This feeds the PR description.
   - **Commits and PRs**: which checkpoints become which commits and PRs, following the repo's commit and PR rules. Commits only when the user asks.
   - **How it gets built** (step 9): you build it, in checkpoint order, or in waves of work packages; name any menial tasks that go to background agents.
   - **Verification**: the project's checks, the tests that encode its business and access rules, and a before/after measurement when the task is about performance.

   Before calling ExitPlanMode, read the plan file through once as its builder: every cross-reference (step numbers, checkpoint numbers, section names) points at the right place and no placeholder is left. Then call ExitPlanMode.
9. Once the plan is approved, build it. **You do the implementing yourself**, checkpoint by checkpoint, in the main session: the code, the tests and the docs. A builder agent is much slower, and you already hold the plan and the review. The exception is a plan with work packages (below).
   - **Save the plan where the user can follow it:** copy the approved plan file to `.local/plans/<YYYY-MM-DD>-<slug>.md` from the project root (or the plans folder the planning settings name), where CCInformer's Work › Plans shows its checkpoints. First check that git ignores that path (`git check-ignore -q <path>`); if it doesn't, ask the user where to keep the plan instead, as it could otherwise get committed. From here on that copy is the plan you build from and keep current.
   - **Keep each checkpoint's line current** as you go: `done` once its "done when" holds, `merged as #N` once its PR merges, `dropped` if it's abandoned. A status written anywhere else (a status table, a note) doesn't reach the board.
   - **Order:** the shared code the contract describes first, then the rest, keeping everything compiling and the existing tests green. Run the project's checks after each checkpoint, and check its "done when". Docs last, so they quote real texts instead of guesses.
   - **Never weaken a check to get green:** don't loosen, skip or delete a test, assertion, lint rule or "done when" to make it pass. Fix the code; if the check itself is wrong, say so and why, and change it only as its own visible step.
   - **Found outside the task:** what you notice beyond the plan (a bug, a stale doc, a small optimisation) goes in a list for the user, one line each, not fixed in passing.
   - **Approval gates:** stop at each one and ask; an approval covers that action only.
   - **Git:** follow the user's and the project's git rules; never commit, push or open a PR unless the user asks at that moment.
   - **Work packages**, when the plan has them. All packages share this working tree; separate file lists and the reserved files are what keep them apart.
     - Build checkpoint 0 yourself and run the full checks once.
     - Per wave: snapshot the tree with `bash <this skill>/wave-snapshot.sh <scratch dir>/wave-<n>-before.txt` (bash: Git Bash on Windows) (read-only; hashes every file, so later changes are exact even in files that were already modified). Then read this skill's `build-fanout.js` and run the Workflow tool with its whole content as `script`, and args `{ context, plan: <plan file path>, wave, packages: [{key, brief, files, doneWhen, model?, effort?}], reserved, scopedChecks, snapshot: {script, baseline} }`. `context` is as in step 5; `scopedChecks` comes from the planning settings, or name the fastest checks that take file paths. Each package gets a builder, a read-only reviewer that checks it against the plan and git, and one fix round when the review asks for it.
     - While the wave runs, build the reserved files and what the packages will need there.
     - When it returns: for each package, read the review and check the fix yourself (the diff on its files, the scoped checks). Settle `blocked` and `escalated` packages yourself: decide, or ask the user if it's a real decision. Add what the packages listed under "needed in reserved". Run `bash <this skill>/wave-snapshot.sh --changed <baseline>`: a changed file outside every package's files and your reserved files is a stray; find out where it came from, and never revert a change you can't attribute.
     - Then run the full checks once for the wave, fix what they catch, and start the next wave.
   - **Agents only for menial or quick tasks** (outside work packages) that run in the background while you keep working: a mechanical rename across many files, a throwaway screenshot scene, a lookup. At most 10 at a time, each owning its files, so no file is held by two at once. Run them with `model: 'sonnet'` and `effort: 'medium'`; keep this session's model for one that needs judgment.
   - **Each agent brief gives:**
     - the plan path and the section the agent owns;
     - the files it owns, and that it must not touch others;
     - "read the actual code, not this summary";
     - if the contract or API lacks something, stop and report rather than edit outside its files;
     - the project's checks to run, and that it never loosens, skips or deletes a test or check to make it pass (a check that looks wrong is reported, not changed);
     - git is read-only: no commit, push, stash, checkout, restore, reset, clean or branch switch, since the working tree holds other uncommitted work that these would roll back;
     - anything it notices outside its task goes under "Found outside the task" in the report, one line each (`path: what`), not fixed;
     - a short report with a word limit, covering deviations from the contract, the exact texts, and the files it changed.
   - **Check each agent against git, not its report:** before it starts, note `git status --short`; when it returns, run `git status --short` and `git diff` on its files. A file it reports as changed that git shows unchanged, a change outside its files that neither you nor another agent made, or a weakened test sends the work back with the reason.
   - **Finish:**
     - run all builds and tests once more;
     - check the docs' quoted texts against the code;
     - make sure throwaway files are deleted;
     - every checkpoint's line in the saved plan says how it ended (`merged as #N`, `done`, `dropped`); CCInformer's board then offers to archive the plan, so leave it in place rather than deleting it;
     - if the project had no planning settings, offer once to save what this run learned as `.local/ccinformer-planning.md` (only if git ignores it): copy `planning-template.md` from this skill's folder, fill each section from the run (the checks you ran, the scouts you used, the approvals you hit, the commit and PR rules you followed), mark anything you guessed "(check)", leave a section you know nothing about as its placeholder, and tell the user in one line that the next plan in this repo starts from it;
     - give the user the "Found outside the task" list (yours and the agents'), deduplicated;
     - record the decisions where the project keeps its history (an ADR for an architecture change, the module doc, the PR description);
     - give the user the manual test steps, the files for their commit, and a draft PR description if a PR is planned.
