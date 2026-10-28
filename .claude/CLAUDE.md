# CCInformer

CCInformer, a mod for Claude Code (a right-docked pane in five areas: Now, Code, Work, Timeline, Debug), published as a public GitHub repo that is its own plugin marketplace, so any machine installs it with one script and auto-updates.

## This repo is public

Every committed line is published. Before any `git add`, read what you add for what must stay private: secrets, internal hostnames or URLs, names, paths, data or code from other projects, and personal paths such as `C:\Users\<name>`. Write examples with placeholders (`<owner>/<repo>`, `~/.claude/...`).

The leak guard backs this up where the clone has `ccinformer.denylist` set: `pre-commit` and `pre-push` block a denylist entry in a commit, and PR text is checked by hand before `gh pr create`: `sh .githooks/check-text.sh <body file>`, and the title piped to `sh .githooks/check-text.sh -` (CONTRIBUTING.md "Leak guard"). A hit means rewrite the text, never `--no-verify`.

## Working on the mod

- **Load the `plugin-authoring` skill first**, before changing anything under `hooks/`, `types/` or `.claude-plugin/`.
- Rules the validator holds the mod to: one hooks module, `hooks/register.tsx`, which declares every state atom it reads and writes; `$` is passed only to a function declaration (`function f($, …)`), at the top of that file or imported from another file of the mod, never to an arrow function (`const f = ($) => …`); types are imported with `import type`.
- Keys live in `hooks/areas.ts`: an area's views and actions, each key once per area plus the global keys (`1`-`5`, `r`). Views take their hotkeys from it, never a literal, and `tests/areas.test.tsx` holds both. An area or view with nothing built isn't listed, so it isn't drawn.
- Commands run only through the exec lanes (`hooks/core/lanes.ts`): `register.tsx` makes the one `$.process.run` call that builds them, and `.githooks/check-exec.sh` (in CI and pre-push) fails on any other `$.process.run` or `$.process.spawn`. Logic that decides something takes data and returns data, without `$`, so a plain test reaches it; a `$` helper only reads and writes.
- Done means both pass from the repo root:
  ```bash
  claude plugin validate --strict .
  claude plugin test .
  ```
- `.claude-plugin/types/` is written by Claude Code and ignores itself; leave it alone.
- What **ships** to installed machines: `.claude-plugin/`, `hooks/`, `types/`, `tsconfig.json`. Every merge into `main` is a release, so a PR that changes any of them raises `version` in `plugin.json`, or machines never see it. On 0.x: patch for a fix, minor for a feature or a breaking change (CONTRIBUTING.md "Versions" says what counts as breaking). Releases are tagged by CI; the GitHub releases page is the changelog.

## Git and PRs

Full rules: [CONTRIBUTING.md](../CONTRIBUTING.md). Read it before your first branch, commit or PR in a session.

- The loop: branch from a fresh `main` as `feat/`, `fix/`, `chore/` or `docs/` + the task; commit; push the branch; open a PR against `main`; once `gh pr view <n> --json state` shows `MERGED`, delete the branch locally with `git branch -D` (git doesn't see a squashed branch as merged; GitHub deletes the remote one).
- PR titles become `main`'s history: `type(scope): subject`, the scope one lowercase word for the area changed (see CONTRIBUTING.md). Use the same format for commits by habit; only the PR title is checked. The squash commit's body is the PR's commit messages, so make each one say what changed and why.
- One feature per PR, all in English. Show the diff before every commit.
- PR titles, bodies and commit messages must make sense to someone who sees only the tracked files: never cite private plan ids (`CP2`, `C4`, `A12`, "phase 0"), plan file names or notes kept outside the repo. Describe the change itself.
- Red check in CI: fix the cause.
- Commit, push or open a PR only when the maintainer asks for that action in the current message. Ask first, every time, before merging a PR, changing repo settings or rulesets, or force-pushing.
