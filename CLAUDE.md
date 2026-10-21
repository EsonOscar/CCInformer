# CCInformer

The sidepanel mod for Claude Code (a right-docked pane: git and CI, agents and workflow runs, other sessions, debug), published as a public GitHub repo that is its own plugin marketplace, so any machine installs it with one script and auto-updates.

The plan, decisions still open and the order of work are in `.local/INIT_PLAN.md` (git-ignored, on Oscar's machine only). Read it before working on the move, the marketplace or the install scripts.

## This repo is public

Every committed line is published. Before any `git add`, read what you add for what must stay private: secrets, internal hostnames or URLs, names, paths, data or code from work projects (the list is in `.local/INIT_PLAN.md`, §7), and personal paths such as `C:\Users\<name>`. Write examples with placeholders (`<owner>/<repo>`, `~/.claude/...`).

## Working on the mod

- **Load the `plugin-authoring` skill first**, before changing anything under `hooks/`, `types/` or `.claude-plugin/`.
- Rules the validator holds the mod to: `$` stays in the hook module (write `$.noun.method()` where it's used, never pass `$` to a helper); state atoms live in the file that reads and writes them; types are imported with `import type`.
- Done means both pass from the repo root:
  ```bash
  claude plugin validate --strict .
  claude plugin test .
  ```
- `.claude-plugin/types/` is written by Claude Code and ignores itself; leave it alone.
- What **ships** to installed machines: `.claude-plugin/`, `hooks/`, `types/`, `tsconfig.json`. Every merge into `main` is a release, so a PR that changes any of them raises `version` in `plugin.json` (patch for a fix, minor for a feature), or machines never see it.

## Git and PRs

Full rules: [CONTRIBUTING.md](CONTRIBUTING.md). Read it before your first branch, commit or PR in a session.

- The loop: branch from a fresh `main` as `feat/`, `fix/`, `chore/` or `docs/` + the task; commit; push the branch; open a PR against `main`; once `gh pr view <n> --json state` shows `MERGED`, delete the branch locally with `git branch -D` (git doesn't see a squashed branch as merged; GitHub deletes the remote one).
- PR titles become `main`'s history: `type(scope): subject`, with a scope from CONTRIBUTING.md. Commits use the same format; when the commit-msg hook rejects one, reword it.
- One feature per PR, all in English. Show the diff before every commit.
- Red check in CI: fix the cause.
- Commit, push or open a PR only when Oscar asks for that action in the current message. Ask first, every time, before merging a PR, changing repo settings or rulesets, or force-pushing.
