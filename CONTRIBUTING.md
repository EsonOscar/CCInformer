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
- Before pushing, run what CI runs: `claude plugin validate --strict .` and `claude plugin test .` (the pre-push hook does this for you). Neither typechecks, and CI can't: the mod API's typings are written into `.claude-plugin/types/` only when Claude Code loads the mod in a session, which needs a login. So the pre-push hook also runs `npx -p typescript@5 tsc -p . --noEmit`, skipped with a notice in a clone that hasn't loaded the mod yet (`claude --plugin-dir .` once). Until then a type error passes every check: a test has to reach the code. A change under `skills/audit-docs/` also runs that skill's tests, which the pre-push hook doesn't: `python3 -B -m unittest discover -s skills/audit-docs/tests` and `node skills/audit-docs/tests/test_fanout.mjs`. The pre-push hook and CI both check that the write-pack skill's template is a valid pack naming every key: `npx -y tsx@4 skills/write-pack/tests/check_template.mjs` (the test kit loads only code files, so it runs under tsx); a schema change updates the template.
- Before `gh pr create`, run the [leak guard](#leak-guard) on the title and the body file.
- A red check means fix the cause; nothing in CI has a bypass.

## Versions

Installed machines only pick up a change when `version` in `.claude-plugin/plugin.json` goes up. So a PR that changes what ships (`.claude-plugin/`, `hooks/`, `skills/`, `types/`, `tsconfig.json`) raises it in the same PR. The `version-bump` check fails the PR otherwise. Docs, tests and CI changes don't need a bump.

- **Where:** `plugin.json` only. `marketplace.json` carries no version, so the two can't disagree.
- **How much, while on 0.x:** patch for a fix, minor for a feature *or* a breaking change. CCInformer stays on 0.x until the planned feature set is complete; 1.0.0 is a deliberate decision, after which a breaking change is a major bump.
- **What counts as breaking:**
  - a pack schema change that makes existing pack files invalid;
  - a removed `/ccinformer` or `/side` command, or a removed key;
  - moved store or ledger paths, which reset saved state;
  - a renamed plugin id.

  Say so in the PR's Context.
- **Releases:** after the merge, [`release.yml`](.github/workflows/release.yml) tags the commit `vX.Y.Z` and creates a GitHub release that lists the PRs since the previous one. The releases page is the changelog; there is no `CHANGELOG.md`.

## Working on the mod

To try a change before it's released, start one session with the working copy loaded (`claude --plugin-dir <folder>`); that session runs the working copy in place of the installed release, reloads it when a file is saved, and its pane says `CCInformer · dev`. Other sessions keep the release. The working copy keeps its own store, so its Sessions tab sees only other sessions running a working copy, and whether it starts as a new install (everything off but Safety) depends on what that store holds. Load the `plugin-authoring` skill before changing the mod, and check with `claude plugin validate --strict .` and `claude plugin test .`. Rules the validator holds a mod to: one hooks module, `hooks/register.tsx`, which declares every state atom it reads and writes; `$` is passed only to a function declaration (`function f($, …)`), at the top of that file or imported from another file of the mod, never to an arrow function; and types are imported with `import type`.

The pane draws on more than the terminal: the desktop app, VS Code and mobile draw the same tree as a laid-out page, in a proportional font, and scroll it themselves. So `PaneView` (`hooks/view-pane.tsx`) has two layouts, picked per drawing by `e.surface`: in the terminal the fixed header and footer laid over the content, which the pane scrolls itself; elsewhere one plain column with nothing laid over anything (a page puts a layer drawn on top above everything else, clicks included). Rules that keep the views right on both:
- A box that shrinks (`flexShrink={1}`) also takes `minWidth={0}`, or on a page it won't shrink below its text and the row overflows.
- Size a line of `─` to the width and put it in a one-row box with `overflow="hidden"`: a page draws `─` wider than a cell.
- Indent wrapping text with a box's padding, not leading spaces, so its second line is indented too.
- `size`, `weight` and `mono` on `Text` style the page and the terminal ignores them, so they need no surface check.
- The terminal's header is drawn over the content at a height worked out before drawing, so nothing in it may wrap on its own: a row that doesn't fit squeezes its last item into a narrow column that spills over the content. `areaBarFit` and `viewBarFit` (`hooks/ui.tsx`) fit each bar to the width (a narrower gap, then the view bar without its counts, then more rows), and the header takes the rows they return.
- UI tests mount on the surfaces they cover: `$.ui.mount({ ..., surface: 'desktop' })`, as `tests/desktop-pane.test.tsx` and `tests/areas.test.tsx` do.

To try a working copy in the desktop app, which takes no `--plugin-dir`: quit the app fully, then start it from a shell that names the folder for that process only, so terminal sessions keep the release. In PowerShell: `$env:CLAUDE_CODE_PLUGIN_DIRS = '<folder>'; $env:CLAUDE_CODE_PLUGIN_DIR_WATCH = '1'; & '<path to the app>\Claude.exe'` (`CLAUDE_CODE_PLUGIN_DIR_WATCH` makes it reload on save). Never put the folder in `settings.json`'s `env`, which every session reads.

### Code layout

- `hooks/register.tsx`: every hook and every state atom (the validator requires them in one module), and the writes to state. Files are read by `$` helpers in `hooks/read-*.ts` (run records, sessions, the git folder), which only fetch and return. Views in `hooks/view-*.tsx`, the pane's layout and badges in `view-pane.tsx`; plain logic in `parse.ts`, `phases.ts`, `records.ts`, `insight.ts`, `rows.ts`, `collect.ts`, `format.ts`, and `core/` (the exec lanes in `core/lanes.ts`, through which every command runs; the Settings registry in `core/permissions.ts`: every permission, its group and default, and how Approve all and Deny all apply). Debug › Settings is `hooks/view-settings.tsx`.
- Anything the mod does by itself checks its permission first: `may('<id>')` in the hooks module, or the `may` dep the feature folders get. A toast, notification, question, prompt or note for Claude, a command in the background, a write: a key, button or `/ccinformer` command the person used needs none, and neither does a read-only tool Claude calls, such as `check_pack` (Claude starts it, it writes nothing, and registering it only lists its name behind ToolSearch; `tests/passive.test.tsx` pins it under Deny all). `.githooks/check-permissions.sh` holds the calls to the host (tag a person-started one `// asked`), and `tests/passive.test.tsx` the background polls. A new behaviour gets its permission in `core/permissions.ts`, with a label and a one-line description, as both the view and the explain prompt read them. On a new install every permission outside Safety starts off: the first start stores base `off` (Deny all's state), while an install from before 0.24.0 was given base `defaults` at its first read (`startingChoices`). So a permission added later starts off on the one and at its `isOnByDefault` on the other. Those writes, the stored choices and the first-open marker, are the Settings' own record, like the area and the open pane, so they take no permission.
- `hooks/git/run.ts` (Code › Git: git and CI through the light lane, the CI ping, a file's diff) and `hooks/runs/run.ts` (Work › Runs and Stats: subagents, run records, the history and stats): `$` helpers built at session start, like the folders below; the state they show is written through callbacks, as its atoms live in `register.tsx`.
- `hooks/ci/`: active CI mode. `run.ts` (a `$` helper) reads the repo's mode, claims a failed commit, fetches each failed job's log and the diff through the light lane and hands them to the session as one turn that looks into the failure; `investigate.ts` is plain logic (that turn's prompt, which turn is read-only, the texts). It is a turn and not a subagent because a plugin's own agent start has no model request behind it, so auto mode's classifier gives it no verdict and it never runs. The read-only guard itself lives in `register.tsx`'s `tool.call` hook, decided from a synchronous mirror of the state (`ciState`), so it needs no `$` call that could fail.
- `hooks/env/`: what a command runs and where it points (`classify.ts`, plain logic; `read.ts` reads `package.json` and env files), and the process and memory queries with their parsers (`procs.ts`). The band is `hooks/view-band.tsx`, Now › Env `hooks/view-env.tsx`.
- `hooks/packs/`: the pack loader. `load.ts` reads the files; the rest is plain logic: `validate.ts` (what a pack may hold: each entry's fields as a shape typed against its type in `types.ts`, so tsc fails when the two drift apart, and the rules for every regex), `merge.ts`, `resolve.ts`, `trust.ts`, and the built-ins (`node-vite.ts`), listed in `builtins.ts`. A new built-in is a file of its own plus one entry there; `tests/packs.test.ts` holds every built-in to the validator.
- `hooks/checks/`: the checks. `run.ts` runs them (reads the written files, runs ESLint and the packs' own commands through the heavy lane, keeps what the model hasn't read yet) and hands its findings back to `register.tsx`, which writes them to state; the rest is plain logic: `findings.ts` (the inline analyzers, ESLint's JSON, the core that applies a tool's raw findings to a run's files with the repo's suppressions, and the note the model reads), `sarif.ts` (SARIF 2.1.0 into raw findings), `matcher.ts` (a problem matcher's regex over output lines), `tools.ts` (the command a tool check builds, and what its exit code and output come to), `source.ts` (JS and TS read without comments and regex literals, with ESLint's line for a template string, for `regex-lines`), `suppressions.ts` (ESLint's suppression rule), `i18n.ts` (translation tables: keys a language lacks, keys in two tables), `glob.ts`. The tables are found with `hooks/read-files.ts`, the glob walker the plan board uses too. Code › Rules is `hooks/view-rules.tsx`.
- `hooks/budgets/`: the budgets, built the same way: `run.ts` reads the sources (the report through the heavy lane, CI's job logs through `gh`) and hands the readings back; `gauge.ts` is plain logic (reading a value, the limit, which reading shows, the words). Code › Budgets is `hooks/view-budgets.tsx`.
- `hooks/plans/`: the checkpoint board, built the same way: `run.ts` finds the plan files, reads the changed ones, asks gh about their PRs and archives a plan; `parse.ts` (what a checkpoint is, its status), `drift.ts` (which PRs to ask about, what to warn about, when a plan is finished) and `archive.ts` (where a plan goes, how references to it change, the dialog and reminder words) are plain logic. Work › Plans is `hooks/view-plans.tsx`.
- `skills/`: the planning skills. `plan-feature` holds the shared parts: the workflow scripts (`plan-fanout.js`, which `plan-handoff` uses too, and `build-fanout.js`), the wave snapshot script and `planning-template.md`; `plan-feature-small` and `plan-handoff` refer to them there. `audit-docs` holds its workflow script (`audit-docs-fanout.js`), the script that is the only gate between its rows and the docs (`apply_changes.py`), the moved-text check (`check_moved_text.py`), and their tests in `skills/audit-docs/tests/`, which CI runs. `write-pack` (`/ccinformer:write-pack`) holds its steps and `pack-template.jsonc`, every pack setting with what it does, which `tests/check_template.mjs` holds to the validator; its draft is checked by the mod's `check_pack` tool (`hooks/packs/check.ts`, answered in `register.tsx`'s tool-call observer). A new built-in pack is written with `/write-builtin`, a skill of this repo's own in `.claude/skills/` that doesn't ship: it follows write-pack's "Shared:" sections with a built-in's differences.
- `hooks/areas.ts`: the areas, their views and every key; views take their hotkeys from it, and a test holds each key to one use per area.
- The mod's own state is kept per session; the area, the open pane, CI pings, each repo's CI mode and the commits looked into, the session list, the repos you trusted, your Debug › Settings choices and, on a new install, whether Settings has been shown yet (`settingsFirst`) are in the store all sessions share (`~/.claude/plugins/store/`). The planning skills' Plan files switch is a file instead, `~/.claude/ccinformer/skills.json` (`hooks/core/skills.ts`), as the skills read it themselves; it is read at session start and with Debug.

### Polling

A session counts as active while a turn runs, for 3 minutes after one, and while the pane is being used (mods can't see whether the terminal is in front).

| Collector | Every | While | Also | Switch (Debug › Settings) |
|---|---|---|---|---|
| Git | 5 s | the pane is open on Code, in an active session | after Claude changes files, on activity, on opening Code, on `r` | Git after edits (after Claude's edits) |
| CI | 60 s | the pane is open on Code, in an active session | every 8 s while checks run and for 3 minutes after a push, pane open or closed (for the ping). Each poll also reads the repo's CI mode. A failure in active mode: each failed job's log and the diff, read one at a time, then one turn handed to the session | Watch CI (the fast polling with Code not shown); CI finished toast and notification (the ping); Look into failed CI (the hand-off) |
| Subagents | 2 s | the pane is open | | none: showing |
| Run records | 10 s | always | 3 s after a subagent ends | none: reads files only |
| Run history | 60 s | the pane is open on Work | on opening Work, on `r` | none: showing |
| Stats | 120 s | the pane is open on Work › Stats | on opening Work › Stats, on `r` | none: showing |
| Session beat | 15 s | always | | Tell other sessions |
| Other sessions | 5 s | the pane is open on Now | on opening Now, on `r` | none: showing |
| Pack files | each main turn | always | read again only when a file changed (a `stat` of each) | none: the pack read |
| Processes on this machine, with free memory | 30 s | the pane is open on Now › Env, in an active session | on opening Env, on `r` | none: showing |
| Free memory alone | 30 s | a heavy process this session started runs, pane open or closed | | Memory probe; Low memory toast |
| Processes Claude starts | no polling | always | placed when the Bash call starts; cleared by its task's notification, a TaskStop, or the call returning | Environment band, Production status line (Safety) |
| Inline checks (`size-lines`) | no polling | always | on each Edit or Write, inside the mod: no command runs | Inline check notes (what Claude is told) |
| Turn checks (the repo's tools: ESLint, sarif, problem-matcher) | no polling | always | once a main turn ends that wrote files a check covers, in a trusted repo; at most 40 files a run when the command takes `{files}`, the rest in the next; a whole-project command runs once a turn and holds the heavy lane for its whole run | Turn checks; Turn check notes; Ask about repo trust |
| Turn checks (translation keys) | no polling | always | once a main turn ends that wrote a file a check covers, inside the mod (no trust needed): every table the check covers is listed and its languages' files read | Turn checks; Turn check notes |
| Budgets | no polling | | on opening Code › Budgets, on `r`; on `m` after a build (up to 10 minutes) | none: showing |
| Footer (context and limits) | no polling | always | read once at start, then each time Claude Code measures a change | none: showing |
| Plans | 5 s | the pane is open on Work › Plans | on opening Work › Plans, on `r`; a file is parsed again only when its modified time changed. Then `gh pr view` for each PR an open checkpoint names: on opening, on `r` and every minute, every one whose state isn't final (a merged or closed PR is not asked about again in the session); every 5 s, only those not asked about yet. Away from Work › Plans, every 10 minutes in an active session, pane open or closed, the open ones again (for Work's badge and the toast) | Plans in the background (away from Work › Plans); Plans toasts |
| Settings | 5 s | always | on opening Debug › Settings, on `r` | none: it reads the switches |

On a new install every switch in the last column starts off except the Safety ones; with one off, the part of its row it names doesn't run.

Commands run in two lanes. Quick reads (git, gh) share the light lane, up to 4 at once, each given 20 s; long jobs take the heavy lane one at a time (a fetch gets 60 s, a turn check and a budget's report 120 s unless the check sets `timeoutMs`, a build 10 minutes), so a fetch or a lint never holds up the reads. A poll that comes due while its last run is still busy is skipped, so a slow `gh` never piles up calls.

## Checks

| Check | Workflow | What fails it |
|---|---|---|
| `plugin` | `ci.yml` | A command run outside the exec lanes ([`.githooks/check-exec.sh`](.githooks/check-exec.sh)), something the mod does by itself without its Settings gate ([`.githooks/check-permissions.sh`](.githooks/check-permissions.sh)), or `claude plugin validate --strict .` or `claude plugin test .`, on the latest Claude Code; or the audit-docs skill's own tests (Python and Node); or the write-pack template isn't a valid pack naming every key |
| `secret-scan` | `ci.yml` | gitleaks finds a secret in any commit of the PR or in the tree ([`.gitleaks.toml`](.gitleaks.toml)). The repo is public, so this one matters even solo |
| `pr-title` | `pr-gates.yml` | The PR title isn't `type(scope): subject` |
| `version-bump` | `pr-gates.yml` | Shipped files changed and `plugin.json`'s version didn't go up |
| `install` | `install.yml` | On Linux, macOS or Windows, with Claude Code from its native installer: a run of the install script with no terminal fails, leaves the mod uninstalled or auto-update off, a second run changes anything, or an old Claude Code doesn't stop it. Only on PRs that touch `install/` or the workflow, or run by hand; not required, as it downloads Claude Code each time |

The job names above `install` are required status checks in [`.github/rulesets/main.json`](.github/rulesets/main.json). Renaming a job means updating the ruleset in the same PR. The file isn't applied by CI: the maintainer re-imports it on GitHub, so say so in the PR.

The workflows pin Actions to a major version (`@v7`), so minor and patch releases arrive by themselves; a new major version is a deliberate change in a PR. GitHub's Dependabot security updates are on in the repo settings.
