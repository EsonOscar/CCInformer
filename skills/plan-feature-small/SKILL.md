---
name: plan-feature-small
description: Planning without a workflow, for smaller tasks or a tighter token budget, then the build. In plan mode you scout the code yourself (at most two Explore helpers for ground too big to read), write down the requirements, review your own plan against the code through three lenses (correctness, fit, gaps), ask the user only the real decisions, and write the same plan as plan-feature (checkpoints CCInformer's board shows); once approved, save it to .local/plans/ and build it yourself, checkpoint by checkpoint. Use when the user asks for a quick or light plan, or runs /ccinformer:plan-feature-small; for a large or risky change, suggest /ccinformer:plan-feature instead.
argument-hint: <task to plan>
---

Plan (small): $ARGUMENTS

"You" below is the main session. This is plan-feature without the agent fan-out: you do the scouting and the review yourself, so it costs a fraction of the tokens. If the task turns out to span several subsystems or carry real risk (data migrations, access rules, a shared environment), say so in one line and suggest `/ccinformer:plan-feature` before going on.

1. Plan mode must be on. If it isn't, stop and ask the user to switch to it (Shift+Tab until the bottom of the screen says plan mode), then run the command again.
2. Read what the task needs, and only that:
   - the project CLAUDE.md and its **planning settings**: a committed Planning section (a `## Planning` heading in CLAUDE.md, or `.claude/planning.md`), then the private `.local/ccinformer-planning.md`, which adds to it or overrides it. They give the project's checks, which actions need approval, the commit, PR and docs rules, and where plans go. With neither, use the defaults here, and note what this run learns for step 7's finish;
   - the files the task touches, and the code they call or are called by, read in full where a decision rests on them;
   - the recent git log on those files.

   For ground too big to read in one go, you may run **at most two** Explore agents (`model: 'sonnet'`, read-only), each with one narrow question and a word limit. Check anything you build on against the code yourself.
3. Write the **requirements** down, a few lines each: the goal and who it is for, measurable success criteria, and what is out of scope. What the user hasn't confirmed is marked as open.
4. Draft the plan, then **review it yourself against the code**, once per lens, as an adversarial critic would:
   - correctness: every signature and behaviour the plan assumes, read in the code; edge cases; tests that could pass wrongly;
   - fit: the project's rules and naming, the existing code it must agree with, the docs that must change;
   - gaps: what the requirements ask that no checkpoint covers, and whether everything still builds and passes after each checkpoint.

   Fix what you find. If a finding needs a decision, it goes to step 5.
5. Ask the real decisions with AskUserQuestion, the recommended option first; take defaults for the rest and list them in the plan. When an option adds scope, its description gives its size (small, medium, large, and why).
6. Write the plan file, with:
   - **Context**: why, what was asked, "planned without a workflow", and what the review changed (one line each).
   - **Requirements and success criteria**, as confirmed.
   - **Decisions**: the user's, and the defaults taken.
   - **The contract**: the exact public names and signatures, the data shapes and the user-facing texts the change adds or changes.
   - **Checkpoints**, in build order, each with a measurable "done when". Define each where CCInformer's plan board (Work › Plans) finds it: its id at the start of a heading (`### CP1: title`), of a table row (`| CP1 | title | done when |`) or of a bold label (`- **CP1, title:**`), followed by punctuation. Ids look like `CP1`, `C1`, `R1` or `PR 1`. Its status goes on that same line, and nowhere else: nothing while open, `done` once its "done when" holds, `merged as #N` once its PR merges, `dropped` if abandoned.
   - **Approval gates**: every action that writes to a shared environment, a database, a service or git, marked "⚠ needs the user's OK", at the checkpoint where it happens.
   - **Verification**: the project's checks and the tests that encode the change's rules.

   Read it through once as its builder (cross-references right, no placeholder left), then call ExitPlanMode.
7. Once the plan is approved, build it yourself, checkpoint by checkpoint, in the main session: the code, the tests and the docs.
   - **Save the plan where the user can follow it:** copy the approved plan file to `.local/plans/<YYYY-MM-DD>-<slug>.md` from the project root (or the plans folder the planning settings name), where CCInformer's Work › Plans shows its checkpoints. First check that git ignores that path (`git check-ignore -q <path>`); if it doesn't, ask the user where to keep the plan instead. From here on that copy is the plan you build from.
   - **Keep each checkpoint's line current** as you go (`done`, `merged as #N`, `dropped`). A status written anywhere else doesn't reach the board.
   - Run the project's checks after each checkpoint and check its "done when". Docs last, so they quote real texts.
   - **Never weaken a check to get green:** don't loosen, skip or delete a test, assertion, lint rule or "done when" to make it pass. Fix the code, or say why the check is wrong and change it as its own visible step.
   - **Found outside the task:** what you notice beyond the plan goes in a list for the user, one line each, not fixed in passing.
   - **Approval gates:** stop at each one and ask; an approval covers that action only.
   - **Git:** follow the user's and the project's git rules; never commit, push or open a PR unless the user asks at that moment.
   - **Finish:**
     - run all builds and tests once more;
     - make sure throwaway files are deleted;
     - every checkpoint's line in the saved plan says how it ended; CCInformer's board then offers to archive the plan, so leave it in place;
     - if the project had no planning settings, offer once to save what this run learned as `.local/ccinformer-planning.md` (only if git ignores it): copy `planning-template.md` from the plan-feature skill's folder (`../plan-feature/` from this file), fill each section from the run, mark anything you guessed "(check)", and leave a section you know nothing about as its placeholder;
     - give the user the "Found outside the task" list, the manual test steps, and the files for their commit.
