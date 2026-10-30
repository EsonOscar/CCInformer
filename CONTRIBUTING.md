# Contributing

How changes get into CCInformer, for people and their agents alike, cut down for a one-maintainer public plugin repo. The goal is a clean history on `main`: one commit per PR, each with a readable title, and a version bump whenever what ships changes. Left out because they serve teams: the `staging` branch, the module gate, lanes, code-owner approvals and the English check.

## One-time setup, per clone

```bash
git config core.hooksPath .githooks                     # the pre-commit and pre-push hooks
git config ccinformer.denylist <path to your denylist>  # the leak guard (below); optional
gh auth status                                          # logged in to github.com as yourself
```

If the first `claude` on your PATH doesn't run (a broken shim), point the pre-push hook at a working one in your shell profile: `export CLAUDE_BIN="$HOME/.local/bin/claude.exe"`.

## Leak guard

The repo is public, and gitleaks only knows what a secret looks like. The leak guard catches what's private to you: names, hostnames, paths, other projects.

- **The denylist** is a text file you keep **outside the repo**: one word or phrase per line, blank lines and `#` comments skipped. The local key `ccinformer.denylist` points at it, so no tracked file names it.
- **A match** ignores case and stands as a whole word: no letter or digit touches it, on a side where the entry itself ends in one. So `kit` misses "toolkit", while `.corp.example` still hits "db.corp.example". A line starting with `!` names a public string that never counts, for example a GitHub handle that contains a name you deny: `!<handle>`.
- **`pre-commit`** checks the staged changes: every added line and every path.
- **`pre-push`** checks every commit the push sends: its message, added lines and paths. It runs before the plugin checks. An entry that a later commit removes is still caught, since the history would publish it.
- **PR text** isn't in any commit, so check it yourself before `gh pr create --body-file`:
  ```bash
  sh .githooks/check-text.sh <body file>
  printf '%s\n' "<title>" | sh .githooks/check-text.sh -
  ```
- Without the key, the hooks skip the guard with a notice. If the key names a file that can't be read, they stop. `--no-verify` skips a hook for one commit or push. CI has no denylist, so the guard runs only on your machine.

## The loop

`main` is the only long-lived branch. It's what machines install and update from, so every merge into it is a release.

1. **Branch from a fresh `main`:** `git switch main && git pull && git switch -c feat/<task>`. Prefixes: `feat/`, `fix/`, `chore/`, `docs/`. One task per branch; name a worktree after its task, and keep `claude` and random names out of both.
2. **Commit** on the branch. If the change touches what ships, raise the version in the same PR (see [Versions](#versions)).
3. **Push the branch and open a PR against `main`:** `git push -u origin HEAD && gh pr create`.
4. **Squash-merge** once the checks are green. The PR title becomes the commit on `main`.
5. **Clean up:** GitHub deletes the remote branch on merge. Once `gh pr view <n> --json state` shows `MERGED`, run `git switch main && git pull && git branch -D <branch>` (`-D`, because git doesn't recognise a squashed branch as merged).

Never push to `main` directly; its ruleset ([`.github/rulesets/main.json`](.github/rulesets/main.json)) requires a PR with green checks and allows squash merges only.

## Titles: `type(scope): subject`

PR titles become `main`'s history. Header at most 100 characters, no period at the end. CI checks the PR title (`pr-title`, with [`.githooks/check-commit-msg.sh`](.githooks/check-commit-msg.sh)). Local commits are squashed away on merge, so their messages aren't checked.

- **Types:** `build chore ci docs feat fix perf refactor revert style test`
- **Scope:** one lowercase word naming the area the PR changes, for example `git`, `debug`, `pane` (what every area shares), `plugin` (`.claude-plugin/`, `types/`), `install`, `repo` (tooling and docs), `release` (a version bump on its own). Any word passes the check; pick the one a reader of the history would look for.

  Examples: `feat(git): show the PR's review state`, `fix(debug): count cache reads once`, `chore(release): 0.2.0`.

One change per PR, in English.

## Pull requests

- Against `main`, titled as above.
- The body follows [the PR template](.github/PULL_REQUEST_TEMPLATE.md). Add `Closes #<issue>` when there is one. The body stays on the PR. The squash commit gets the PR title as its subject and the PR's commit messages as its body, so write commit messages that explain the change.
- **Titles, bodies and commit messages stand on their own.** A reader has only the tracked files and the PR, so never cite private planning: no checkpoint or step ids (`CP2`, `C4`, `A12`, "phase 0"), no plan file names, no notes kept outside the repo. Say what changed and why in plain words, and point at tracked files where it helps.
- Before pushing, run what CI runs: `claude plugin validate --strict .` and `claude plugin test .` (the pre-push hook does this for you).
- Before `gh pr create`, run the [leak guard](#leak-guard) on the title and the body file.
- A red check means fix the cause; nothing in CI has a bypass.

## Versions

Installed machines only pick up a change when `version` in `.claude-plugin/plugin.json` goes up. So a PR that changes what ships (`.claude-plugin/`, `hooks/`, `skills/`, `types/`, `tsconfig.json`) raises it in the same PR. The `version-bump` check fails the PR otherwise. Docs, tests and CI changes don't need a bump.

- **Where:** `plugin.json` only. `marketplace.json` carries no version, so the two can't disagree.
- **How much, while on 0.x:** patch for a fix, minor for a feature *or* a breaking change. CCInformer stays on 0.x until the planned feature set is complete; 1.0.0 is a deliberate decision, after which a breaking change is a major bump.
- **What counts as breaking:**
  - a pack or `.ccinformer.jsonc` change that makes existing files invalid;
  - a removed `/ccinformer` or `/side` command, or a removed key;
  - moved store or ledger paths, which reset saved state;
  - a renamed plugin id.

  Say so in the PR's Context.
- **Releases:** after the merge, [`release.yml`](.github/workflows/release.yml) tags the commit `vX.Y.Z` and creates a GitHub release that lists the PRs since the previous one. The releases page is the changelog; there is no `CHANGELOG.md`.

## Working on the mod

To try a change before it's released, start one session with the working copy loaded (`claude --plugin-dir <folder>`); that session runs the working copy in place of the installed release, reloads it when a file is saved, and its pane says `CCInformer · dev`. Other sessions keep the release. The working copy keeps its own store, so its Sessions tab sees only other sessions running a working copy. Load the `plugin-authoring` skill before changing the mod, and check with `claude plugin validate --strict .` and `claude plugin test .`. Rules the validator holds a mod to: one hooks module, `hooks/register.tsx`, which declares every state atom it reads and writes; `$` is passed only to a function declaration (`function f($, …)`), at the top of that file or imported from another file of the mod, never to an arrow function; and types are imported with `import type`.

### Code layout

- `hooks/register.tsx`: every hook and every state atom (the validator requires them in one module), and the writes to state. Files are read by `$` helpers in `hooks/read-*.ts` (run records, sessions, the git folder), which only fetch and return. Views in `hooks/view-*.tsx`, the pane's layout and badges in `view-pane.tsx`; plain logic in `parse.ts`, `phases.ts`, `records.ts`, `insight.ts`, `rows.ts`, `collect.ts`, `format.ts`, and `core/` (the exec lanes in `core/lanes.ts`, through which every command runs).
- `hooks/git/run.ts` (Code › Git: git and CI through the light lane, the CI ping, a file's diff) and `hooks/runs/run.ts` (Work › Runs and Stats: subagents, run records, the history and stats): `$` helpers built at session start, like the folders below; the state they show is written through callbacks, as its atoms live in `register.tsx`.
- `hooks/ci/`: active CI mode. `run.ts` (a `$` helper) reads the repo's mode, claims a failed commit, fetches each failed job's log and the diff through the light lane and hands them to the session as one turn that looks into the failure; `investigate.ts` is plain logic (that turn's prompt, which turn is read-only, the texts). It is a turn and not a subagent because a plugin's own agent start has no model request behind it, so auto mode's classifier gives it no verdict and it never runs. The read-only guard itself lives in `register.tsx`'s `tool.call` hook, decided from a synchronous mirror of the state (`ciState`), so it needs no `$` call that could fail.
- `hooks/env/`: what a command runs and where it points (`classify.ts`, plain logic; `read.ts` reads `package.json` and env files), and the process and memory queries with their parsers (`procs.ts`). The band is `hooks/view-band.tsx`, Now › Env `hooks/view-env.tsx`.
- `hooks/packs/`: the pack loader. `load.ts` reads the files; the rest is plain logic: `validate.ts` (what each layer may hold), `merge.ts`, `resolve.ts`, `trust.ts`, and the built-ins (`node-vite.ts`).
- `hooks/checks/`: the checks. `run.ts` runs them (reads the written files, runs ESLint through the heavy lane, keeps what the model hasn't read yet) and hands its findings back to `register.tsx`, which writes them to state; the rest is plain logic: `findings.ts` (the analyzers and the note the model reads), `source.ts` (JS and TS read without comments and regex literals, with ESLint's line for a template string, for `regex-lines`), `suppressions.ts` (ESLint's suppression rule), `i18n.ts` (translation tables: keys a language lacks, keys in two tables), `glob.ts`. The tables are found with `hooks/read-files.ts`, the glob walker the plan board uses too. Code › Rules is `hooks/view-rules.tsx`.
- `hooks/budgets/`: the budgets, built the same way: `run.ts` reads the sources (the report through the heavy lane, CI's job logs through `gh`) and hands the readings back; `gauge.ts` is plain logic (reading a value, the limit, which reading shows, the words). Code › Budgets is `hooks/view-budgets.tsx`.
- `hooks/plans/`: the checkpoint board, built the same way: `run.ts` finds the plan files, reads the changed ones, asks gh about their PRs and archives a plan; `parse.ts` (what a checkpoint is, its status), `drift.ts` (which PRs to ask about, what to warn about, when a plan is finished) and `archive.ts` (where a plan goes, how references to it change, the dialog and reminder words) are plain logic. Work › Plans is `hooks/view-plans.tsx`.
- `skills/`: the planning skills. `plan-feature` holds the shared parts: the workflow scripts (`plan-fanout.js`, which `plan-handoff` uses too, and `build-fanout.js`), the wave snapshot script and `planning-template.md`; `plan-feature-small` and `plan-handoff` refer to them there.
- `hooks/areas.ts`: the areas, their views and every key; views take their hotkeys from it, and a test holds each key to one use per area.
- The mod's own state is kept per session; the area, the open pane, CI pings, each repo's CI mode and the commits looked into, the session list and the repos you trusted are in the store all sessions share (`~/.claude/plugins/store/`).

### Polling

A session counts as active while a turn runs, for 3 minutes after one, and while the pane is being used (mods can't see whether the terminal is in front).

| Collector | Every | While | Also |
|---|---|---|---|
| Git | 5 s | the pane is open on Code, in an active session | after Claude changes files, on activity, on opening Code, on `r` |
| CI | 60 s | the pane is open on Code, in an active session | every 8 s while checks run and for 3 minutes after a push, pane open or closed (for the ping). Each poll also reads the repo's CI mode. A failure in active mode: each failed job's log and the diff, read one at a time, then one turn handed to the session |
| Subagents | 2 s | the pane is open | |
| Run records | 10 s | always | 3 s after a subagent ends |
| Run history | 60 s | the pane is open on Work | on opening Work, on `r` |
| Stats | 120 s | the pane is open on Work › Stats | on opening Work › Stats, on `r` |
| Session beat | 15 s | always | |
| Other sessions | 5 s | the pane is open on Now | on opening Now, on `r` |
| Pack files | each main turn | always | read again only when a file changed (a `stat` of each) |
| Processes on this machine, with free memory | 30 s | the pane is open on Now › Env, in an active session | on opening Env, on `r` |
| Free memory alone | 30 s | a heavy process this session started runs, pane open or closed | |
| Processes Claude starts | no polling | always | placed when the Bash call starts; cleared by its task's notification, a TaskStop, or the call returning |
| Inline checks (`size-lines`) | no polling | always | on each Edit or Write, inside the mod: no command runs |
| Turn checks (ESLint) | no polling | always | once a main turn ends that wrote files a check covers, in a trusted repo; at most 40 files a run, the rest in the next |
| Turn checks (translation keys) | no polling | always | once a main turn ends that wrote a file a check covers, inside the mod (no trust needed): every table the check covers is listed and its languages' files read |
| Budgets | no polling | | on opening Code › Budgets, on `r`; on `m` after a build (up to 10 minutes) |
| Footer (context and limits) | no polling | always | read once at start, then each time Claude Code measures a change |
| Plans | 5 s | the pane is open on Work › Plans | on opening Work › Plans, on `r`; a file is parsed again only when its modified time changed. Then `gh pr view` for each PR an open checkpoint names: on opening, on `r` and every minute, every one whose state isn't final (a merged or closed PR is not asked about again in the session); every 5 s, only those not asked about yet. Away from Work › Plans, every 10 minutes in an active session, pane open or closed, the open ones again (for Work's badge and the toast) |

Commands run in two lanes. Quick reads (git, gh) share the light lane, up to 4 at once, each given 20 s; long jobs take the heavy lane one at a time (a fetch gets 60 s, ESLint and a budget's report 120 s, a build 10 minutes), so a fetch or a lint never holds up the reads. A poll that comes due while its last run is still busy is skipped, so a slow `gh` never piles up calls.

## Checks

| Check | Workflow | What fails it |
|---|---|---|
| `plugin` | `ci.yml` | A command run outside the exec lanes ([`.githooks/check-exec.sh`](.githooks/check-exec.sh)), or `claude plugin validate --strict .` or `claude plugin test .`, on the latest Claude Code |
| `secret-scan` | `ci.yml` | gitleaks finds a secret in any commit of the PR or in the tree ([`.gitleaks.toml`](.gitleaks.toml)). The repo is public, so this one matters even solo |
| `pr-title` | `pr-gates.yml` | The PR title isn't `type(scope): subject` |
| `version-bump` | `pr-gates.yml` | Shipped files changed and `plugin.json`'s version didn't go up |

Job names are required status checks in [`.github/rulesets/main.json`](.github/rulesets/main.json). Renaming a job means updating the ruleset in the same PR. The file isn't applied by CI: the maintainer re-imports it on GitHub, so say so in the PR.

The workflows pin Actions to a major version (`@v7`), so minor and patch releases arrive by themselves; a new major version is a deliberate change in a PR. GitHub's Dependabot security updates are on in the repo settings.
