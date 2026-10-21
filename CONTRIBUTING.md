# Contributing

How changes get into CCInformer, for people and their agents alike, cut down for a one-maintainer public plugin repo. The goal is a clean history on `main`: one commit per PR, each with a readable title, and a version bump whenever what ships changes. Left out because they serve teams: the `staging` branch, the module gate, lanes, code-owner approvals and the English check.

## One-time setup, per clone

```bash
git config core.hooksPath .githooks    # commit-msg and pre-push hooks
gh auth status                         # logged in to github.com as yourself
```

If the first `claude` on your PATH doesn't run (a broken shim), point the pre-push hook at a working one in your shell profile: `export CLAUDE_BIN="$HOME/.local/bin/claude.exe"`.

## The loop

`main` is the only long-lived branch. It's what machines install and update from, so every merge into it is a release.

1. **Branch from a fresh `main`:** `git switch main && git pull && git switch -c feat/<task>`. Prefixes: `feat/`, `fix/`, `chore/`, `docs/`. One task per branch; name a worktree after its task, and keep `claude` and random names out of both.
2. **Commit** on the branch. If the change touches what ships, raise the version in the same PR (see [Versions](#versions)).
3. **Push the branch and open a PR against `main`:** `git push -u origin HEAD && gh pr create`.
4. **Squash-merge** once the checks are green. The PR title becomes the commit on `main`.
5. **Clean up:** GitHub deletes the remote branch on merge. Once `gh pr view <n> --json state` shows `MERGED`, run `git switch main && git pull && git branch -D <branch>` (`-D`, because git doesn't recognise a squashed branch as merged).

Never push to `main` directly; the ruleset rejects it once it's imported (see [Repo settings](#repo-settings)).

## Titles: `type(scope): subject`

PR titles become `main`'s history. Header at most 100 characters, no period at the end. CI checks the PR title (`pr-title`); the `commit-msg` hook applies the same format to your local commits as a habit, though they're squashed away on merge. The list itself lives in [`.githooks/check-commit-msg.sh`](.githooks/check-commit-msg.sh).

- **Types:** `build chore ci docs feat fix perf refactor revert style test`
- **Scopes:**

  | Scope | Covers |
  |---|---|
  | `pane` | What every tab shares: `register.tsx`, `ui.tsx`, the `/side` command, keys, polling |
  | `git`, `agents`, `sessions`, `debug`, `stats` | One tab each (`view-*.tsx` and its helpers) |
  | `plugin` | `.claude-plugin/` (manifest, marketplace), `types/` |
  | `install` | The install scripts |
  | `repo` | Repo tooling and docs: hooks, CI, rulesets, `CLAUDE.md`, this file |
  | `deps` | Dependency bumps (Dependabot) |
  | `release` | A version bump on its own |

  Examples: `feat(git): show the PR's review state`, `fix(debug): count cache reads once`, `chore(release): 0.2.0`.

One change per PR, in English.

## Pull requests

- Against `main`, titled as above.
- The body follows [the PR template](.github/PULL_REQUEST_TEMPLATE.md). Add `Closes #<issue>` when there is one. The body stays on the PR; the squash commit gets the title only.
- Before pushing, run what CI runs: `claude plugin validate --strict .` and `claude plugin test .` (the pre-push hook does this for you).
- A red check means fix the cause; nothing in CI has a bypass.

## Versions

Installed machines only pick up a change when `version` in `.claude-plugin/plugin.json` goes up. So a PR that changes what ships (`.claude-plugin/`, `hooks/`, `types/`, `tsconfig.json`) raises it in the same PR: patch for a fix, minor for a feature. The `version-bump` check fails the PR otherwise. Docs, tests and CI changes don't need a bump.

## Checks

| Check | Workflow | What fails it |
|---|---|---|
| `plugin` | `ci.yml` | `claude plugin validate --strict .` or `claude plugin test .`, on the latest Claude Code |
| `secret-scan` | `ci.yml` | gitleaks finds a secret in any commit of the PR or in the tree ([`.gitleaks.toml`](.gitleaks.toml)). The repo is public, so this one matters even solo |
| `pr-title` | `pr-gates.yml` | The PR title isn't `type(scope): subject` |
| `version-bump` | `pr-gates.yml` | Shipped files changed and `plugin.json`'s version didn't go up |

Job names are required status checks in [`.github/rulesets/main.json`](.github/rulesets/main.json). Renaming a job means updating the ruleset in the same PR.

Dependabot opens one grouped PR a month for the Actions the workflows use.

## Repo settings

Applied by hand, once, by an admin. The ruleset requires a PR and green checks on `main`, with no approval count (a sole maintainer can't approve their own PR), and allows squash merges only. The merge settings make the PR title the commit's subject, with an empty body, and delete the branch after the merge.

```bash
repo=EsonOscar/CCInformer
gh api -X POST "repos/$repo/rulesets" --input .github/rulesets/main.json
gh api -X PATCH "repos/$repo" \
  -F delete_branch_on_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK
```

Import the ruleset only after the workflows are on `main`, or the required checks never report and every PR is stuck.
