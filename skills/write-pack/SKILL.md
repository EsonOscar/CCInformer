---
name: write-pack
description: Draft a CCInformer user pack for the repo you're in, from its files and its CI, checked by the mod's own validator, and write it to the person's packs folder once they approve the path. Reads manifests, lint and format configs, git hooks, CI workflows, deploy configs and tests that act as rules; never reads env files or secrets; never writes a second pack for the same repo, and keeps a copy before it updates one. Use when the user asks for a CCInformer pack, wants CCInformer fitted to a repo, or runs /ccinformer:write-pack.
argument-hint: <optional focus, e.g. "only the checks">
---

Write a pack. Focus, if any: $ARGUMENTS

A user pack tells CCInformer about one repo: which commands are dev servers and which environment they point at, which checks to run on the files Claude writes (and whether CI enforces them), which numbers to keep under a limit, and where the plan files are. It lives outside the repo, in the person's packs folder, and only matches repos by their remote. README.md's "Packs" section is the reference; `${CLAUDE_SKILL_DIR}/pack-template.jsonc` has every setting with what it does.

The mod checks drafts with its own tool, `mcp__ccinformer__check_pack`: it reads the repo and the packs folder, validates the text you give it with the same rules the mod loads packs by, and writes nothing.

## Steps

1. **The tool.** If `mcp__ccinformer__check_pack` isn't among your tools, load it with ToolSearch `select:mcp__ccinformer__check_pack`. If neither works, say that CCInformer isn't loaded in this session (it needs 0.30.0 or later) and stop: never write a pack the mod hasn't checked.
2. **Look first.** Call the tool with no arguments. Its JSON gives `repo.remote` (the repo as `host/owner/repo`), `packsDir` (the absolute packs folder), `packs` (every pack there, valid or not, each with `matchesRepo`, and the `text` of this repo's own, so you never read that folder yourself) and `builtins` (each built-in pack, `detected` for the one whose stack this repo has, and its full entries).
   - If `repo.remote` is empty, say: "User packs are matched by the repo's remote, and this repo has none. Add one (`git remote add origin <url>`) and run /ccinformer:write-pack again." Then stop.
   - A pack in `packs` with `matchesRepo` is this repo's pack, even a refused one: it is what you update (step 8), never a second file.
3. Read the repo as **Shared: reading the repo** says, decide each finding as **Shared: ci or advise** says, map it as **Shared: from the repo to the pack** says, and write regexes as **Shared: regexes in JSONC** says.
4. **Draft fresh, from the repo.** Start from:
   ```jsonc
   { "schema": 1, "id": "<repo name>", "version": "1", "match": { "remote": ["<repo.remote>"] }, "extends": ["<the detected built-in>"] }
   ```
   (no `extends` when no built-in is detected), and add only entries a file in the repo backs, each with the `file:line` it comes from. Never copy from an existing pack or from the template's values: the template is a reference (**Shared: the template**).
5. **Check it.** Call the tool with `text` (the whole JSONC, exactly as it would be saved) and `file` (`<id>.pack.jsonc`). Fix what `draft.reasons` says; each reason says how. At most 5 rounds; if reasons are left, show them with the draft and stop without writing.
   - `draft.exists` with `draft.existsMatchesRepo` false: that name is another repo's pack. Pick another (`<owner>-<repo>.pack.jsonc`) and check again; never write over it.
   - `draft.shadowedBy`: another pack for this repo loads first. That one is the update target (step 8).
6. **Show the draft**, in this order:
   - the JSONC;
   - a table: each entry, its `class` where it has one, and the `file:line` it comes from;
   - "CI enforces, the pack doesn't check": every CI step left out, with why (**Shared: ci or advise**);
   - what you left out and why (an environment's hosts, a check no analyzer fits).

   Before asking, check that no template value survived: `example.test`, `<owner>`, `<repo>`, `acme`.
7. **Ask before writing**, always, with the absolute path. With AskUserQuestion:
   - New pack: "Write this pack to `<packsDir>/<file>`? A user pack that matches this repo also lets CCInformer run the repo's own tools (the checks with a command)." Options: "Write it (Recommended)", "Change something first", "Don't write; show the text only".
   - Update (step 8): "Update `<path>`? A copy goes to `<path>.<YYYYMMDD>.bak` first." The same options.

   The packs folder is outside the repo, so Claude Code may also ask to allow the write itself; that is expected.

   In plan mode, put the draft and the paths in the plan instead: the plan's approval is the yes, and the write follows once plan mode ends. If the question can't be asked (no AskUserQuestion, as in a headless run), is dismissed or gets no clear yes, show the text only and write nothing.
8. **An existing pack for this repo** (step 2 or 5): its text is in the tool's `packs`. Show the diff between it and the fresh draft, and propose Edits to it that bring in what the repo now says and keep the person's own entries and comments. Remove an entry of theirs only when its source is gone from the repo, and say so. On yes, write a copy first, `<path>.<YYYYMMDD>.bak` (today's date; add `-2`, `-3` if that name exists; the name never ends in `.pack.jsonc`, so the mod never loads it), then make the Edits.
9. **After writing**, call the tool with the written file's text and name: `draft.valid` true and `draft.shadowedBy` empty. Then point the person to `/ccinformer pack` (Debug › Pack), where it shows once the next turn starts.
10. **Never in a pack:** secrets, tokens, passwords, env values, credentials in URLs, personal paths, and `approvals` (nothing acts on them yet).

## Shared: reading the repo

- **Manifests:** `package.json` (scripts, dependencies), `pyproject.toml`, `*.csproj`, `go.mod`, `Cargo.toml`, `project.godot` and the like.
- **Lint and format configs:** ESLint (`eslint.config.*`, `.eslintrc*`) and its suppressions file, ruff, mypy, Prettier, `.editorconfig`.
- **Git hooks:** `.husky/`, `.githooks/`, lefthook, pre-commit.
- **CI:** `.github/workflows/*.yml`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/`, `bitbucket-pipelines.yml`, `Jenkinsfile`. Note which jobs run on pull requests or the default branch, and each step's command.
- **Tests that act as rules:** a test that holds translation files to the same keys, import boundaries between folders, a banned pattern.
- **Deploy configs:** `render.yaml`, `fly.toml`, `vercel.json`, `netlify.toml`, workflow `environment:` keys. Take only names, branches and `--mode` arguments from them; never a value from an `env`, `envVars` or `secrets` block.
- **Env files:** by name only, with Glob (`.env.staging` says there is a staging mode). Never Read one, and pass `!**/.env*` to every Grep, together with `!**/*.pem`, `!**/*.key` and `!**/secrets/**`.
- **Plans:** Markdown plans outside `.local/plans/` (which CCInformer always reads), such as `docs/plans/`.

## Shared: ci or advise

- `"class": "ci"`: a CI job that runs on pull requests or the default branch fails when the rule breaks, and the check mirrors it exactly (the same tool and config, or the same limit or pattern). For ESLint, a warn-level rule counts only when CI runs it with `--max-warnings 0`.
- `"class": "advise"`: a rule the repo states that no such job fails on: a pre-commit hook only, a warn-level rule, a rule in CLAUDE.md or CONTRIBUTING.
- Neither: whole-project or non-file steps (typecheck, tests and coverage, builds, e2e, secret scans, audits) and rules kept by a baseline the mod can't read. List them under "CI enforces, the pack doesn't check"; never invent a check for them.
- A built-in check whose tool the repo doesn't install, or that CI doesn't run, goes in `"disable"`.

## Shared: from the repo to the pack

| In the repo | In the pack |
|---|---|
| ESLint `max-lines` | a `size-lines` check (`cost: "edit"`) with `options.max`, the rule's ignores as `ignore`, `"rules": ["max-lines"]` |
| ESLint `no-restricted-syntax` with a `Literal` or `TemplateElement` regex, or a `JSXOpeningElement` name | a `regex-lines` check (`cost: "edit"`) per ban, `"rules": ["no-restricted-syntax"]`, its message as `options.message`; other selectors are listed as not covered |
| ESLint's suppressions file | `"suppressions"` on the checks that mirror ESLint rules |
| a test holding translation files to the same keys | an `i18n-keysets` check (`cost: "turn"`) with its languages in `options.languages` |
| a tool CI runs per file that writes SARIF, or prints one diagnostic per line | a `sarif` or `problem-matcher` check (`cost: "turn"`) with its `bin` (`{files}` where the files go) and a `timeoutMs` |
| a report script that prints a number, with a tracked baseline or limit | a budget: a `command` source with `parse` built from the script's print format as read in its source (never run it), a `ci-log` source with the exact job and step names, the baseline as a `json` source |
| a long-running script the built-in doesn't recognise | a `processes` entry |
| env file and deploy names | `environments`: production names get `"tone": "prod"`, staging and preview `"shared"`; `argRegex` from the scripts (`--mode staging`); `hostPatterns` only as the person answers "Which hosts mean `<env>`? I don't read env files." (options: "Leave hostPatterns out (Recommended)", or their own answer) |
| generated output | `noise` with `"kind": "generated"` |
| plan files outside `.local/plans/` | `plans.globs` |

An entry with the id of one in the built-in the pack `extends` (as `builtins` shows it) is read merged over that entry: write only the fields you change.

## Shared: regexes in JSONC

Write the regex as the engine sees it, then double every backslash: `\bvite\b` is written `"\\bvite\\b"`. A single `"\b"` is a JSON backspace, and `"\d"` doesn't parse. A regex copied from a JS string literal in the repo is already escaped once: double what's in the source. Process and environment patterns also run in .NET on Windows: no escapes .NET lacks (`\_`, `\q`), no `[]` or `[^]`. The tool's reasons say which field and what to change.

## Shared: the template

`${CLAUDE_SKILL_DIR}/pack-template.jsonc` holds every setting a pack has, with what it does. Read it to know what a field means and what it takes; never copy an entry or a value from it, since a pack that matches a repo is trusted, and a sample check left in would run its command there.
