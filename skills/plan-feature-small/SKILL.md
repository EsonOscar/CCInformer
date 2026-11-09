---
name: plan-feature-small
description: Fast planning for smaller tasks or a tighter token budget, then the build. In plan mode you scout the code yourself (at most two Explore helpers for ground too big to read), write down the requirements and draft the plan, then one critic agent (Opus, medium effort) reviews it against the code in a short workflow, with a second round only after a blocker and a final check of what you changed after the last review; you check its findings, ask the user only the real decisions, and write the same plan as plan-feature (checkpoints CCInformer's board shows); once approved, save it to .local/plans/ and build it yourself, checkpoint by checkpoint. Use when the user asks for a quick or light plan, or runs /ccinformer:plan-feature-small; for a large or risky change, suggest /ccinformer:plan-feature instead.
argument-hint: <task to plan>
---

Plan (small): $ARGUMENTS

"You" below is the main session. This is plan-feature without the fan-out: you do the scouting and the planning yourself, and one critic agent reviews the plan, so it stays fast and costs a fraction of the tokens. If the task turns out to span several subsystems or carry real risk (data migrations, access rules, a shared environment), say so in one line and suggest `/ccinformer:plan-feature` before going on.

1. Plan mode must be on. If it isn't, stop and ask the user to switch to it (Shift+Tab until the bottom of the screen says plan mode), then run the command again.
2. Read what the task needs, and only that:
   - the project CLAUDE.md and its **planning settings**: a committed Planning section (a `## Planning` heading in CLAUDE.md, or `.claude/planning.md`), then the private `.local/ccinformer-planning.md`, which adds to it or overrides it. They give the project's checks, the extra critic lenses, which actions need approval, the commit, PR and docs rules, and where plans go. With neither, use the defaults here, and note what this run learns for step 9's finish;
   - the files the task touches, and the code they call or are called by, read in full where a decision rests on them;
   - the recent git log on those files.

   For ground too big to read in one go, you may run **at most two** Explore agents (`model: 'sonnet'`, read-only), each with one narrow question and a word limit. Check anything you build on against the code yourself. Keep a list of the files the plan touches: the critic reads those first.
3. Write the **requirements** down, a few lines each: the goal and who it is for, measurable success criteria, and what is out of scope. What the user hasn't confirmed is marked as open.
4. Draft the whole plan into the plan file, so the critic reviews the real plan:
   - **Context**: why, what was asked, "reviewed by one critic (plan-review.js)", and what the review changed (filled in at step 8).
   - **Requirements and success criteria.**
   - **Decisions**: the user's, and the defaults taken.
   - **The contract**: the exact public names and signatures, the data shapes and the user-facing texts the change adds or changes.
   - **Checkpoints**, in build order, each with a measurable "done when". Define each where CCInformer's plan board (Work › Plans) finds it: its id at the start of a heading (`### CP1: title`), of a table row (`| CP1 | title | done when |`) or of a bold label (`- **CP1, title:**`), followed by punctuation. Ids look like `CP1`, `C1`, `R1` or `PR 1`. Its status goes on that same line, and nowhere else: nothing while open, `done` once its "done when" holds, `merged as #N` once its PR merges, `dropped` if abandoned.
   - **Approval gates**: every action that writes to a shared environment, a database, a service or git, marked "⚠ needs the user's OK", at the checkpoint where it happens.
   - **Verification**: the project's checks and the tests that encode the change's rules.
5. **Review, round 1.** Read `plan-review.js` (next to this file) and run the Workflow tool with its whole content as `script` (a `scriptPath` only works for files inside the working directory, so passing it inline works from any project), and args:
   `{ context, requirements, plan, files, round: 1, lenses? }`
   - `context`: a map of the project (paths), the task as decided so far, and rules specific to this task (not CLAUDE.md's rules: the critic gets CLAUDE.md itself);
   - `requirements`: step 3's text;
   - `plan`: the plan file's absolute path;
   - `files`: the files the plan touches, 1 to 30;
   - `lenses`: the planning settings' extra critic lenses as `[{key, focus}]`, at most 3, lowercase keys other than `correctness`, `fit` and `gaps`.

   The critic runs on Opus at medium effort, reads the plan and those files, and returns a section per lens with the files it checked and its findings. While it runs, carry on with anything the review won't change.
6. **Check the review yourself.** Don't trust it blindly: check every blocker and should-fix against the code, fold the real ones into the plan file, and drop the wrong ones. If the result says `needsRound2` (round 1 found a blocker), run the same script once more with `round: 2` and `previous: { findings, changes }`: round 1's findings and what you changed. There is never a third round (step 8's final check looks only at what changed after it): what round 2 finds is folded in, or listed in the plan as open. If the result has an `error`, run that round again once.
7. Ask the real decisions with AskUserQuestion, the recommended option first; take defaults for the rest and list them in the plan. When an option adds scope, its description gives its size (small, medium, large, and why).
8. Finish the plan file:
   - **Final check.** If the plan changed since the last review, run the same script once more with `round: 'final'`, `changes` and `files`. A change is anything in the requirements, decisions, contract, checkpoints, approval gates or verification since the last round (findings folded in, the user's answers), not Context's account of the review; list each in `changes`, one per line, pass the files they touch as `files`, and keep only the extra `lenses` the changes touch. Check its blockers and should-fixes against the code and fold in the real ones; no round 2 follows it. If it returns an `error`, run it once more; if that fails too, say so in Context. Skip it when nothing changed. It runs at most once: what changes after it, or after a skipped one (such as feedback on ExitPlanMode), is named in Context as unreviewed.
   - In Context: "reviewed by one critic (plan-review.js), N rounds and a final check" (or "..., N rounds; nothing changed after the last round, no final check"), then each blocker and should-fix in one line, kept (and what changed) or dropped (and why), and every change made after the final check, unreviewed.
   - Read it through once as its builder (cross-references right, no placeholder left), then call ExitPlanMode.
9. Once the plan is approved, build it yourself, checkpoint by checkpoint, in the main session: the code, the tests and the docs.
   - **Plan files switch:** read `~/.claude/ccinformer/skills.json` (under `$CLAUDE_CONFIG_DIR` instead of `~/.claude` when that variable is set). `"planFiles": false` means the user switched plan files off in CCInformer's Debug › Settings: skip the copy below and the planning-settings offer at the end, build from Claude Code's own plan file (the one you wrote in plan mode) and keep its checkpoint lines current there, and tell the user in one line that plan files are off, so Work › Plans won't show this plan. A missing file means on.
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
     - if the project had no planning settings (and plan files are on), offer once to save what this run learned as `.local/ccinformer-planning.md` (only if git ignores it): copy `planning-template.md` from the plan-feature skill's folder (`../plan-feature/` from this file), fill each section from the run, mark anything you guessed "(check)", and leave a section you know nothing about as its placeholder;
     - give the user the "Found outside the task" list, the manual test steps, and the files for their commit.
