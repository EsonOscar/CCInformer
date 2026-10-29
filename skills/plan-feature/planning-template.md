# Planning settings

How the CCInformer planning skills (`/ccinformer:plan-feature`, `/ccinformer:plan-feature-small`, `/ccinformer:plan-handoff`) plan in this repo. This file is private to this clone: it lives in `.local/`, which git ignores. If the repo also has a committed `## Planning` section in its CLAUDE.md (or a `.claude/planning.md`), that is read first and this file adds to it or overrides it. Delete a section to fall back to the skills' defaults.

## Checks

- Full: <the commands that must pass before a PR, for example `npm test` and `npm run lint`>
- Scoped: <fast checks that take file paths, for agents and work packages, for example `npx vitest run <files>`>

## Standing scouts

<Areas every plan in this repo should have a scout read, one line each: what to read, and why.>

## Extra critic lenses

<Risks this repo always has, one line each: for example access rules, migration safety, translations, the design system.>

## Approvals

<Actions that need the user's OK before they run, one line each: writes to a shared environment, a database or a service, heavy measurement runs.>

## Commits, PRs and docs

<The repo's rules, or where they are written, for example "CONTRIBUTING.md".>

## Plans

- Plans: `.local/plans/`
- Handoff docs: `docs/plans/`
