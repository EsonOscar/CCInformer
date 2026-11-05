---
name: write-builtin
description: Write a new built-in CCInformer pack for a stack (hooks/packs/<id>.ts with its detect rules and its test) while working on the mod in a CCInformer clone. Generic values only, never a project's; asks once before writing, naming every path. Use when the maintainer asks for a new built-in pack, or runs /write-builtin.
argument-hint: <the stack, e.g. "Python with ruff">
---

Write a built-in pack for: $ARGUMENTS

A built-in pack ships with the mod. It is picked for any repo of its stack by its `detect` rules (when no user pack says otherwise) and is the base a user pack `extends`. So it holds only what is right for every repo of that stack: a project's own values belong in that person's user pack, which `/ccinformer:write-pack` writes.

## Before anything

Stop and say which one fails, unless all three hold:
- this is a CCInformer clone: `skills/write-pack/SKILL.md` and `hooks/packs/builtins.ts` exist;
- you aren't on `main`: `git branch --show-current` prints another branch, or nothing (a detached HEAD, as in a throwaway worktree, passes); on `main`, say which branch to create rather than creating it;
- the `plugin-authoring` skill is loaded (load it now if not).

## Steps

1. **Read** `skills/write-pack/SKILL.md`: its sections whose titles start with "Shared:" are how you read a stack's files, decide `ci` or `advise`, map them to pack fields and write regexes; follow them, with the differences below. Read `skills/write-pack/pack-template.jsonc` for every setting (a reference, never copied), `hooks/packs/node-vite.ts` for the shape of a built-in, and `hooks/packs/builtins.ts`.
2. **What differs from a user pack:**
   - No `match`. Instead `detect`: marker files, relative to the repo root, each with a `weight`, and at least one with `"required": true` that only this stack has (`project.godot`, `Cargo.toml`), narrowed with `contains` where a file is shared by stacks (`package.json` naming `vite`).
   - Generic values only. You may read a sample repo of the stack to check a convention, but never take a name, path, host, label or message from it that the stack's own conventions don't give.
   - `class: "ci"` only where the stack's standard tool is what that stack's CI conventionally runs (node-vite's ESLint); otherwise `"advise"`. There is no repo CI to read.
   - Environments: `local` only (localhost and its kin). No `budgets` unless the stack has a standard report, no `approvals`, no `plans`.
   - Commands as the stack's tools are installed in a repo, preferring `node <script>` to a shim (`npm`, `npx`), which is slower to start on Windows.
   - The analyzers the mod has for the stack itself (the `tscn` pair for Godot), with root-agnostic globs (`**/*.tscn`, `**/*.cs`).
   - The stack's own `noise`: its generated folders and the files its editor rewrites on save, with the engine's renumbered parts as `normalize`.
   - The `id` is a short lowercase name for the stack, not one already in `BUILTINS`.
3. **Draft** `hooks/packs/<id>.ts` like `node-vite.ts`: a comment naming the stack and saying it holds generic defaults only, then `export const <ID>: PackManifest = { ... }`. In TS strings, as in JSONC, every regex backslash is written twice.
4. **Draft its test**, `tests/pack-<id>.test.ts`, in the style of `tests/packs.test.ts`, with invented fixtures:
   - `checkPack(<ID>, 'built-in').reasons` is `[]`;
   - `detect(BUILTINS, <its own marker files>)` picks it;
   - a plain repo (`README.md` and `.gitignore` only) detects nothing;
   - node-vite's markers (`package.json` naming `vite`) still pick node-vite;
   - `resolvePack` over its markers reads `detected`.
5. **Ask once**, with AskUserQuestion, showing both drafts and naming every path:
   - `hooks/packs/<id>.ts` (new);
   - `hooks/packs/builtins.ts` (one import, one entry in `BUILTINS`);
   - `tests/pack-<id>.test.ts` (new);
   - `.claude-plugin/plugin.json` (the next minor version above `main`'s, read with `git show main:.claude-plugin/plugin.json`, unless this branch already raised it);
   - `README.md` (the built-ins in the Packs section's "Today:").

   Options: "Write them (Recommended)", "Change something first", "Don't write; show the text only". In plan mode, put the drafts and the paths in the plan instead; its approval is the yes. No clear yes, or no way to ask: show the text only and write nothing.
6. **Write them, then run** every check, and fix what fails without loosening a test or a check:
   ```bash
   sh .githooks/check-exec.sh
   sh .githooks/check-permissions.sh
   claude plugin validate --strict .
   claude plugin test .
   npx -y -p typescript@5 tsc -p . --noEmit   # needs .claude-plugin/types/, written by a `claude --plugin-dir .` session
   sh .githooks/check-text.sh hooks/packs/<id>.ts && sh .githooks/check-text.sh tests/pack-<id>.test.ts
   ```
7. **Show** `git diff` and the new files. Commit, push or open a PR only when the maintainer asks.
