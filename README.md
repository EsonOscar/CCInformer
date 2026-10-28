# CCInformer

A Claude Code mod: a pane docked on the right of the terminal (a quarter of its width), in five areas, switched with `1`-`5`. An area shows once it has something built; Timeline (`4`) has nothing yet, so it isn't drawn, and the digits stay where they are.

- **Now** (`1`) › **Sessions**: the other Claude sessions on this machine, those in this folder first, with what each is working on. A warning shows when another session is working in this folder.
- **Code** (`2`) › **Git**: branch, upstream and ahead/behind, when it last fetched (`u` fetches), and a warning while a rebase, merge, cherry-pick or revert is in progress. CI for the branch's open PR, with its review, merge state and size (or the commit's Actions runs); a failed check links to its run. The newest runs on the branch it merges into. Every change grouped as git does (conflicts, staged, unstaged, untracked): compact, `f` shows all, pressing a file shows its diff under it, `d` opens Claude Code's `/diff`. The commits a push would send and those waiting upstream, recent commits, other branches, stashes, worktrees. When a commit's checks finish, a toast and a desktop notification say how it went (one session pings for all).
- **Work** (`3`) › **Runs** (`w`): the running workflow with its phases (click a chip, or `p`/`n`, `l` to follow the live one), a timeline of its agents, and each agent's model, tools, context and output tokens. A list of runs from this session and the project's recent sessions, read from the run records Claude Code writes; click one to see it in full (`x` closes it). Ordinary subagents below.
- **Work** (`3`) › **Stats** (`s`): every finished run of a workflow in this project (`o` for the next workflow). Full runs and partial ones (a re-check) are averaged apart; a trend of the full runs' durations; each phase's average time and share of the run; per phase, how each model's agents did (time and context per agent, over the agents that ran rather than being replayed from cache).
- **Debug** (`5`) › **Calls** (`t`), **Requests** (`q`), **Context** (`c`): every tool call with its run time (a wait for your approval included); every model request with its tokens; how the main conversation's context grew, against its window, with compactions marked.

Each area keeps its selected row (a pressed file in Code, a picked run in Work) while another area shows; the keys that act on a row act on that one.

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

- `/ccinformer` opens or closes the pane. `/ccinformer now|code|work|debug` opens it on an area, and a view's name opens its area on that view (`/ccinformer stats`); the old tab names (`git`, `agents`, `sessions`) still work. With an argument it never closes the pane. `/side` is a short alias for the same thing.
- Ctrl+X Tab gives it the keyboard: `1`-`5` switch areas, the letters shown switch an area's views and run its actions, `r` refreshes, Esc gives the keyboard back. A key is used once per area. Clicking works without that.

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

Commands run in two lanes. Quick reads (git, gh) share the light lane, up to 4 at once, each given 20 s; long jobs take the heavy lane one at a time (a fetch gets 60 s), so a fetch never holds up the reads. A poll that comes due while its last run is still busy is skipped, so a slow `gh` never piles up calls.

## Where things live

- `hooks/register.tsx`: every hook and every call on `$` (the validator requires them in one module, with the state atoms). Views in `hooks/view-*.tsx`; plain logic in `parse.ts`, `phases.ts`, `records.ts`, `insight.ts`, `rows.ts`, `collect.ts`, `format.ts`, and `core/` (the exec lanes in `core/lanes.ts`, through which every command runs).
- `hooks/areas.ts`: the areas, their views and every key; views take their hotkeys from it, and a test holds each key to one use per area.
- The mod's own state is kept per session; the area, the open pane, CI pings and the session list are in the store all sessions share (`~/.claude/plugins/store/`).

## Changing it

See [CONTRIBUTING.md](CONTRIBUTING.md) for the flow, titles and versions. To try a change before it's released, start one session with the working copy loaded (`claude --plugin-dir <folder>`); that session runs the working copy in place of the installed release, reloads it when a file is saved, and its pane says `CCInformer · dev`. Other sessions keep the release. The working copy keeps its own store, so its Sessions tab sees only other sessions running a working copy. Load the `plugin-authoring` skill before changing the mod, and check with `claude plugin validate --strict .` and `claude plugin test .`. Rules the validator holds a mod to: one hooks module, `hooks/register.tsx`, which declares every state atom it reads and writes; `$` is passed only to a function declaration (`function f($, …)`), at the top of that file or imported from another file of the mod, never to an arrow function; and types are imported with `import type`.

## License

MIT
