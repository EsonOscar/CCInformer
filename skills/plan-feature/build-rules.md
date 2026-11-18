# Build rules

Shared by plan-feature and plan-feature-small once a plan is approved. Read it when the build starts and follow it to the finish; the skill's own step adds what is specific to it.

## Before the first checkpoint

- **Base check:** compare the plan's Base line with `git rev-parse --short HEAD` and `git status --short`, and list what moved in the files the plan touches with `git diff --name-only <base commit> -- <those files>` (with no base commit, compare `git status --short` only). Re-read each moved file, and tell the user in one line before building on it. Do this again when a build resumes, counting only changes that no checkpoint of this build made (the user's commits of this build's work included).

## While building

- **Keep each checkpoint's line current:** `done` once its "done when" holds, `merged as #N` once its PR merges, `dropped` if it's abandoned. A status written anywhere else (a status table, a note) doesn't reach the board. To the user, name a checkpoint by its id and title.
- **After each checkpoint,** run the project's checks and check its "done when". Docs last, so they quote real texts.
- **Decisions made while building** (an escalation settled, a contract point changed, a deviation accepted) go into the plan you build from at once, under a `## Build decisions` heading, one line each: `Decision (<checkpoint id>): what and why`. Never start the line with the checkpoint id.
- **Tests first for rules:** each rule a "done when" rests on gets its test at the plan's seam, seen failing before its code, one test then its code. A new guard (a lint rule, a check) is seen catching one injected violation; undo the injection by editing it back, never through git, and see it pass again.
- **Make checks pass by fixing the code:** never loosen, skip or delete a test, assertion, lint rule or "done when" to get green. A wrong check is said so, with why, and changed only as its own visible step. A test a deeper one replaces is named with its replacement, which is first seen catching the same fault (injected and undone as above).
- **A failing check whose cause isn't plain:** reproduce it with the narrowest command and see the same failure; write 3 to 5 hypotheses before editing; change one thing at a time; tag any debug logging with one prefix. A check that fails only sometimes is run 10 times with that narrowest command, and its rate given. With no repro that holds, stop and tell the user what you tried.
- **Quote output sparingly:** only the lines that carry the signal, with `<REDACTED>` for a secret.
- **Found outside the task:** what you notice beyond the plan (a bug, a stale doc, a small optimisation) goes in a list for the user, one line each, not fixed in passing.
- **Approval gates:** stop at each one and ask once, with the exact command or write, what it changes, its dry run or diff where there is one, and how it is undone; an approval covers that action only.
- **Git:** follow the user's and the project's git rules; never commit, push or open a PR unless the user asks at that moment.

## Finish

- Run all builds and tests once more, and check the docs' quoted texts against the code.
- Throwaway files and the tagged debug logging (one grep for its prefix) are gone.
- Every checkpoint's line says how it ended (`merged as #N`, `done`, `dropped`); CCInformer's board then offers to archive the plan, so leave it in place.
- Record the decisions, the Build decisions included, where the project keeps its history (the module doc, the PR description), in words a reader of the repo understands, without the plan's checkpoint ids or file name. Offer an ADR only when a decision is hard to reverse, would surprise a later reader without its context, and was a real trade-off.
- Propose up to 3 changes to the setup that would have caught sooner what the review or the build caught late (a lint rule, a test, a critic lens, a standing scout in the planning settings); proposals only.
- If the project had no planning settings and plan files are on, offer once to save what this run learned as `.local/ccinformer-planning.md`, only where git ignores `.local/` (the skill's `.local/` rule): copy `planning-template.md` from this folder, fill each section from the run (the checks you ran, the scouts you used, the approvals you hit, the commit and PR rules you followed), mark anything you guessed "(check)", leave a section you know nothing about as its placeholder, and tell the user in one line that the next plan in this repo starts from it.
- Give the user the "Found outside the task" list (deduplicated, any agents' lines included), the manual test steps, the files for their commit, and a draft PR description if a PR is planned, without checkpoint ids or plan file names.
