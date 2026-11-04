# CCInformer

A Claude Code mod: a pane docked on the right of the terminal, or of a session in the desktop app's Code tab, in five areas you switch with `1`-`5`. Timeline (`4`) isn't built yet, so it isn't drawn. Everything it does by itself (telling Claude what checks found, toasts and notifications, checks in the background) has a switch in Debug › Settings. On a new install all of them start off except Safety (the band and the production status line), so the toasts, notes for Claude and background checks below come once you switch them on; an install from before 0.24.0 keeps the switches it had.

- **Now** (`1`)
  - **Env** (`e`): the processes this session started, which environment each points at and how long it has run; the processes your pack knows on this machine, with their memory; and free memory, with a toast when it runs low. Command lines and env values are never kept.
  - **Sessions** (`s`): the other Claude sessions on this machine that have Tell other sessions on in Debug › Settings, and what each is working on, with a warning when another one works in this folder.
- **Code** (`2`)
  - **Git** (`g`): the repository's name, branch, upstream, ahead/behind, and a warning during a rebase or merge. CI for the branch's PR, a failed check linking to its run, and a toast plus a desktop notification when a commit's checks finish. In active mode (`i`, per repo, off by default), a failed check makes Claude look into it and present the cause and a fix idea in a turn of its own, which stays read-only until it ends or you type into it. It uses tokens. Changed files (press one for its diff, `f` shows all, `d` opens `/diff`), commits to push and pull, recent commits, branches, stashes and worktrees. `u` fetches.
  - **Rules** (`k`): what the pack's [checks](#checks) found in the files Claude wrote, marked `CI` where pushing would fail CI and `rule` where it's the project's own rule. Press a finding, then `x` to dismiss it. With Inline check notes on, Claude is told about them too.
  - **Budgets** (`b`): the pack's [budgets](#budgets), such as a bundle's size, against their limits. `m` builds, then measures.
- **Work** (`3`)
  - **Runs** (`w`): the running workflow's phases (`p`/`n`, `l` follows the live one) and its agents with their model, tools and tokens; recent runs in this project (press one to open it, `x` closes it); subagents.
  - **Stats** (`s`): every finished run of a workflow in this project: its duration trend, time per phase, and how each model's agents did. `o` shows the next workflow.
  - **Plans** (`t`): the checkpoint board for your [plans](#plans): each checkpoint's status (✓ done, ◐ partly, ○ open, – dropped) and PRs, a warning when a PR has merged but the plan still reads open, and archiving.
- **Debug** (`5`)
  - **Calls** (`t`), **Requests** (`q`), **Context** (`c`): every tool call with its time, every model request with its tokens, and how the context grew, with compactions marked.
  - **Pack** (`p`): the [pack](#packs) this repo resolved to and where each value came from. `a` lets the repo's own tools run, or stops them.
  - **Settings** (`s`): everything CCInformer does by itself, each with a switch, grouped by what it touches: Claude, questions, toasts and notifications, the pane, the background. `y` approves all, `n` denies all (then it only shows what you open), `e` has Claude explain them. The Safety switches (the band and the production status line) stay as they are under both; you switch them off by hand. Last comes the planning skills' own switch, Plan files (`f`), which both leave alone too (see [Plans](#plans)). On a new install a bare `/ccinformer` opens here until you have seen it.

An area's badge flags something worth a look, such as `!` on Code while a push would fail CI. The top right shows the version running, such as `v0.19.0`. The footer shows `Context: 34% | 5hr (4h12m): 12% | 7d (6d3h20m): 40.5%`: how full the context window is, and how much of your subscription's 5-hour and 7-day limits is used, with the time until each resets.

**The band** above the prompt warns while a process Claude started targets a shared or production environment, as your pack defines them: `⚠ STAGING  npm run dev:staging  targets a shared environment`.

## Requirements

- **Claude Code 2.1.317 or later**, the oldest version CCInformer is known to work with; releases are tested against the latest. An older one can refuse the mod with an invalid manifest error (`Unrecognized key: "types"`); `claude update` fixes that.
- **git** on the PATH.

The rest is optional; without it, only the parts that use it stay empty:

| Tool | Used for | Without it |
|---|---|---|
| `gh`, logged in (`gh auth status`) | CI in Code › Git and looking into a failed check, a budget's `ci-log` source, merged-PR warnings in Work › Plans | no CI, no CI readings, no merged-PR warnings |
| Node | the install script's auto-update step; a repo's own tools | the script leaves auto-update off, and says how to switch it on |
| Windows PowerShell (Windows) / `ps`, `/proc/meminfo`, `rm` (Linux) / `ps`, `uname`, `sysctl`, `vm_stat`, `rm` (macOS) | Now › Env's processes and memory; removing a plan's original when it's archived | Env says the process list could not be read; an archive keeps the original |
| bash (Git Bash on Windows) | the build waves of `/ccinformer:plan-feature` | build that plan in the main session instead |
| Python 3 (standard library only) | applying the changes of `/ccinformer:audit-docs` | the audit runs, but its changes can't be checked or applied |

## Install

The install script first checks the Claude Code version: an older one than Requirements names is offered `claude update`, and without a yes the script stops and shows the update commands. Then it adds this repository as a marketplace, switches on auto-update for it, and installs the mod, so later releases arrive by themselves. If git, Node or `gh` is missing, it says what each is for and offers to install it (winget on Windows; brew, apt-get, dnf or pacman elsewhere), one at a time; nothing is installed without your yes. It is safe to run again at any time: on a machine that already has the mod, it only offers the tools that are missing and updates the mod. Its last line says where the switches are: Debug › Settings (in the pane, `5` then `s`). A new install starts with them off except Safety; an update keeps yours.

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.ps1 | iex
```

Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.sh | bash
```

If the first `claude` on your PATH doesn't run, set `CLAUDE_BIN` to a working one first. If an update leaves the old version showing, an older copy earlier on PATH hides the new one: `type -a claude` (`Get-Command claude -All` on Windows) lists them.

Or install by hand, without auto-update. At the prompt of a terminal session:

```
/plugin install ccinformer --marketplace EsonOscar/CCInformer
```

Answer `y` to add the marketplace, then pick the user scope. From a shell: `claude plugin install ccinformer --marketplace EsonOscar/CCInformer`. In the desktop app, where `/plugin` doesn't run: + next to the prompt box → Plugins → Add marketplace `EsonOscar/CCInformer` → Add plugin.

One install covers both: installed at the user scope, from the script or a terminal, the mod also loads in the desktop app's Code tab.

## Use

- `/ccinformer` opens or closes the pane. `/ccinformer <area or view>` opens it there (`/ccinformer code`, `/ccinformer stats`). `/ccinformer ci active` or `ci passive` switches what a failed check leads to, and `/ccinformer ci investigate` looks into this branch's failed check now, in either mode. `/ccinformer settings` opens the switches. `/side` is a short alias.
- Ctrl+X Tab gives the pane the keyboard: `1`-`5` switch areas, the letters shown switch views and run actions, `r` refreshes and scrolls back to the top, Esc gives the keyboard back. Clicking works without it.
- In the desktop app `/ccinformer` works the same, and a click in the pane gives it the keyboard. There the pane scrolls as one page: the areas sit at its top and the usage line at its bottom, rather than staying put as they do in the terminal.

## Skills

Three planning skills come with the mod. Each plans in plan mode, asks you only the decisions that are really yours, and writes a plan whose checkpoints Work › Plans shows as the work happens.

| Skill | Use it for | What it costs |
|---|---|---|
| `/ccinformer:plan-feature <task>` | A feature worth a thorough review: several parts of the code, data, access rules | A workflow of agents: scouts, 1 to 3 planners, then critics whose findings are checked against the code. Often 10 to 20 agents, on Opus at high effort at most |
| `/ccinformer:plan-feature-small <task>` | A smaller change, or a tighter token budget | Claude reads the code and drafts the plan; one critic agent on Opus at medium effort reviews it against the code in a short workflow, a second round only after a blocker |
| `/ccinformer:plan-handoff <feature>` | Planning for someone who isn't a developer | Like plan-feature, but it asks only product questions and ends with a doc a developer builds from |

1. Switch to plan mode (Shift+Tab until the bottom of the screen says plan mode) and run the skill with what you want built.
2. Answer its questions: only real decisions, each with a recommended option.
3. Approve the plan. plan-feature and plan-feature-small save it to `.local/plans/` (unless Plan files is off in Debug › Settings) and build it checkpoint by checkpoint. Nothing is committed or pushed unless you ask.
4. Follow along in Work › Plans (`3`, then `t`), and archive the plan there once it's done.

**Planning settings.** A repo's checks, the risks to review for, the actions that need your OK and its commit rules can be written down once: in a committed `## Planning` section of its CLAUDE.md, or privately in `.local/ccinformer-planning.md`. After a first run in a repo with neither, the skill offers to write the private one for you.

**Agent models.** The skills' workflows run their agents on Opus at high effort at most, whatever model your session runs on, so a session on a larger model orchestrates and checks without fanning it out. Defaults: scouts on Sonnet at medium effort (planners and critics check what they report against the code); planners, critics, builders, reviewers, auditors and verifiers on Opus at high; the side agents a build uses for menial tasks on Sonnet at medium; plan-feature-small's one critic on Opus at medium, kept fast (`MODEL` and `EFFORT` in `skills/plan-feature-small/plan-review.js`). To change them for one run, say so in the task text (`scouts on Opus`, `builders on Sonnet`): the skill passes a `model` and `effort` per scout or work package, and the script brings anything above the cap down to it. To move the cap itself, change `MAX_MODEL` and `MAX_EFFORT` near the top of the three fan-out scripts (`skills/plan-feature/plan-fanout.js`, `skills/plan-feature/build-fanout.js`, `skills/audit-docs/audit-docs-fanout.js`) in your own clone or fork, and run that copy with `claude --plugin-dir <folder>` (CONTRIBUTING.md "Working on the mod"); the installed release is replaced on every update, so an edit there doesn't last.

**Docs audit.** `/ccinformer:audit-docs <focus>` checks a repo's docs against its code, in plan mode: any kind of doc (READMEs, contributor docs, design docs, ADRs, plans, changelogs, CLAUDE.md files), git-tracked or git-ignored. A workflow of read-only agents finds drift, stale status, history in current docs, broken references, contradictions and duplicates; you decide what is really yours to decide; the plan you approve holds every change. Once approved, a script checks each change against the docs as they were, applies them to a work folder, and installs them after a moved-text check and a review, keeping copies of the old docs in `~/.claude/audit-backups/`. Moved history goes to a history file. Its scripts need Python 3 (standard library only).

**Writing a pack.** `/ccinformer:write-pack` has Claude draft your [user pack](#packs) for the repo you're in. It reads the repo's manifests, lint and format configs, git hooks, CI workflows, deploy configs and the tests that act as rules (env files by name only, never their contents), marks each check `ci` where CI fails on it and `rule` where it's only the project's own, and lists what CI enforces that a pack can't check. The mod's own validator checks the draft (through a read-only tool, `check_pack`, that Claude calls), and nothing is written until you approve the full path in `~/.claude/ccinformer/packs/`. Claude Code then asks you to allow the write itself, as it does for anything under `~/.claude`, so a pack is written in an interactive session; elsewhere you get the text and the path to save. A pack it writes matches the repo, so the repo's own tools may run there; an existing pack for the repo is updated in place, after a `.bak` copy, never doubled. Without plan mode it asks at the end; in plan mode the plan holds the draft and its approval is the yes.

## Packs

A pack tells CCInformer about a kind of project: its processes and environments, checks, budgets and plan files. Packs are personal: nothing is read from inside the repo. Two layers, lowest first; lists merge by `id`, and the user pack's fields win:

1. **A built-in pack**: the one your user pack `extends`, else one picked from the repo's files. Today: `node-vite` (a `package.json` naming `vite`).
2. **Your user pack**, `~/.claude/ccinformer/packs/<name>.pack.jsonc`, for repos whose remote matches its `match.remote` (globs over `host/owner/repo`, e.g. `github.com/<owner>/*`). It can `extends` a built-in and `disable` ids from it. Your own values for a repo live here, outside the repo. Have Claude write one with `/ccinformer:write-pack` ([Skills](#skills)).

A pack holds only these keys: `schema`, `id`, `version`, `match`, `detect` (built-ins only), `extends`, `processes`, `environments`, `checks`, `budgets`, `noise`, `plans` and `disable`. A pack with any other key, or a value it can't use, is refused whole, and Debug › Pack lists every reason, each saying what to change.

**What a pack must hold.** Every entry has an `id`, and processes, environments, checks and budgets a `label`. Each kind has its own required fields: a check its `on`, `analyzer`, `cost` and `class`; a budget its `unit`, `direction`, `limit`, `sources` and `cost`; a `size-lines` check its `options.max`; `plans` its `globs`. Every value is of its kind (`hostPatterns` a list, `tone` one of `local`, `shared` or `prod`), and a key an entry doesn't take is refused, nested ones included, so a typo says so. A user pack needs `match.remote`; a built-in needs a `detect` rule with `"required": true`. An entry with the id of one in the built-in the user pack `extends` is read merged over it, so it names only the fields it changes.

**Regexes.** Every regex a pack holds (a process's `match`, an environment's `argRegex`, a check's `options.pattern`, a budget source's `parse`, the plan patterns) must compile, stay within 300 characters, and neither repeat a group that itself repeats or branches (`(\w+)+`, `(a|b)+`) nor hold more than two `.*` or `.+`: a heuristic, as JS has no regex timeout. A field whose value is read from a group (`parse`, `envFrom.argRegex`, `plans.prRef`) needs one. In JSONC every backslash is written twice (`"\\b"`): a single `"\b"` is a backspace, and is refused. Process and environment patterns also run in .NET on Windows, so what .NET reads differently (an escape such as `\_` or `\q`, the classes `[]` and `[^]`) is refused there.

**Repo trust.** Checks that run the repo's own tools (ESLint, a build) wait until you trust the repo: a user pack matches it, or you allow it with `a` in Debug › Pack (or `/ccinformer pack trust`). With Turn checks on in Debug › Settings they run after each turn that wrote files, and with Turn check notes on Claude is told what they find. With Ask about repo trust on, the first such check asks once per repo, and never again, whatever you answer. All three start off on a new install. A yes holds until `a` in Debug › Pack (or `/ccinformer pack untrust`) takes it back.

### Environments

The band and Now › Env place a process Claude starts by its environment: the command, with npm scripts expanded through `package.json`, matched by an environment's `argRegex`, or the hosts in the env file it reads (Vite's `.env.<mode>` for `--mode <mode>`) held against the environment's `hostPatterns`. Its `tone` (`local`, `shared` or `prod`) decides the band; a production one goes on the status line too.

### Checks

A check names an analyzer, the files it covers (`on`, minus `ignore`), when it runs (`cost`), and whether the repo's CI enforces it (`class: "ci"`) or it's only the project's rule (`"advise"`). Six analyzers so far:

- **`size-lines`** (`cost: "edit"`): a file over `options.max` lines, checked as Claude writes it. The repo's ESLint suppressions apply, and one that's no longer needed is reported.
- **`regex-lines`** (`cost: "edit"`): each line matching `options.pattern`, checked as Claude writes the file, in any language, on each line's first 2000 characters, with `options.message` as what to do instead. In JS and TS files, comments and regex literals are skipped, and a match in a template string is reported on the line ESLint reports it on. Made for design rules (no raw `<button>`, no stock palette classes): an `advise` check reaches Claude as a project rule. A `ci` check that names the ESLint rule enforcing the same ban in `rules` says "CI will fail" at once, follows that rule's suppressions, and stands in for ESLint's finding on the same line at the end of the turn.
- **`eslint-json`** (`cost: "turn"`): the repo's own ESLint, once a turn ends, over the files written in it, in a trusted repo, with the repo's suppressions applied. The built-in `node-vite` has it; like any `node <script>` command, it's skipped quietly in a repo where the script isn't installed.
- **`i18n-keysets`** (`cost: "turn"`): translation tables, flat JSON with one file per language in a folder (`da.json`, `en.json`, ...). Once a turn that wrote one ends, each table it touched must have the same keys in every language of `options.languages`, and no key another table already has, as in `"cart_empty" is missing; da.json and en.json have it`. A key added to every language over several steps of one turn gives nothing. It compares the files itself, so it needs no repo trust.
- **`sarif`** (`cost: "turn"`): any tool that writes SARIF 2.1.0, as ESLint's SARIF formatter, ruff, Semgrep, CodeQL, gcc 13 and Roslyn do. `bin` is the whole command, with `{files}` where the files written in the turn go (at most 40 a run, the rest in the next; without it the command runs once over the whole project, one run a turn, holding the heavy lane for as long as it takes, so set `timeoutMs`) and, for a tool that writes its log to a file rather than stdout, `{output}` where the mod's own file goes (`~/.claude/ccinformer/output/`, one per check, repo and session, emptied before and after each run; dotnet: `-p:ErrorLog={output}%2Cversion=2.1`, one project at a time, since a solution's projects would overwrite one log). A run's findings land on the files written in the turn; what the tool reports in other files is counted on its run line (`· 3 elsewhere`), not listed. A non-zero exit counts as findings only when an error is among them; otherwise the run is an error naming the cause, so drop flags that fail a tool on warnings alone. The repo's ESLint-format `suppressions` file applies as for `eslint-json`, for a tool that reports everything: ESLint applies its own and exits 2 on an unpruned one (unless run with `--pass-on-unpruned-suppressions`), so an ESLint SARIF check leaves `suppressions` out and takes an id of its own, with `"disable": ["eslint"]` to switch the built-in check off; `eslint-json` stays the ESLint route. An unused suppression is a warning here (no CI reads that file), reported for the files the tool looked at.
- **`problem-matcher`** (`cost: "turn"`): any tool whose output has one diagnostic per line (gcc, clang, javac, mypy, msbuild). `bin` as for `sarif` (no `{output}`), and `options.pattern`, one regex tested against each line of stdout and stderr, with the named groups `file`, `line` and `message` (required) and `column`, `severity` and `code` (optional). The severity words `error`, `fatal error`, `warning`, `warn`, `note`, `info`, `information` and `hint` are read; any other, or no `severity` group, gives `options.severity` (`error` by default). The rule is `code`, else `rules[0]`, else the check's id. The pattern follows the rules under [Regexes](#packs). Lines are tested on their first 2000 characters; past 20000 lines the run is an error. Multi-line diagnostics aren't matched.

Code › Rules draws one line per turn check with its latest run: running, waiting for trust, its error, or passed with the files and the time. The two placeholders, the group names and the severity words are the pack contract: a change to them is a breaking one.

A user pack adds checks with the repo's own values:

```jsonc
"checks": [
  { "id": "max-lines", "label": "File length", "on": ["src/**/*.{ts,tsx}"], "ignore": ["**/*.test.{ts,tsx}"],
    "analyzer": "size-lines", "cost": "edit", "class": "ci",
    "rules": ["max-lines"], "options": { "max": 500 }, "suppressions": "eslint-suppressions.json" },
  { "id": "raw-button", "label": "Raw <button>", "on": ["src/**/*.tsx"], "ignore": ["src/components/ui/**"],
    "analyzer": "regex-lines", "cost": "edit", "class": "advise",
    "options": { "pattern": "<button\\b", "message": "use <Button> from the design system" } },
  { "id": "i18n", "label": "Translation keys", "on": ["src/i18n/*.json", "src/modules/*/i18n/*.json"],
    "analyzer": "i18n-keysets", "cost": "turn", "class": "ci", "options": { "languages": ["da", "en", "sv"] } },
  { "id": "ruff", "label": "ruff", "on": ["**/*.py"],
    "analyzer": "sarif", "cost": "turn", "class": "ci", "timeoutMs": 60000,
    "bin": ["ruff", "check", "--output-format", "sarif", "{files}"] },
  { "id": "gcc", "label": "gcc", "on": ["native/**/*.c"],
    "analyzer": "problem-matcher", "cost": "turn", "class": "ci", "timeoutMs": 120000,
    "bin": ["gcc", "-fsyntax-only", "{files}"],
    "options": { "pattern": "^(?<file>(?:[A-Za-z]:)?[^:]+):(?<line>\\d+):(?:(?<column>\\d+):)?\\s+(?:fatal\\s+)?(?<severity>error|warning|note):\\s+(?<message>.*?)(?:\\s+\\[(?<code>-W[^\\]]+)\\])?$" } }
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
- **Its status** comes from the markers on its own line: done for `merged as #N`, a check-mark emoji, done or passed (but not "done when", a checkpoint's exit criterion), or a struck-through id; dropped for dropped, superseded or obsolete; partly for a yellow-circle emoji or PARTLY; otherwise open. A pack can set its own patterns with `plans.checkpoint`, `plans.done` and `plans.prRef`.
- **Merged PRs.** With `gh`, the board checks the PRs that open checkpoints name. A merged one shows `⚠ #21 merged` on its row and `!` on Work, and a toast says so when it merges while you work. The plan's own status is left as it is.
- **Finished plans** (every checkpoint done or dropped) read "ready to archive", with a reminder toast at most once a day.
- **Archiving.** Press a plan's header, then `a`. It asks first, naming every file it will change, then moves the plan to `.local/plans/archive/` (or the pack's `plans.archiveDir`) and points the references to it there, in `.local/`, the plan's folder and your Claude memory notes for this project.
- **Plan files off.** The Plan files switch in Debug › Settings (`f`) is the planning skills' own, kept for every repo in `~/.claude/ccinformer/skills.json` (`{ "planFiles": false }`; no file means on), which the skills read as a file. Off, plan-feature and plan-feature-small save no plan to `.local/plans/` and keep the checkpoint lines in Claude Code's own plan file instead, plan-handoff still writes its handoff doc, and none of them offers to write `.local/ccinformer-planning.md`; the empty board says so. Approve all and Deny all leave it as it is.

## Numbers

- **Context** (`ctx`) is what one request carried in: an agent's figure is its latest request's, as Claude Code's workflow bar counts it; a run's total is the bar's own.
- **Output** (`↓`) is what the model generated, summed over requests: this is what an agent's time mostly goes to.
- Debug › Requests sums every request's input, cache reads included: what was processed, not how full the context is.

## Changing it

See [CONTRIBUTING.md](CONTRIBUTING.md): how to try a working copy, the code layout, what the mod polls and when, and the flow for PRs and versions.

## License

MIT
