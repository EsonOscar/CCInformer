# CCInformer

A Claude Code mod: a pane docked on the right of the terminal (a quarter of its width), with four tabs.

- **Git**: branch, upstream and ahead/behind, when it last fetched (`u` fetches), and a warning while a rebase, merge, cherry-pick or revert is in progress. CI for the branch's open PR, with its review, merge state and size (or the commit's Actions runs); a failed check links to its run. The newest runs on the branch it merges into. Every change grouped as git does (conflicts, staged, unstaged, untracked): compact, `f` shows all, pressing a file shows its diff under it, `d` opens Claude Code's `/diff`. The commits a push would send and those waiting upstream, recent commits, other branches, stashes, worktrees. When a commit's checks finish, a toast and a desktop notification say how it went (one session pings for all).
- **Agents** › **Runs** (`w`): the running workflow with its phases (click a chip, or `p`/`n`, `l` to follow the live one), a timeline of its agents, and each agent's model, tools, context and output tokens. A list of runs from this session and the project's recent sessions, read from the run records Claude Code writes; click one to see it in full (`x` closes it). Ordinary subagents below.
- **Agents** › **Stats** (`s`): every finished run of a workflow in this project (`o` for the next workflow). Full runs and partial ones (a re-check) are averaged apart; a trend of the full runs' durations; each phase's average time and share of the run; per phase, how each model's agents did (time and context per agent, over the agents that ran rather than being replayed from cache).
- **Sessions**: the other Claude sessions on this machine, those in this folder first, with what each is working on. A warning shows when another session is working in this folder.
- **Debug**: every tool call with its run time; every model request with its tokens; how the main conversation's context grew, against its window, with compactions marked.

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

- `/side` opens or closes the pane; `/side git|agents|sessions|debug` opens it on a tab.
- Ctrl+X Tab gives it the keyboard: `1`-`4` switch tabs, `r` refreshes, Esc gives the keyboard back. Clicking works without that.

## Numbers

- **Context** (`ctx`) is what one request carried in: an agent's figure is its latest request's, as Claude Code's workflow bar counts it; a run's total is the bar's own.
- **Output** (`↓`) is what the model generated, summed over requests: this is what an agent's time mostly goes to.
- Debug's Requests view sums every request's input, cache reads included: what was processed, not how full the context is.

## Polling

A session counts as active while a turn runs, for 3 minutes after one, and while the pane is being used (mods can't see whether the terminal is in front). Git is polled every 5 s only while the pane is open, on the Git tab, in an active session; otherwise it refreshes after Claude changes files, on activity, or on `r`. CI is polled every 8 s while checks run and for 3 minutes after a push (also with the pane closed, for the ping), every 60 s on an active Git tab, and not otherwise.

## Where things live

- `hooks/register.tsx`: every hook and every call on `$` (the validator requires them in one module, with the state atoms). Views in `hooks/view-*.tsx`; plain logic in `parse.ts`, `phases.ts`, `records.ts`, `insight.ts`, `rows.ts`, `collect.ts`, `format.ts`.
- The mod's own state is kept per session; the tab, the open pane, CI pings and the session list are in the store all sessions share (`~/.claude/plugins/store/`).

## Changing it

See [CONTRIBUTING.md](CONTRIBUTING.md) for the flow, titles and versions. To try a change before it's released, start one session with the working copy loaded (`claude --plugin-dir <folder>`); a session started that way reloads the mod when a file is saved. Load the `plugin-authoring` skill before changing the mod, and check with `claude plugin validate --strict .` and `claude plugin test .`. Rules the validator holds a mod to: `$` is never passed to a helper (write `$.noun.method()` where it is used), state atoms live in the file that reads and writes them, and types are imported with `import type`.

## License

MIT
