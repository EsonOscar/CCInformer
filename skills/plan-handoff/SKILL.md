---
name: plan-handoff
description: Multi-agent planning for someone who isn't a developer, ending in a handoff doc instead of a build. Same fan-out as plan-feature (read-only scouts, 1 to 3 domain planners, adversarial critics, every finding checked against the code), with the user asked only product decisions in plain words, technical choices left for the developer, and the approved plan written as a .md file a developer builds from, closing with how it was planned. Use when the user wants a feature planned for a developer to build later, or runs /ccinformer:plan-handoff.
argument-hint: <feature to plan>
---

Plan for a developer: $ARGUMENTS

"You" below is the main session. The **user** is not a developer: they know what the feature should do and who it is for, not how the code works. The **developer** builds it later, in a new session, from the doc this skill writes. The user doesn't read the scout, planner or critic output: you read it, check it, and bring the user only the product decisions, in plain words.

1. Plan mode must be on. If it isn't, stop and ask the user to switch to it: press Shift+Tab until the bottom of the screen says plan mode, then run the command again. Workflow agents inherit plan mode, and that is what keeps them read-only.
2. Scope inline first, just enough to name the domains:
   - the project CLAUDE.md and its **planning settings**: a committed Planning section (a `## Planning` heading in CLAUDE.md, or `.claude/planning.md`), then the private `.local/ccinformer-planning.md`, which adds to it or overrides it. They give the standing scouts, extra critic lenses, the project's checks, which actions need approval, the docs rules and where plans and handoff docs go. With neither, use the defaults here, and note what this run learns for step 9;
   - the design and architecture docs (ADRs, module docs, specs): headings, then what the task touches;
   - the recent git log and the files the task touches; note the branch and `git rev-parse --short HEAD`, the commit this plan is made against (a repo with no commits yet: record "no commits yet" and the date instead);
   - research already done in this session or written down: this becomes `priorFindings`, so the scouts verify it instead of redoing it.
3. Write the **requirements** down before any agent runs, a few lines each. The user is the source here: ask them in plain words for what is missing.
   - the goal, and who it is for (users, roles);
   - measurable success criteria (what a user can do afterwards that they can't now);
   - deadline and stakeholders;
   - what is out of scope.

   What the user hasn't confirmed is marked as open.
4. Choose the agents:
   - Scouts: one per subsystem the task touches, plus the standing scouts from the planning settings. Add a scout only for ground no other scout covers. A scout can use another agent type (`agentType`).
   - Models: scouts run on Sonnet at medium effort (the script's default), since the planners and critics check what they report against the code; planners and critics inherit this session's model and effort. Give a scout `model: 'opus', effort: 'high'` when the plan will rest on its report without anyone re-reading the code: proving something is absent across the codebase, access rules, migration safety.
   - Planners: 1 to 3. Their domains don't overlap and together cover the whole task: every file belongs to exactly one planner, and each brief says which.
   - Critics: the workflow's defaults (correctness, fit, gaps), plus the planning settings' lenses as `extraCritics`, plus a lens for any concrete risk (security and access rules, data or migration safety, performance, i18n or design system).
   - At most 10 agents per phase (the script refuses more). Respect the session's workflow size guideline. Tell the user the counts in one plain line before starting.
5. Read `plan-fanout.js` from the plan-feature skill's folder (`../plan-feature/plan-fanout.js` from this file; both skills share it) and run the Workflow tool with its whole content as `script` (a `scriptPath` only works for files inside the working directory or an added directory, so passing it inline works from any project), and args:
   `{ context, requirements, priorFindings?, scouts: [{key, brief, agentType?, model?, effort?}], planners: [{key, brief}], critics?, extraCritics?: [{key, focus}] }`.
   `context` holds: a map of the project (paths), the task as decided so far, rules specific to this task, and this audience rule, verbatim: "The person planning is not a developer. Under 'for the user', ask only product questions (what it does, for whom, the wording users see, what users see in edge cases), in plain words. Put technical choices under 'for other stakeholders' as questions for the developer, each with your recommendation." Don't paste CLAUDE.md rules: the agents get CLAUDE.md themselves.
   If the result lists `missingPlanners`, the critique was skipped: re-run those planners before going on.
6. Check the review yourself. The critics return structured findings (severity, claim, evidence, file and line, minimal fix). Don't trust them blindly:
   - check every blocker and should-fix against the code;
   - fold in the real ones and drop the wrong ones, keeping a one-line reason for each dropped one;
   - if a finding needs facts nobody gathered, run a small follow-up.

   If the fixes changed the plan substantially, run a re-check: the same script with `{ context, requirements, recheck: { plan, changes } }`, critics only. Write the revised plan into the plan file first and pass its path as `plan` ("Read the full revised plan at <path>, then verify it against the code"): the critics read it themselves, so the plan isn't pasted into every prompt. A change you make after the last re-check is folded in without another review; name it under "Not re-reviewed" in the doc's last section. Keep the tally (agents per phase, findings checked, folded in, dropped) for that section too.
7. Ask the user the **product decisions** with AskUserQuestion: what the feature does, for whom, the wording users see, what users see in edge cases. Plain words, no file names or code terms; the recommended option first; each option's description says what it means for the people using the feature.
   - Technical choices (data model, structure, libraries, migrations): take the recommended option and mark it "dev to confirm" in the doc.
   - Decisions for other stakeholders (a repo owner, a team) go in the doc as open questions; don't ask the user to answer for them.
   - When an option adds scope, its description gives its size in plain words (small, medium, large, and why). Scope the user adds that no planner covered gets a **follow-up**: ask its own product questions first, then one Plan agent with the settled contract and only the new scope, then fold its plan in, check it against the code like a critic's finding, and run the re-check from step 6 over the whole plan.
8. Write the handoff into the plan file, with:
   - **Summary**, for the user, in plain words, about five lines: what gets built, for whom, what changes for them. This is the part the user approves.
   - **Context**: why, what was asked, and the blockers the review found and how they were folded in (one line each).
   - **Requirements and success criteria**, as confirmed.
   - **Decisions**: the user's product decisions; the technical defaults, each marked "dev to confirm"; the open questions for the developer and other stakeholders.
   - **The contract**: the exact public names and signatures, the data contract (columns, constraints, access rules, API or JSON shapes, storage paths) and the user-facing texts (UI strings) that cross between domains. The planners' versions always disagree somewhere, so settle each one once here, so the developer builds against it instead of re-deciding it.
   - **Checkpoints**, in the project's order, each with a measurable "done when". Define each where CCInformer's plan board (Work › Plans) finds it: its id at the start of a heading (`### CP1: title`), of a table row (`| CP1 | title | done when |`) or of a bold label (`- **CP1, title:**`), followed by punctuation, with nothing after it while it's open; the developer marks it on that same line (`done`, `merged as #N`, `dropped`). Close the section with these lines, verbatim: "For commit and PR styles, refer to repo guidelines." and "While building: never loosen, skip or delete a test or check to make it pass (fix the code, or flag a wrong check as its own change); anything noticed outside this plan goes in a 'Found outside the plan' list for the PR, not fixed in passing; any agents helping get git read-only (no commit, push, stash, checkout, restore, reset, clean or branch switch), and their reported changes are checked against `git status` and `git diff`, not taken on trust."
   - **Work packages**, only when the build splits into 2 or more substantial pieces with separate files (else leave the section out): checkpoint 0 is the contract in code (shared types, signatures, stubs, keys and texts), so the project compiles before any package starts; per package a key, the files it owns (no file in two packages), the part of the contract it implements, its "done when", and its wave (a package that needs another's output goes in a later wave); and the reserved files every package may need (barrels, route tables, translation tables, config, shared types, lockfiles, generated code), which the developer builds themselves. The packages can be built one by one or in parallel, for example with /ccinformer:plan-feature's build waves.
   - **Approval gates**: every action that writes to a shared environment, a database, a service or git, marked "⚠ needs approval", at the checkpoint where it happens.
   - **Rollout**: how it is deployed (CI, migration order, functions), what behaves differently after deploy, how it is rolled back.
   - **Verification**: the project's checks, the tests that encode its business and access rules, the manual test steps the user can run to accept the feature, and a before/after measurement when the task is about performance.
   - **How this was planned**, last and tiny, at most about 10 lines:
     - "Planned with /ccinformer:plan-handoff (the planning half of /ccinformer:plan-feature) on <date>, against <branch> @ <commit>."
     - Agents, one line: "Scout N (keys) · Plan N (domains) · Critique N (lenses)", plus follow-ups and re-checks if any ran; agent types only where not the default.
     - Review, one line: findings checked, folded in, dropped; then one short line per dropped blocker or should-fix saying why, so the building session doesn't raise it again.
     - Notes for the building session, at most four short lines: what was read in the code and what is assumed; anything under "Not re-reviewed" (step 6); the "dev to confirm" items to settle first and the files to read first; check `git log <commit>..HEAD` on the touched paths for drift, then build checkpoint by checkpoint, or start with /ccinformer:plan-feature, passing this doc as the prior findings.

   Before calling ExitPlanMode, read the plan file through once as the developer would: every cross-reference (step numbers, checkpoint numbers, section names) points at the right place, no placeholder is left, and the Summary matches the decisions. Then call ExitPlanMode.
9. Once the user approves, write the doc and finish. The build belongs to the developer's session, so your work ends with the file.
   - Path: the handoff folder the planning settings name, else `docs/plans/<YYYY-MM-DD>-<feature-slug>.md` from the project root. Look before overwriting an existing file.
   - Content: the approved plan file, unchanged.
   - Git stays with the user: leave the file uncommitted.
   - Tell the user the path, what's in the doc in two lines, and that it is ready to send to the developer.
   - If the project had no planning settings, offer once to save what this run learned as `.local/ccinformer-planning.md` (only if git ignores it): copy `planning-template.md` from the plan-feature skill's folder (`../plan-feature/` from this file), fill each section from the run (the project's checks, the scouts you used, the approvals the plan needs), mark anything you guessed "(check)", and leave a section you know nothing about as its placeholder.
