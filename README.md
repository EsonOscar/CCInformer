# CCInformer

A Claude Code mod: a pane docked on the right of the terminal, in five areas you switch with `1`-`5`. Timeline (`4`) isn't built yet, so it isn't drawn.

- **Now** (`1`)
  - **Env** (`e`): the processes this session started, which environment each points at and how long it has run; the processes your pack knows on this machine, with their memory; and free memory, with a toast when it runs low. Command lines and env values are never kept.
  - **Sessions** (`s`): the other Claude sessions on this machine and what each is working on, with a warning when another one works in this folder.
- **Code** (`2`)
  - **Git** (`g`): branch, upstream, ahead/behind, and a warning during a rebase or merge. CI for the branch's PR, a failed check linking to its run, and a toast plus a desktop notification when a commit's checks finish. Changed files (press one for its diff, `f` shows all, `d` opens `/diff`), commits to push and pull, recent commits, branches, stashes and worktrees. `u` fetches.
  - **Rules** (`k`): what the pack's [checks](#checks) found in the files Claude wrote, marked `CI` where pushing would fail CI. Press a finding, then `x` to dismiss it. Claude is told about them too.
  - **Budgets** (`b`): the pack's [budgets](#budgets), such as a bundle's size, against their limits. `m` builds, then measures.
- **Work** (`3`)
  - **Runs** (`w`): the running workflow's phases (`p`/`n`, `l` follows the live one) and its agents with their model, tools and tokens; recent runs in this project (press one to open it, `x` closes it); subagents.
  - **Stats** (`s`): every finished run of a workflow in this project: its duration trend, time per phase, and how each model's agents did. `o` shows the next workflow.
  - **Plans** (`t`): the checkpoint board for your [plans](#plans): each checkpoint's status (✓ done, ◐ partly, ○ open, – dropped) and PRs, a warning when a PR has merged but the plan still reads open, and archiving.
- **Debug** (`5`)
  - **Calls** (`t`), **Requests** (`q`), **Context** (`c`): every tool call with its time, every model request with its tokens, and how the context grew, with compactions marked.
  - **Pack** (`p`): the [pack](#packs) this repo resolved to and where each value came from. `a` lets the repo's own tools run, or stops them.

An area's badge flags something worth a look, such as `!` on Code while a push would fail CI. The footer shows `Context: 34% | 5hr (4h12m): 12% | 7d (6d3h20m): 40.5%`: how full the context window is, and how much of your subscription's 5-hour and 7-day limits is used, with the time until each resets.

**The band** above the prompt warns while a process Claude started targets a shared or production environment, as your pack defines them: `⚠ STAGING  npm run dev:staging  targets a shared environment`.

## Requirements

- **Claude Code** with mods (plugins with a hooks module). Releases are tested against the latest Claude Code.
- **git** on the PATH.

The rest is optional; without it, only the parts that use it stay empty:

| Tool | Used for | Without it |
|---|---|---|
| `gh`, logged in (`gh auth status`) | CI in Code › Git, a budget's `ci-log` source, merged-PR warnings in Work › Plans | no CI, no CI readings, no merged-PR warnings |
| Node | the install script's auto-update step; a repo's own tools | the script leaves auto-update off, and says how to switch it on |
| Windows PowerShell (Windows) / `ps`, `/proc/meminfo`, `rm` (elsewhere) | Now › Env's processes and memory; removing a plan's original when it's archived | Env says the process list could not be read; an archive keeps the original |
| bash (Git Bash on Windows) | the build waves of `/ccinformer:plan-feature` | build that plan in the main session instead |

## Install

The install script adds this repository as a marketplace, switches on auto-update for it, and installs the mod, so later releases arrive by themselves. If git, Node or `gh` is missing, it says what each is for and offers to install it (winget on Windows; brew, apt-get, dnf or pacman elsewhere), one at a time; nothing is installed without your yes. It is safe to run again.

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

- `/ccinformer` opens or closes the pane. `/ccinformer <area or view>` opens it there (`/ccinformer code`, `/ccinformer stats`). `/side` is a short alias.
- Ctrl+X Tab gives the pane the keyboard: `1`-`5` switch areas, the letters shown switch views and run actions, `r` refreshes, Esc gives the keyboard back. Clicking works without it.

## Skills

Three planning skills come with the mod. Each plans in plan mode, asks you only the decisions that are really yours, and writes a plan whose checkpoints Work › Plans shows as the work happens.

| Skill | Use it for | What it costs |
|---|---|---|
| `/ccinformer:plan-feature <task>` | A feature worth a thorough review: several parts of the code, data, access rules | A workflow of agents: scouts, 1 to 3 planners, then critics whose findings are checked against the code. Often 10 to 20 agents |
| `/ccinformer:plan-feature-small <task>` | A smaller change, or a tighter token budget | No workflow: Claude reads the code and reviews its own plan |
| `/ccinformer:plan-handoff <feature>` | Planning for someone who isn't a developer | Like plan-feature, but it asks only product questions and ends with a doc a developer builds from |

1. Switch to plan mode (Shift+Tab until the bottom of the screen says plan mode) and run the skill with what you want built.
2. Answer its questions: only real decisions, each with a recommended option.
3. Approve the plan. plan-feature and plan-feature-small save it to `.local/plans/` and build it checkpoint by checkpoint. Nothing is committed or pushed unless you ask.
4. Follow along in Work › Plans (`3`, then `t`), and archive the plan there once it's done.

**Planning settings.** A repo's checks, the risks to review for, the actions that need your OK and its commit rules can be written down once: in a committed `## Planning` section of its CLAUDE.md, or privately in `.local/ccinformer-planning.md`. After a first run in a repo with neither, the skill offers to write the private one for you.

## Packs

A pack tells CCInformer about a kind of project: its processes and environments, checks, budgets and plan files. Four layers, lowest first; lists merge by `id`, and a later layer's fields win:

1. **A built-in pack**, picked from the repo's files. Today: `node-vite` (a `package.json` naming `vite`).
2. **Your user pack**, `~/.claude/ccinformer/packs/<name>.pack.jsonc`, for repos whose remote matches its `match.remote` (globs over `host/owner/repo`, e.g. `github.com/<owner>/*`). It can `extends` a built-in and `disable` ids from it. Your own values for a repo live here, outside the repo.
3. **`.ccinformer.jsonc`** in the repo, committed.
4. **`.ccinformer.local.jsonc`** in the repo, kept out of git.

A repo's own files may only add or tighten, with globs and literals:

```jsonc
{
  "pack": "node-vite",                          // a built-in, when detection misses it
  "budgets": { "<budget id>": { "limit": 400000 } }, // only stricter than the pack below
  "locks": { "exclusive": ["db/migrations/**"], "warn": ["package-lock.json"] },
  "envHosts": { "prod": ["db.example.com"] },     // shared or prod hosts
  "plans": { "globs": ["docs/plans/*.md"], "archiveDir": "docs/plans/archive" }
}
```

A repo file that names a command, switches anything off, holds a regex or points outside the repo is refused whole, and Debug › Pack says why.

**Repo trust.** Checks that run the repo's own tools (ESLint, a build) wait until you trust the repo: a user pack matches it, or you run `/ccinformer pack trust` (or `a` in Debug › Pack). It asks again when the repo's config files change; `/ccinformer pack untrust` takes it back.

### Environments

The band and Now › Env place a process Claude starts by its environment: the command, with npm scripts expanded through `package.json`, matched by an environment's `argRegex`, or the hosts in the env file it reads (Vite's `.env.<mode>` for `--mode <mode>`) held against the environment's `hostPatterns`. Its `tone` (`local`, `shared` or `prod`) decides the band; a production one goes on the status line too.

### Checks

A check names an analyzer, the files it covers (`on`, minus `ignore`), when it runs (`cost`), and whether the repo's CI enforces it (`class: "ci"`) or it's only the project's rule (`"advise"`). Two analyzers so far:

- **`size-lines`** (`cost: "edit"`): a file over `options.max` lines, checked as Claude writes it. The repo's ESLint suppressions apply, and one that's no longer needed is reported.
- **`eslint-json`** (`cost: "turn"`): the repo's own ESLint, once a turn ends, over the files written in it, in a trusted repo, with the repo's suppressions applied. The built-in `node-vite` has it.

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

A budget is a number kept under (or over) a limit: a fixed one, or a share of a baseline read from a JSON file (`"relative": 1.05` is 5 % over it). Its sources are tried in order, and the first fresh value shows.

- **`command`** runs the repo's own report (repo trust needed) and reads the number from its output with `parse` (a regex; its first group, times `scale`). It's fresh while its `freshAfter` file (the build it measures) is newer than HEAD and Claude's last write. `m` runs its `build` first.
- **`ci-log`** reads the same line from the log of the newest CI run of HEAD with the named job; one from the branch's last run shows as stale.

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

The board reads every Markdown plan in `.local/plans/`, in every repo, and the files a pack's `plans.globs` names, leaving out their archive folders. It writes to plans only when you archive one.

- **A checkpoint** is an id (`CP3`, `C7`, `R3a`, `PR 4`) at the start of a heading, a table row's first cell, or a bold label, followed by punctuation: `### R3: foundation`, `| C7 | ... |`, `- **CP1, storage:**`. A range (`CP1–CP3`) defines each id in it.
- **Its status** comes from the markers on its own line: done for `merged as #N`, a check-mark emoji, done or passed, or a struck-through id; dropped for dropped, superseded or obsolete; partly for a yellow-circle emoji or PARTLY; otherwise open. A pack can set its own patterns with `plans.checkpoint`, `plans.done` and `plans.prRef`.
- **Merged PRs.** With `gh`, the board checks the PRs that open checkpoints name. A merged one shows `⚠ #21 merged` on its row and `!` on Work, and a toast says so when it merges while you work. The plan's own status is left as it is.
- **Finished plans** (every checkpoint done or dropped) read "ready to archive", with a reminder toast at most once a day.
- **Archiving.** Press a plan's header, then `a`. It asks first, naming every file it will change, then moves the plan to `.local/plans/archive/` (or the pack's `plans.archiveDir`) and points the references to it there, in `.local/`, the plan's folder and your Claude memory notes for this project.

## Numbers

- **Context** (`ctx`) is what one request carried in: an agent's figure is its latest request's, as Claude Code's workflow bar counts it; a run's total is the bar's own.
- **Output** (`↓`) is what the model generated, summed over requests: this is what an agent's time mostly goes to.
- Debug › Requests sums every request's input, cache reads included: what was processed, not how full the context is.

## Changing it

See [CONTRIBUTING.md](CONTRIBUTING.md): how to try a working copy, the code layout, what the mod polls and when, and the flow for PRs and versions.

## License

MIT
