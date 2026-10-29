# CCInformer

A Claude Code mod: a pane docked on the right of the terminal (a quarter of its width), in five areas, switched with `1`-`5`. An area shows once it has something built; Timeline (`4`) has nothing yet, so it isn't drawn, and the digits stay where they are.

- **Now** (`1`) › **Env** (`e`): what runs and where it points. The processes this session started that the pack places (their environment, `heavy` for the ones that strain the machine, how long they've run); the processes the pack knows on this machine, started by Claude or not, with their pid, memory and environment; and how much memory is free. On Windows one PowerShell call reads both and matches the pack's patterns inside PowerShell, so command lines never reach the mod; elsewhere `ps` and `/proc/meminfo`, matched in the mod and dropped at once. Only the matcher, pid, memory and environment are kept. A toast says when memory runs low (under 1 GB free, or a tenth of the machine), once, until it recovers.
- **Now** (`1`) › **Sessions** (`s`): the other Claude sessions on this machine, those in this folder first, with what each is working on. A warning shows when another session is working in this folder.
- **Code** (`2`) › **Git**: branch, upstream and ahead/behind, when it last fetched (`u` fetches), and a warning while a rebase, merge, cherry-pick or revert is in progress. CI for the branch's open PR, with its review, merge state and size (or the commit's Actions runs); a failed check links to its run. The newest runs on the branch it merges into. Every change grouped as git does (conflicts, staged, unstaged, untracked): compact, `f` shows all, pressing a file shows its diff under it, `d` opens Claude Code's `/diff`. The commits a push would send and those waiting upstream, recent commits, other branches, stashes, worktrees. When a commit's checks finish, a toast and a desktop notification say how it went (one session pings for all).
- **Code** (`2`) › **Rules** (`k`): what the pack's [checks](#checks) found in the files Claude wrote, per file, marked `CI` where pushing as is would fail the repo's CI. A file over its size limit, a lint error, a suppression nothing needs any more. Pressing a finding selects it, `x` dismisses it for the session. Code's badge shows `!` while something would fail CI. The model is told too: about the file it just wrote with that tool's result, and about the turn's ESLint run with the next prompt you type.
- **Code** (`2`) › **Budgets** (`b`): the pack's [budgets](#budgets), such as a start-up bundle's size: each one's value against its limit (against a baseline it reads as the repo's own report does: "1.5% over the baseline, within the 5% budget"), where the value came from, and whether it still measures the tree as it is. `m` builds first, then reads, which takes as long as the build. Code's badge shows `!` while a fresh reading is over its budget.
- **Work** (`3`) › **Runs** (`w`): the running workflow with its phases (click a chip, or `p`/`n`, `l` to follow the live one), a timeline of its agents, and each agent's model, tools, context and output tokens. A list of runs from this session and the project's recent sessions, read from the run records Claude Code writes; click one to see it in full (`x` closes it). Ordinary subagents below.
- **Work** (`3`) › **Stats** (`s`): every finished run of a workflow in this project (`o` for the next workflow). Full runs and partial ones (a re-check) are averaged apart; a trend of the full runs' durations; each phase's average time and share of the run; per phase, how each model's agents did (time and context per agent, over the agents that ran rather than being replayed from cache).
- **Work** (`3`) › **Plans** (`t`): the checkpoint board. Each plan file the pack names (see [Plans](#plans)), how many of its checkpoints are done, and every checkpoint with its status (✓ done, ◐ partly, ○ open, – dropped) and the PRs its line names.
- **Debug** (`5`) › **Calls** (`t`), **Requests** (`q`), **Context** (`c`): every tool call with its run time (a wait for your approval included); every model request with its tokens; how the main conversation's context grew, against its window, with compactions marked.
- **Debug** (`5`) › **Pack** (`p`): the pack this repo resolved to (see [Packs](#packs)): each layer and how it went, whether the repo's own tools may run (`a` allows or stops them), and every value with the layer that set it.

**The band** above the prompt warns while a process Claude started points at a shared or production environment: `⚠ STAGING  npm run dev:staging  targets a shared environment`. The pack decides what counts: a script expanded through `package.json` and matched by an environment's `argRegex`, or the hosts in the env file the process reads (Vite's `.env.<mode>` for `--mode <mode>`), held against each environment's `hostPatterns`. A production one goes first and onto the status line too. The band clears when the process ends (its task's notification, a TaskStop, or a foreground command returning), gives way to a survey, and `×` clears a row whose end never arrived. Only the script's name is kept, never the command line or an env file's values.

Each area keeps its selected row (a pressed file or finding in Code, a picked run in Work) while another area shows; the keys that act on a row act on that one.

## Install

The install script adds this repository as a marketplace, switches on auto-update for it, and installs the mod, so later releases arrive by themselves. It is safe to run again.

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.ps1 | iex
```

Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.sh | bash
```

If the first `claude` on your PATH doesn't run, set `CLAUDE_BIN` to a working one first.

Or install by hand, without auto-update. At the prompt of a terminal session:

```
/plugin install ccinformer --marketplace EsonOscar/CCInformer
```

Answer `y` to add the marketplace, then pick the user scope. From a shell: `claude plugin install ccinformer --marketplace EsonOscar/CCInformer`. In the desktop app, where `/plugin` doesn't run: + next to the prompt box → Plugins → Add marketplace `EsonOscar/CCInformer` → Add plugin.

## Use

- `/ccinformer` opens or closes the pane. `/ccinformer now|code|work|debug` opens it on an area, and a view's name opens its area on that view (`/ccinformer stats`); the old tab names (`git`, `agents`, `sessions`) still work. With an argument it never closes the pane. `/ccinformer pack trust` and `/ccinformer pack untrust` allow or stop the repo's own tools. `/side` is a short alias for the same thing.
- Ctrl+X Tab gives it the keyboard: `1`-`5` switch areas, the letters shown switch an area's views and run its actions, `r` refreshes, Esc gives the keyboard back. A key is used once per area. Clicking works without that.

## Packs

A pack tells CCInformer about a kind of project: which processes, environments, checks, budgets, locks and generated files it has. Packs are data; the mod's own code acts on them. Today they drive the band and Now › Env (environments and processes), Code › Rules (checks), Code › Budgets (budgets) and Work › Plans (plans); Debug › Pack shows what this repo resolved to.

Four layers, lowest first. Lists merge by `id`, and a later layer's fields win:

1. **A built-in pack**, picked from the repo's files. Today: `node-vite` (a `package.json` naming `vite`).
2. **Your user pack**, `~/.claude/ccinformer/packs/<name>.pack.jsonc`, for the repos whose remote matches its `match.remote` (globs over `host/owner/repo`, e.g. `github.com/<owner>/*`). It can `extends` a built-in and `disable` ids from it. Your own values for a repo live here, outside the repo.
3. **`.ccinformer.jsonc`** in the repo, committed.
4. **`.ccinformer.local.jsonc`** in the repo, kept out of git; Debug › Pack warns when git doesn't ignore it.

A repo's files may only add or tighten, with globs and literals:

```jsonc
{
  "pack": "node-vite",                          // a built-in, when detection misses it
  "budgets": { "<budget id>": { "limit": 400000 } }, // only stricter than the pack below
  "locks": { "exclusive": ["db/migrations/**"], "warn": ["package-lock.json"] },
  "envHosts": { "prod": ["db.example.com"] },     // shared or prod; a host in two tones takes the stricter
  "plans": { "globs": ["docs/plans/*.md"], "archiveDir": "docs/plans/archive" }
}
```

A repo file that names a command to run, switches anything off, holds a regex, names a user pack, or points outside the repo (by its text, or by where a link really leads) is refused whole, and Debug › Pack says why. So is a file that doesn't parse; the rest of the pane carries on.

**Repo trust.** Some checks run the repo's own tools (ESLint loads its config and `node_modules`; a build runs its targets). They wait until the repo is trusted: a user pack matches it, or you allow it once with `/ccinformer pack trust` (or `a` in Debug › Pack). The yes holds for the repo's config files as they are; when they change, it asks again. `/ccinformer pack untrust` (or `a` again) takes it back. Until then only the mod's own checks run; the first check that needs the repo's tools asks once a session.

### Checks

A check names an analyzer, the files it looks at (`on`, minus `ignore`), when it runs, and whether the repo's CI enforces it (`class: "ci"`) or it is only the project's own rule (`"advise"`). Two analyzers so far:

- **`size-lines`** runs inside the mod on each file Claude writes (`cost: "edit"`): over `options.max` lines is an error, from 90 % of it a note. It counts lines as ESLint's `max-lines` does with no options, and reads the repo's ESLint suppressions the way ESLint does, so a grandfathered file reads "suppressed: don't grow it", and one back under its limit leaves an unused suppression to prune.
- **`eslint-json`** runs the repo's own ESLint once a main turn ends (`cost: "turn"`), over the files every agent wrote in that turn, in a trusted repo. It runs raw (an empty suppressions file), and the repo's suppressions are applied in the mod, exactly as ESLint applies them: so a suppression nothing needs any more is found too, which ESLint itself only reports as a count. The built-in `node-vite` has this one, reading ESLint's default `eslint-suppressions.json`. Rules an inline check covers are left to it.

A user pack adds checks with the repo's own values:

```jsonc
"checks": [
  { "id": "max-lines", "label": "File length", "on": ["src/**/*.{ts,tsx}"], "ignore": ["**/*.test.{ts,tsx}"],
    "analyzer": "size-lines", "cost": "edit", "class": "ci",
    "rules": ["max-lines"], "options": { "max": 500 }, "suppressions": "eslint-suppressions.json" }
]
```

Files changed by a shell command, not a file tool, aren't checked.

### Budgets

A budget is a number the repo keeps under (or over) a limit: a fixed one, or a share of a baseline it reads from a JSON file (`"relative": 1.05` is 5 % over it). Its sources are tried in order, and the first fresh value shows; with none fresh, the first value shows marked stale, with why.

- **`command`** runs the repo's own report (repo trust needed) and reads the number from its output with `parse` (a regex; its first group, times `scale`, 1024 for KB), whatever the exit code: a report that finds the budget broken still prints its reading. It is fresh while its `freshAfter` file (the build it measures) is newer than HEAD's commit and Claude's last file write. Its `build` is what `m` runs first.
- **`ci-log`** reads the same line from the log of the newest CI run of HEAD that has the named job (fresh), else of the branch (stale). A finished job's log never changes, so each is fetched once.

```jsonc
"budgets": [
  { "id": "start-brotli", "label": "Start-up bundle, brotli", "unit": "bytes", "direction": "max",
    "limit": { "relative": 1.05, "baseline": { "kind": "json", "path": "<baseline>.json", "pointer": "/start/brotli" } },
    "sources": [
      { "kind": "command", "argv": ["node", "<report script>", "--check"], "parse": "brotli: ([0-9.]+) KB", "scale": 1024,
        "freshAfter": "dist/index.html", "build": ["npm", "run", "build"] },
      { "kind": "ci-log", "job": "<job name>", "step": "<step name>", "parse": "brotli: ([0-9.]+) KB", "scale": 1024 }
    ],
    "cost": "cheap" }
]
```

### Plans

`plans.globs` names a repo's plan files (Markdown); files under `plans.archiveDir` are left out, and so is a file that defines no checkpoint. The board reads what a plan already says; nothing is written to it.

- **A checkpoint** is an id at the start of a heading (below the plan's `#` title), of a table row's first cell, or of a bold label that starts a line or a list item, followed by punctuation or the end of the label: `### R3: foundation`, `| C7 | ... |`, `- **CP1, storage:**`. A mention mid-sentence, or an id followed by prose (`**R1 done when** ...`), is not one. A label that starts with several ids or a range (`CP1–CP3, CP1b`) defines each, and an id defined twice is one checkpoint.
- **Its status** comes from the markers on its own line (for a table row, its first two cells): done for `merged as #N`, ✅, done or passed, or the id struck through; dropped for dropped, superseded or obsolete; partly for 🟡 or PARTLY; otherwise open. An id defined twice takes the strongest.
- **Ids** look like `CP3`, `C7`, `R3a` or `PR 4` unless the pack's `plans.checkpoint` sets its own regex; `plans.done` replaces the done markers, and `plans.prRef` the PR pattern (`#(\d+)`).

## Numbers

- **Context** (`ctx`) is what one request carried in: an agent's figure is its latest request's, as Claude Code's workflow bar counts it; a run's total is the bar's own.
- **Output** (`↓`) is what the model generated, summed over requests: this is what an agent's time mostly goes to.
- Debug's Requests view sums every request's input, cache reads included: what was processed, not how full the context is.

## Polling

A session counts as active while a turn runs, for 3 minutes after one, and while the pane is being used (mods can't see whether the terminal is in front).

| Collector | Every | While | Also |
|---|---|---|---|
| Git | 5 s | the pane is open on Code, in an active session | after Claude changes files, on activity, on opening Code, on `r` |
| CI | 60 s | the pane is open on Code, in an active session | every 8 s while checks run and for 3 minutes after a push, pane open or closed (for the ping) |
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
| Budgets | no polling | | on opening Code › Budgets, on `r`; on `m` after a build (up to 10 minutes) |
| Plans | no polling | | on opening Work › Plans, on `r`; a file is parsed again only when its modified time changed |

Commands run in two lanes. Quick reads (git, gh) share the light lane, up to 4 at once, each given 20 s; long jobs take the heavy lane one at a time (a fetch gets 60 s, ESLint and a budget's report 120 s, a build 10 minutes), so a fetch or a lint never holds up the reads. A poll that comes due while its last run is still busy is skipped, so a slow `gh` never piles up calls.

## Where things live

- `hooks/register.tsx`: every hook and every state atom (the validator requires them in one module), and the writes to state. Files are read by `$` helpers in `hooks/read-*.ts` (run records, sessions, the git folder), which only fetch and return. Views in `hooks/view-*.tsx`, the pane's layout and badges in `view-pane.tsx`; plain logic in `parse.ts`, `phases.ts`, `records.ts`, `insight.ts`, `rows.ts`, `collect.ts`, `format.ts`, and `core/` (the exec lanes in `core/lanes.ts`, through which every command runs).
- `hooks/env/`: what a command runs and where it points (`classify.ts`, plain logic; `read.ts` reads `package.json` and env files), and the process and memory queries with their parsers (`procs.ts`). The band is `hooks/view-band.tsx`, Now › Env `hooks/view-env.tsx`.
- `hooks/packs/`: the pack loader. `load.ts` reads the files; the rest is plain logic: `validate.ts` (what each layer may hold), `merge.ts`, `resolve.ts`, `trust.ts`, and the built-ins (`node-vite.ts`).
- `hooks/checks/`: the checks. `run.ts` runs them (reads the written files, runs ESLint through the heavy lane, keeps what the model hasn't read yet) and hands its findings back to `register.tsx`, which writes them to state; the rest is plain logic: `findings.ts` (the analyzers and the note the model reads), `suppressions.ts` (ESLint's suppression rule), `glob.ts`. Code › Rules is `hooks/view-rules.tsx`.
- `hooks/budgets/`: the budgets, built the same way: `run.ts` reads the sources (the report through the heavy lane, CI's job logs through `gh`) and hands the readings back; `gauge.ts` is plain logic (reading a value, the limit, which reading shows, the words). Code › Budgets is `hooks/view-budgets.tsx`.
- `hooks/plans/`: the checkpoint board, built the same way: `run.ts` finds the plan files and reads the changed ones; `parse.ts` is plain logic (what a checkpoint is, its status). Work › Plans is `hooks/view-plans.tsx`.
- `hooks/areas.ts`: the areas, their views and every key; views take their hotkeys from it, and a test holds each key to one use per area.
- The mod's own state is kept per session; the area, the open pane, CI pings, the session list and the repos you trusted are in the store all sessions share (`~/.claude/plugins/store/`).

## Changing it

See [CONTRIBUTING.md](CONTRIBUTING.md) for the flow, titles and versions. To try a change before it's released, start one session with the working copy loaded (`claude --plugin-dir <folder>`); that session runs the working copy in place of the installed release, reloads it when a file is saved, and its pane says `CCInformer · dev`. Other sessions keep the release. The working copy keeps its own store, so its Sessions tab sees only other sessions running a working copy. Load the `plugin-authoring` skill before changing the mod, and check with `claude plugin validate --strict .` and `claude plugin test .`. Rules the validator holds a mod to: one hooks module, `hooks/register.tsx`, which declares every state atom it reads and writes; `$` is passed only to a function declaration (`function f($, …)`), at the top of that file or imported from another file of the mod, never to an arrow function; and types are imported with `import type`.

## License

MIT
