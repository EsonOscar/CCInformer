---
name: plan-feature-small
description: Fast planning for smaller tasks or a tighter token budget, with no review agent, then the build. In plan mode you scout the code yourself (at most two Explore helpers for ground too big to read), write down the requirements and draft the plan, then review it yourself against the code, lens by lens, in as many rounds as it needs (three at most); you ask the user only the real decisions, and write the same plan as plan-feature (checkpoints CCInformer's board shows); once approved, save it to .local/plans/ and build it yourself, checkpoint by checkpoint. Use when the user asks for a quick or light plan, or runs /ccinformer:plan-feature-small; for a large or risky change, suggest /ccinformer:plan-feature instead.
argument-hint: <task to plan>
---

Plan (small): $ARGUMENTS

"You" below is the main session. This is plan-feature without the agents: you do the scouting, the planning and the review yourself, so it stays fast and costs a fraction of the tokens. No second reader checks this plan, so if the task turns out to span several subsystems or carry real risk (data migrations, access rules, a shared environment), say so in one line and suggest `/ccinformer:plan-feature` before going on.

1. Plan mode must be on. If it isn't, stop and ask the user to switch to it (Shift+Tab until the bottom of the screen says plan mode), then run the command again.
2. Read what the task needs, and only that:
   - the project CLAUDE.md and its **planning settings**: a committed Planning section (a `## Planning` heading in CLAUDE.md, or `.claude/planning.md`), then the private `.local/ccinformer-planning.md`, which adds to it or overrides it. They give the project's checks, the extra critic lenses, which actions need approval, the commit, PR and docs rules, and where plans go. With neither, use the defaults here, and note what this run learns for step 8's finish;
   - the files the task touches, and the code they call or are called by, read in full where a decision rests on them;
   - the recent git log on those files.

   For ground too big to read in one go, you may run **at most two** Explore agents (`model: 'sonnet'`, read-only), each with one narrow question and a word limit. Check anything you build on against the code yourself. Keep a list of the files the plan touches: your review opens them again.
3. Write the **requirements** down, a few lines each: the goal and who it is for, measurable success criteria, and what is out of scope. What the user hasn't confirmed is marked as open.
4. Draft the whole plan into the plan file, so the review is of the real plan:
   - **Context**: why, what was asked, and how it was reviewed with what the review changed (filled in at step 7).
   - **Requirements and success criteria.**
   - **Decisions**: the user's, and the defaults taken.
   - **The contract**: the exact public names and signatures, the data shapes and the user-facing texts the change adds or changes.
   - **Checkpoints**, in build order, each with a measurable "done when". Define each where CCInformer's plan board (Work › Plans) finds it: its id at the start of a heading (`### CP1: title`), of a table row (`| CP1 | title | done when |`) or of a bold label (`- **CP1, title:**`), followed by punctuation. Ids look like `CP1`, `C1`, `R1` or `PR 1`. Its status goes on that same line, and nowhere else: nothing while open, `done` once its "done when" holds, `merged as #N` once its PR merges, `dropped` if abandoned.
   - **Approval gates**: every action that writes to a shared environment, a database, a service or git, marked "⚠ needs the user's OK", at the checkpoint where it happens.
   - **Verification**: the project's checks and the tests that encode the change's rules.
5. **Review the plan yourself.** No agent reviews this plan, so this step is the only review it gets. Do it as its adversary, not its author: assume the plan is wrong until the code says otherwise.
   - **Against the code, not from memory.** Open the files the plan touches again and check every name, signature, data shape, text and behaviour the plan relies on where it is defined. Something the plan relies on that you can't find in the code is a finding.
   - **Through each lens in turn:**
     - `correctness`: the plan against the actual code, edge cases, tests or invariants that could pass wrongly, YAGNI;
     - `fit`: whether the plan agrees with the existing code and the project rules (naming, structure, the docs that must change), and every mismatch in the shapes and names it uses;
     - `gaps`: what the plan leaves out from the requirements and the task, contradictions inside it, checkpoints that cannot be measured, and whether everything still builds and passes after each checkpoint;
     - then each of the planning settings' extra critic lenses.
   - **Each finding** is a blocker (would break, contradict the code or the requirements, or skip a needed approval), a should-fix or a nit, with its file and line where there is one. Fold the real ones into the plan file, and keep one line on each blocker and should-fix for Context.
   - **Rounds, by your judgement.** Go again when a round found a blocker or changed the contract, a checkpoint or a "done when": check those changes hardest, and whether a fix broke something else in the plan. Stop once a round changes nothing that matters. Three rounds at most: what is still open after the third is listed in the plan as open.

   If the review shows the task is larger or riskier than it looked, say so in one line and suggest `/ccinformer:plan-feature`.
6. Ask the real decisions with AskUserQuestion, the recommended option first; take defaults for the rest and list them in the plan. When an option adds scope, its description gives its size (small, medium, large, and why).
7. Finish the plan file:
   - **The answers' changes.** If the user's answers changed the requirements, decisions, contract, checkpoints, approval gates or verification after your last round, check those changes once, the same way: each one against the code, and whether it broke a cross-reference, another checkpoint or a "done when". What changes after that (such as feedback on ExitPlanMode) is named in Context as unreviewed.
   - In Context: "reviewed by the main session, N rounds; no agent reviewed it", then each blocker and should-fix in one line, with what changed, and every change made after the last check, unreviewed.
   - Read it through once as its builder (cross-references right, no placeholder left), then call ExitPlanMode.
8. Once the plan is approved, build it yourself, checkpoint by checkpoint, in the main session: the code, the tests and the docs.
   - **Plan files switch:** read `~/.claude/ccinformer/skills.json` (under `$CLAUDE_CONFIG_DIR` instead of `~/.claude` when that variable is set), for `planFiles` only. `"planFiles": false` means the user switched plan files off in CCInformer's Debug › Settings: skip the copy below and the planning-settings offer at the end, build from Claude Code's own plan file (the one you wrote in plan mode) and keep its checkpoint lines current there, and tell the user in one line that plan files are off, so Work › Plans won't show this plan. A missing file means on.
   - **Save the plan where the user can follow it:** copy the approved plan file to `.local/plans/<YYYY-MM-DD>-<slug>.md` from the project root (or the plans folder the planning settings name), where CCInformer's Work › Plans shows its checkpoints. From here on that copy is the plan you build from.
   - **`.local/` is written only where git ignores it:** before writing a file under the project's `.local/`, run `git check-ignore -q -- <its folder>/` from the project root (the folder with a trailing slash, for example `.local/plans/`). Exit 0 means git ignores it; anything else (1, or an error such as no git repo) means it doesn't, and nothing is written there. For the plan: when git doesn't ignore the plans folder under `.local/` (the default, or one the planning settings name), skip the copy, tell the user in one line that git doesn't ignore it and that adding `.local/` to `.gitignore` fixes it, and build from Claude Code's own plan file, keeping its checkpoint lines current there, as with plan files off. A plans folder the planning settings name outside `.local/` isn't under this rule: check it the same way, and if git doesn't ignore it, ask the user where to keep the plan instead, as it could otherwise get committed.
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
     - if the project had no planning settings (and plan files are on), offer once to save what this run learned as `.local/ccinformer-planning.md` (only if git ignores `.local/`, by the rule above): copy `planning-template.md` from the plan-feature skill's folder (`../plan-feature/` from this file), fill each section from the run, mark anything you guessed "(check)", and leave a section you know nothing about as its placeholder;
     - give the user the "Found outside the task" list, the manual test steps, and the files for their commit.
