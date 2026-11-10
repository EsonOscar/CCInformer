# CCInformer

A side pane for Claude Code, docked on the right of the terminal or of the desktop app's Code tab: your sessions and processes, git and CI, workflow runs and plans, and checks on what Claude writes.

Everything it does by itself has a switch in Debug › Settings. A new install starts with them all off except Safety (the band, the production status line, the approval gates) and Plan files.

## Areas

The digits shown switch areas; the letters shown switch views and run actions.

- **Now** (`1`)
  - **Env** (`e`): the processes this session started and the environment each targets, the processes your pack knows with their memory, a Godot game's [telemetry](#godot-telemetry), and free memory.
  - **Sessions** (`s`): the other Claude sessions on this machine that have Tell other sessions on, and what each is working on.
- **Code** (`2`)
  - **Git** (`g`): branch, changed files (press one for its diff, `f` shows all, `d` opens `/diff`), commits, branches, and CI for the PR. `u` fetches.
    - `i` switches active CI for the repo: with Look into failed CI on, Claude looks into a failed check in a read-only turn (it uses tokens).
  - **Rules** (`k`), when your pack has checks: what they found in the files Claude wrote. `x` dismisses the selected one.
  - **Budgets** (`b`), when your pack has budgets: each against its limit. `m` builds, then measures.
- **Work** (`3`)
  - **Runs** (`w`): the running workflow's phases (`p`/`n`, `l` follows the live one) and agents (`ctx`: the latest request's context, `↓`: output tokens); recent runs (`x` closes one).
  - **Stats** (`s`): finished runs of a workflow: duration, time per phase, results per model. `o` shows the next workflow.
  - **Plans** (`t`): the checkpoints of your [plans](#skills) and their status. Select a plan, then `a` archives it.
- **Debug** (`5`)
  - **Calls** (`t`), **Requests** (`q`), **Context** (`c`): tool calls, model requests and how the context grew.
  - **Pack** (`p`): the [pack](#packs) in use and where each value came from. `a` lets the repo's own tools run, or stops them.
  - **Settings** (`s`): a switch for each thing the mod does by itself. `y` turns all on, `n` all off (Safety and the planning skills' settings stay as they are), `e` has Claude explain them, `f` switches the planning skills' plan files. Under **Workflow agents**, a press on a model or effort sets what that kind of agent runs on in the skills' workflows (Opus at high effort at most); `d` returns them all to default.

**The band** above the prompt warns while a process Claude started targets a shared or production environment; while you have collapsed it, a new one comes as a toast. **[Approval gates](#approval-gates)** ask about, or log, the tool calls your pack names.

The footer shows context use and your 5-hour and 7-day limits, with the time until each resets.

## Requirements

- Claude Code 2.1.317 or later, and git.
- Optional: `gh`, logged in, for CI; Node 16 or later for auto-update; Python 3 for `/ccinformer:audit-docs`; Git Bash on Windows for `/ccinformer:plan-feature`'s build waves.

## Install

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.ps1 | iex
```

Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/EsonOscar/CCInformer/main/install/install.sh | bash
```

The script checks your Claude Code version, offers to install missing tools (only with your yes), and installs the mod, with auto-update on when Node 16 or later is there. It is safe to run again.

If the first `claude` on your PATH doesn't run, set `CLAUDE_BIN` to one that does.

By hand, without auto-update: `/plugin install ccinformer --marketplace EsonOscar/CCInformer` at the user scope. In the desktop app: + next to the prompt box → Plugins → Add marketplace `EsonOscar/CCInformer` → Add plugin. One install covers both.

## Use

- `/ccinformer` opens or closes the pane; `/ccinformer <area or view>` opens it there (`/ccinformer stats`). `/side` is an alias.
- `/ccinformer ci active`, `ci passive` or `ci investigate`: what a failed check leads to, or look into one now.
- `/ccinformer pack trust` or `pack untrust`: let the repo's own tools run, or stop them.
- `/ccinformer pack install-telemetry`: add [Godot telemetry](#godot-telemetry) to a game (it asks first).
- Ctrl+X Tab gives the pane the keyboard, Esc gives it back; `r` refreshes. Clicking always works.

## Skills

| Skill | For |
|---|---|
| `/ccinformer:plan-feature <task>` | Thorough planning by a workflow of agents (often 10 to 20), then the build |
| `/ccinformer:plan-feature-small <task>` | Smaller tasks: Claude plans, one critic agent reviews, then the build |
| `/ccinformer:plan-handoff <feature>` | Planning for someone who isn't a developer, ending in a doc a developer builds from |
| `/ccinformer:audit-docs <focus>` | Checks a repo's docs against its code, then fixes what you approve |
| `/ccinformer:write-pack` | Drafts your [pack](#packs) for the repo you're in |

Run the planning skills in plan mode. plan-feature and plan-feature-small save an approved plan to `.local/plans/`, followed in Work › Plans (unless Plan files is off); plan-handoff writes a doc for a developer. Nothing is committed unless you ask. Which model and effort the skills' agents run on is set in Debug › Settings; your session's own model stays `/model`'s.

A repo's planning settings go in a `## Planning` section of its CLAUDE.md, or in `.local/ccinformer-planning.md`.

A hand-written plan in `.local/plans/` works too: a checkpoint is an id (`CP3`, `C7`) at the start of a heading, a table row or a bold label, with its status (`done`, `merged as #N`, `dropped`) on that line.

## Packs

A pack tells CCInformer about a kind of project: its processes and environments, checks, budgets, noise and plan files. Packs are personal: nothing is read from inside a repo.

- **A built-in pack**, picked from the repo's files. Today: `node-vite` (a `package.json` naming `vite`) and `godot-csharp` (a `project.godot` with a `[dotnet]` section).
- **Your user pack**, `~/.claude/ccinformer/packs/<name>.pack.jsonc`, for the repos whose remote it matches. It can extend a built-in, and its values win. `/ccinformer:write-pack` drafts one.

Every setting, with what it does: [the template](skills/write-pack/pack-template.jsonc). How each works: [the pack reference](skills/write-pack/reference.md).

A pack with a mistake is refused whole, and Debug › Pack says what to change. Checks that run the repo's own tools (ESLint, a build) wait until you trust the repo: a matching user pack does, or `a` in Debug › Pack.

### Approval gates

An environment's `approvals` rules name tool calls (a shell command, an MCP call by its arguments, a written path) that need your OK.

- A matching call stops for **Deny**, **Approve once** or, for a session rule, **Approve for this session**. With `"mode": "log"` it runs unasked.
- Anything but those labels (typed text, no answer, `-p`, a failure) refuses the call.
- Each gated call adds a line to a log under `~/.claude/ccinformer/approvals/`, in files named by session, never the command or its values.

A built-in pack's shared and prod rules always ask; only your own pack can loosen one, shown in amber in Debug › Pack. Rules apply only in sessions started in the matched repo, and a route no rule names isn't gated.

## Godot telemetry

In a Godot C# game, `/ccinformer pack install-telemetry` asks, then adds `addons/ccinformer/ccinformer_telemetry.gd`, its `[autoload]` line in `project.godot`, and `.local/telemetry/`. Git must ignore that folder, or nothing is written.

While the game runs from the project (the editor or `godot --path .`, never an export), Now › Env shows its FPS, the slowest frame of each second (vsync wait included, as Godot measures it) and errors (Godot 4.5 or later).

- `c` asks the game for a screenshot (at most 1280 px wide, the newest 10 kept) and puts it in your prompt as an `@` mention.
- `t` puts `telemetry.json` in your prompt, so Claude reads the numbers and the errors.

If a mention doesn't attach, its text still names the file for Claude to read. To remove telemetry, delete the `[autoload]` line, `addons/ccinformer/` and `.local/telemetry/`.

## Changing it

See [CONTRIBUTING.md](CONTRIBUTING.md): how to try a working copy, the code layout, what the mod polls and when, and the flow for PRs and versions.

## License

MIT
