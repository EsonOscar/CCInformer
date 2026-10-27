# CCInformer

CCInformer, a mod for Claude Code (a right-docked pane: git and CI, agents and workflow runs, other sessions, debug), published as a public GitHub repo that is its own plugin marketplace, so any machine installs it with one script and auto-updates.

## This repo is public

Every committed line is published. Before any `git add`, read what you add for what must stay private: secrets, internal hostnames or URLs, names, paths, data or code from other projects, and personal paths such as `C:\Users\<name>`. Write examples with placeholders (`<owner>/<repo>`, `~/.claude/...`).

## Working on the mod

- **Load the `plugin-authoring` skill first**, before changing anything under `hooks/`, `types/` or `.claude-plugin/`.
- Rules the validator holds the mod to: one hooks module, `hooks/register.tsx`, which declares every state atom it reads and writes; `$` is passed only to a function declaration (`function f($, …)`), at the top of that file or imported from another file of the mod, never to an arrow function (`const f = ($) => …`); types are imported with `import type`.
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
