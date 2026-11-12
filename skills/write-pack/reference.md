# Pack reference

How each pack setting works. Every setting, with an example, is in `pack-template.jsonc` next to this file.

## What a pack holds

A pack tells CCInformer about a kind of project: its processes and environments, checks, budgets and plan files. Packs are personal: nothing is read from inside the repo. Two layers, lowest first; lists merge by `id`, and the user pack's fields win:

1. **A built-in pack**: the one your user pack `extends`, else one picked from the repo's files. Today: `node-vite` (a `package.json` naming `vite`) and `godot-csharp` (a `project.godot` with a `[dotnet]` section).
2. **Your user pack**, `~/.claude/ccinformer/packs/<name>.pack.jsonc`, for repos whose remote matches its `match.remote` (globs over `host/owner/repo`, e.g. `github.com/<owner>/*`). It can `extends` a built-in and `disable` ids from it. Your own values for a repo live here, outside the repo. Have Claude write one with `/ccinformer:write-pack` ([Skills](../../README.md#skills)).

A pack holds only these keys: `schema`, `id`, `version`, `match`, `detect` (built-ins only), `extends`, `processes`, `environments`, `checks`, `budgets`, `noise`, `plans` and `disable`. A pack with any other key, or a value it can't use, is refused whole, and Debug › Pack lists every reason, each saying what to change.

**What a pack must hold.** Every entry has an `id`, and processes, environments, checks and budgets a `label`. Each kind has its own required fields: a check its `on`, `analyzer`, `cost` and `class`; a budget its `unit`, `direction`, `limit`, `sources` and `cost`; a `size-lines` check its `options.max`; `plans` its `globs`. Every value is of its kind (`hostPatterns` a list, `tone` one of `local`, `shared` or `prod`), and a key an entry doesn't take is refused, nested ones included, so a typo says so. A user pack needs `match.remote`; a built-in needs a `detect` rule with `"required": true`. An entry with the id of one in the built-in the user pack `extends` is read merged over it, so it names only the fields it changes.

## Regexes

Every regex a pack holds (a process's `match`, an environment's `argRegex`, an approval's `commandRegex` and `inputRegex`, a check's `options.pattern`, a budget source's `parse`, a noise rule's `normalize`, the plan patterns) must compile, stay within 300 characters, and neither repeat a group that itself repeats or branches (`(\w+)+`, `(a|b)+`) nor hold more than two `.*` or `.+`: a heuristic, as JS has no regex timeout. A field whose value is read from a group (`parse`, `envFrom.argRegex`, `plans.prRef`) needs one. In JSONC every backslash is written twice (`"\\b"`): a single `"\b"` is a backspace, and is refused. Process and environment patterns also run in .NET on Windows, so what .NET reads differently (an escape such as `\_` or `\q`, the classes `[]` and `[^]`) is refused there.

## Repo trust

Checks that run the repo's own tools (ESLint, a build) wait until you trust the repo; the ones compared inside the mod (translation keys, Godot scenes) don't: a user pack matches it, or you allow it with `a` in Debug › Pack (or `/ccinformer pack trust`). With Turn checks on in Debug › Settings they run after each turn that wrote files, and with Turn check notes on Claude is told what they find. With Ask about repo trust on, the first such check asks once per repo, and never again, whatever you answer. All three start off on a new install. A yes holds until `a` in Debug › Pack (or `/ccinformer pack untrust`) takes it back.

## Environments

The band and Now › Env place a process Claude starts by its environment: the command, with npm scripts expanded through `package.json`, matched by an environment's `argRegex`, or the hosts in the env file it reads (Vite's `.env.<mode>` for `--mode <mode>`) held against the environment's `hostPatterns`. Its `tone` (`local`, `shared` or `prod`) decides the band; a production one goes on the status line too. `readOnly` has no effect yet: the approval rules decide what is gated.

## Approval gates

An environment can list `approvals`: tool calls that need your OK, such as a staging migration, a write through a database's MCP tool, or a deploy. A rule names a `tool`, a name or glob such as `Bash` or `mcp__*__execute_sql` (one shell tool names them all, so a `Bash` rule also meets the same command run through PowerShell or Monitor), and narrows it with any of these, all of which must match:

- `commandRegex`: each command of a shell line, plus `npm run <name>` and that script's own commands as lines of their own. Anchor it (`^npm run db:migrate:staging\\b`), and match what the script targets as well, so running its body directly is caught too.
- `inputRegex`: an MCP call's arguments, one `key=value` line each (`^project_id=<ref>$`). A tool that takes no such argument needs a rule on its name alone.
- `pathGlob`: the repo path an Edit, Write or NotebookEdit writes.

A matching call stops for a question: **Deny**, **Approve once**, and **Approve for this session** for a rule with `"scope": "session"`. Only those labels approve: text typed under "Other", a dismissed question, one left until Claude Code's away-from-keyboard timeout, a `-p` run or a gate that fails all refuse the call, and Claude is told why. A rule with `"mode": "log"` runs with no question and is still logged, which suits reads. In default mode Claude Code's own permission prompt may follow the gate's; in auto mode the gate asks only for what a rule names, so edits, local tests and git never stop.

Every gated call leaves one line in `~/.claude/ccinformer/approvals/<repo>/<session>.jsonl` (a new file every 128 KiB or so): the time, the environment and rule, the tool, the script that matched (`npm run db:migrate:staging`, never the command line or a value), the folder, the branch and the answer (`approved`, `approved-session`, `session`, `logged`, `denied`, `other`, `no answer`, `busy` or `error`). The answer is what was said at the gate; Claude Code can still refuse the call after it. Nothing deletes old logs yet.

A built-in pack's shared and prod rules ask every time; only your own pack can make one `log` or `session`, and Debug › Pack shows such a prod rule in amber, beside every rule's environment and what the gate does with it. When a user pack is refused, a toast says so, as its rules then don't apply. The gates are a Safety switch in Debug › Settings, on unless you switch it off.

Limits: a pack's rules apply only in sessions started in the repo it matches, so a session started elsewhere reaches the same MCP connectors and hosts unasked; a route to a target that no rule names isn't gated; and nothing guards the packs folder or the log itself.

## Checks

A check names an analyzer, the files it covers (`on`, minus `ignore`), when it runs (`cost`), and whether the repo's CI enforces it (`class: "ci"`) or it's only the project's rule (`"advise"`). Eight analyzers so far:

- **`size-lines`** (`cost: "edit"`): a file over `options.max` lines, checked as Claude writes it. The repo's ESLint suppressions apply, and one that's no longer needed is reported.
- **`regex-lines`** (`cost: "edit"`): each line matching `options.pattern`, checked as Claude writes the file, in any language, on each line's first 2000 characters, with `options.message` as what to do instead. In JS and TS files, comments and regex literals are skipped, and a match in a template string is reported on the line ESLint reports it on. Made for design rules (no raw `<button>`, no stock palette classes): an `advise` check reaches Claude as a project rule. A `ci` check that names the ESLint rule enforcing the same ban in `rules` says "CI will fail" at once, follows that rule's suppressions, and stands in for ESLint's finding on the same line at the end of the turn.
- **`eslint-json`** (`cost: "turn"`): the repo's own ESLint, once a turn ends, over the files written in it, in a trusted repo, with the repo's suppressions applied. The built-in `node-vite` has it; in a repo where ESLint isn't installed, it's skipped (see below).
- **`i18n-keysets`** (`cost: "turn"`): translation tables, flat JSON with one file per language in a folder (`da.json`, `en.json`, ...). Once a turn that wrote one ends, each table it touched must have the same keys in every language of `options.languages`, and no key another table already has, as in `"cart_empty" is missing; da.json and en.json have it`. A key added to every language over several steps of one turn gives nothing. It compares the files itself, so it needs no repo trust.
- **`tscn-connections`** (`cost: "turn"`): Godot scenes against their C# scripts. Once a turn that wrote a scene, or a script a scene uses, ends, each `[connection]` whose method the target node's script doesn't declare (with its partial parts and the repo's base classes, three levels deep) is reported at its line, as in `connection "pressed" from PlayButton calls OnLeavePressed, which atrium/Lobby.cs doesn't declare`. A target that is an instanced scene or has no C# script, a lowercase engine method (`hide`), and a class chain still in the repo three levels up are skipped. `on` covers both, e.g. `["**/*.tscn", "**/*.cs"]`; no options. It compares the files inside the mod (and reads git for which scenes use a script), so it needs no repo trust; use `class: "advise"` unless CI builds and runs the scenes.
- **`tscn-nodepaths`** (`cost: "turn"`): a `GetNode`, `GetNodeOrNull`, `HasNode`, `FindChild` or `new NodePath` string, or a `"%Name"`, in C# that names a node removed from a scene since the last commit and gone from every other scene, reported at the C# line. Read-only git (`git diff`, `git show`, `git grep`), no repo trust; `on` and `class` as above. It compares names, so a node moved under another parent with its name kept isn't flagged, a removal already committed is no longer one, a name another scene still uses counts as present, a scene over 4 MiB is skipped (and counted on the run line), and an edit made outside Claude's writes is checked at the next turn that writes a covered file.
- **`sarif`** (`cost: "turn"`): any tool that writes SARIF 2.1.0, as ESLint's SARIF formatter, ruff, Semgrep, CodeQL, gcc 13 and Roslyn do. `bin` is the whole command, with `{files}` where the files written in the turn go (at most 40 a run, the rest in the next; without it the command runs once over the whole project, one run a turn, holding the heavy lane for as long as it takes, so set `timeoutMs`) and, for a tool that writes its log to a file rather than stdout, `{output}` where the mod's own file goes (`~/.claude/ccinformer/output/`, one per check, repo and session, emptied before and after each run; dotnet: `-p:ErrorLog={output}%2Cversion=2.1`, one project at a time, since a solution's projects would overwrite one log). A run's findings land on the files written in the turn; what the tool reports in other files is counted on its run line (`· 3 elsewhere`), not listed. A non-zero exit counts as findings only when an error is among them; otherwise the run is an error naming the cause, so drop flags that fail a tool on warnings alone. The repo's ESLint-format `suppressions` file applies as for `eslint-json`, for a tool that reports everything: ESLint applies its own and exits 2 on an unpruned one (unless run with `--pass-on-unpruned-suppressions`), so an ESLint SARIF check leaves `suppressions` out and takes an id of its own, with `"disable": ["eslint"]` to switch the built-in check off; `eslint-json` stays the ESLint route. An unused suppression is a warning here (no CI reads that file), reported for the files the tool looked at.
- **`problem-matcher`** (`cost: "turn"`): any tool whose output has one diagnostic per line (gcc, clang, javac, mypy, msbuild). `bin` as for `sarif` (no `{output}`), and `options.pattern`, one regex tested against each line of stdout and stderr, with the named groups `file`, `line` and `message` (required) and `column`, `severity` and `code` (optional). The severity words `error`, `fatal error`, `warning`, `warn`, `note`, `info`, `information` and `hint` are read; any other, or no `severity` group, gives `options.severity` (`error` by default). The rule is `code`, else `rules[0]`, else the check's id. The pattern follows the rules under [Regexes](#regexes). Lines are tested on their first 2000 characters; past 20000 lines the run is an error. Multi-line diagnostics aren't matched.

Before a turn check runs, and before the trust question, the mod looks for its program the way the system would, by reading files only: a `node <script>` command's script in the repo, a command written with a slash (`./gradlew`) under the repo or at its absolute path, and a bare name (`dotnet`, `ruff`) in each `PATH` folder, with each `PATHEXT` extension on Windows. A check whose program isn't there is skipped: nothing runs, trust isn't asked, Claude isn't told, and its run line says so, dim, as in `dotnet build: skipped, dotnet isn't installed`. A bare name's answer holds for the session, since `PATH` doesn't change under a running Claude Code; a repo path is looked at again each turn, so installing ESLint in the repo takes effect at the next one.

Code › Rules draws one line per turn check with its latest run (the scene checks too, the translation-key check not): running, skipped, waiting for trust, its error, or passed with the files and the time. The two placeholders, the group names and the severity words are the pack contract: a change to them is a breaking one.

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

## Budgets

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

## Noise

Files a tool writes, and files an editor rewrites on save, are the pack's `noise`. They clutter what changed without being changes anyone made.

- **`generated`**: a glob of output (`**/.godot/**`, `dist/**`, `**/*.import`). A changed file under it is noise, whatever changed; `normalize` is ignored here.
- **`editor-rewrite`**: a glob of files an editor renumbers or re-ids when it saves them (`**/*.{tscn,tres}`), with `normalize`, regexes taken out of the removed and added lines before they're compared. For each hunk of the file's diff against HEAD, the removed lines must equal the added ones once each match is gone (runs of spaces then count as one, so `uid="[^"]*"` needs no leading space), in order. So a scene that only gained a `uid=` or renumbered `load_steps=` is noise, while a changed `ext_resource` path, a moved block or a binary change is not. Only modified files are judged (not added, deleted, renamed or conflicted ones), at most 100 at a time, each again only when it or HEAD changes.

Noise is folded out of Code › Git's changed files and its counts (`f` shows it, tagged `generated` or `editor rewrite`), and left out of the diff active CI hands Claude, which names what it left out. A conflict is never folded. Noise never hides a finding: the checks follow their own globs.

## Plans

The board reads every Markdown plan in `.local/plans/`, in every repo, and the files a pack's `plans.globs` names, leaving out their archive folders. It writes to plans only when you archive one.

- **A checkpoint** is an id (`CP3`, `C7`, `R3a`, `PR 4`) at the start of a heading, a table row's first cell, or a bold label, followed by punctuation: `### R3: foundation`, `| C7 | ... |`, `- **CP1, storage:**`. A range (`CP1–CP3`) defines each id in it.
- **Its status** comes from the markers on its own line: done for `merged as #N`, a check-mark emoji, done or passed (but not "done when", a checkpoint's exit criterion), or a struck-through id; dropped for dropped, superseded or obsolete; partly for a yellow-circle emoji or PARTLY; otherwise open. A pack can set its own patterns with `plans.checkpoint`, `plans.done` and `plans.prRef`.
- **Merged PRs.** With `gh`, the board checks the PRs that open checkpoints name. A merged one shows `⚠ #21 merged` on its row and `!` on Work, and a toast says so when it merges while you work. The plan's own status is left as it is.
- **Finished plans** (every checkpoint done or dropped) read "ready to archive", with a reminder toast at most once a day.
- **Archiving.** Press a plan's header, then `a`. It asks first, naming every file it will change, then moves the plan to `.local/plans/archive/` (or the pack's `plans.archiveDir`) and points the references to it there, in `.local/`, the plan's folder and your Claude memory notes for this project. An archive folder under `.local/` that git doesn't ignore is refused, with nothing written; a plan that leaves `.local/` for a folder outside it is named so in the question.
- **Plan files off.** The Plan files switch in Debug › Settings (`f`) is the planning skills' own, kept for every repo in `~/.claude/ccinformer/skills.json` (`{ "planFiles": false }`; no file means on), which the skills read as a file. Off, plan-feature and plan-feature-small save no plan to `.local/plans/` and keep the checkpoint lines in Claude Code's own plan file instead, plan-handoff still writes its handoff doc, and none of them offers to write `.local/ccinformer-planning.md`; the empty board says so. Approve all and Deny all leave it as it is.
