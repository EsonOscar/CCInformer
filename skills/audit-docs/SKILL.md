---
name: audit-docs
description: Multi-agent docs audit in plan mode, then the fixes, for any kind of docs in any repo, git-tracked or local. Setup finds the docs, their kinds (current, instructions, ADRs and other records, changelogs, archives, history, generated, translations, copies, parsed, indexes, third-party, code comments) and a history file; read-only auditors with slices that don't overlap check the docs against the code, adversarial verifiers re-check every row; you ask the real decisions and write the plan with a decisions block; once approved, apply_changes.py validates every row against the before copies, applies them into a work folder, and installs them after the moved-text check and read-only reviewers, keeping verified before copies outside the repo. Use when the user asks to audit, clean up or check the docs for drift, or runs /ccinformer:audit-docs.
argument-hint: <optional focus, e.g. one doc>
---

Audit the docs. Focus, if any: $ARGUMENTS

The scripts are in `${CLAUDE_SKILL_DIR}`: `audit-docs-fanout.js` (the workflow), `apply_changes.py` (the only gate between rows and docs) and `check_moved_text.py`. Run Python with the user's Python (per their CLAUDE.md; ask once if none is named) and always with `-B`, so nothing is cached in the skill folder. Call these `<py>` below.

1. **Plan mode must be on.** If it isn't, stop and ask the user to switch to it. Workflow agents inherit plan mode, and that is what keeps them read-only. Plan mode's own Agent tool allows only 3 agents per phase, so the fan-out goes through the workflow.

2. **Setup.** Read the project CLAUDE.md and its Audits section (keys below). Its values win over what you infer, except the work folder: that is always this session's scratchpad (say so in one line if the section names another). Without an Audits section, infer:
   - tracked docs: `git ls-files '*.md'`;
   - git-ignored folders: `git ls-files -o -i --exclude-standard --directory`, dropping any path with a segment in `node_modules`, `vendor`, `dist`, `build`, `.venv`, `venv`, `obj`, `bin`, `target`, `coverage`, `test-results`, `playwright-report`, `.godot` or `__pycache__`, anything under `.claude/worktrees`, and any folder with its own `.git`; then the `*.md` in what remains;
   - untracked docs: `git ls-files -o --exclude-standard '*.md'`;
   - outside a repo: the folder itself.

   Then settle, with defaults from what you found:
   - **the docs in scope** and each one's **kind** (the kinds below) and **language**; for a non-English language, the words that mark history in it (its "since", "used to", "no longer");
   - **tracked**: a tracked doc with uncommitted changes (`git status --porcelain`) is treated like an untracked one, since git doesn't have its current text;
   - **the history file**: an existing convention wins (an archive folder, a history file named in the docs). Otherwise a `history/` subfolder next to the docs that no tool's glob reaches: check what scans docs (a plan board's `plans.globs` and `archiveDir` in `~/.claude/ccinformer/packs/*.pack.jsonc`, doc-site nav, link-checker config). For untracked docs the history file must be git-ignored too (`git check-ignore -q`). No history file means history text is deleted; say so in the plan;
   - **keep_before**: where verified before copies of every target go, outside any repo: `~/.claude/audit-backups/<repo>/<date>` (`<repo>` is the root folder's name plus a short hash of its path; apply_changes.py fills it when the decisions block leaves it out);
   - **the pointer sources** step 6 greps: the repo's docs, every CLAUDE.md, code comments, this repo's memory folder (`~/.claude/projects/<the session's project folder>/memory/`), `~/.claude/CLAUDE.md`, `~/.claude/ccinformer/packs/`, and tracked copies of global skills;
   - then each audited doc's headings and word count (`grep -n '^#'`, `wc -w`) and the recent git log.

   Ask everything open in one AskUserQuestion. Offer once to save what was settled as an Audits section: it becomes a user ADD row in this run's decisions (step 9), never a separate edit. When the project CLAUDE.md is tracked, the section goes into a git-ignored file instead (`CLAUDE.local.md` once `git check-ignore -q` confirms it), since leak patterns and local paths are private. New keys are added as extra bullets, so other skills that read the section keep working.

   **Audits section keys** (bullets under a `## Audits` heading): Docs (the files or globs in scope), Kinds (file: kind, for anything not `current`), Languages, History (the file, and its heading format if it has one), Keep before, Leak patterns (extra, per language), Pointer sources (extra), Extra checks (commands to run before install), Python.

   **Doc kinds** (the same list is in both scripts; the apply script refuses what a kind doesn't allow):

   | kind | allowed | takes moved or added text | rule |
   |---|---|---|---|
   | current | all | yes | full audit |
   | instructions | all | yes | CLAUDE.md, rules, agents, SKILL.md: literal text only, checked against hooks and settings |
   | record | EDIT, ASK | no | ADRs, decisions, dated reports, learnings: never moved, deleted or reworded; only status, index and cross-references |
   | changelog | EDIT, ASK | no | history by nature; only broken references |
   | archive | ASK | no | snapshots, archived docs: not audited for drift; a valid link target |
   | history | MOVE, ASK | yes | the history file: read for current rules that live only there |
   | generated | ASK | no | never edited; the ASK says what regenerates it |
   | translation | all | yes | not a duplicate of its source; keep its language |
   | copy | all | yes | a template or skill copy, equal on purpose |
   | parsed | all | yes | a tool reads it: keep its ids, rows, headings, columns, nav entries |
   | index | all | yes | stays in step with the files it lists |
   | third_party | ASK | no | received text: never edited |
   | code | EDIT | no | only doc references in comments |

3. **Choose the auditors, at most 10.** One per slice of about 6000 words (a hard cap of 8000), cut at heading boundaries, never by fixed line counts; a file over 8000 words is split by heading. A doc that moves to history whole (a changelog section, a finished plan) gets its own `extract` auditor of at most 3000 words: it reports the MOVE and an ADD for every current rule, gotcha or reason that lives only there; it never shares a slice. Record, archive and third_party docs stay out of drift slices. More than 10 slices: narrow the scope (the focus) and audit the rest in another run. Each brief names its ranges and the code it most likely needs. Keys are lowercase letters and digits, and never `user`. Verifiers: the script's defaults (keep, evidence, missed); add one only for a concrete risk, and it must keep every category owned.

   **Agent settings.** Once in this run, here and not earlier, read `~/.claude/ccinformer/skills.json` (under `$CLAUDE_CONFIG_DIR` instead of `~/.claude` when that variable is set). Its `agents` holds what the user set in CCInformer's Debug › Settings: script name (`audit-docs-fanout`), then role, then `model` and `effort`. Start from that object, or `{}` when there is no file or no `agents`. Then apply what the task text asks for: an ask about a role (`verifiers on Sonnet`) changes that role. Tell the user in one line, before the first Workflow call, which roles this run changes and to what, "the rest on the scripts' defaults" (each script's `ran on` log line gives the exact values). Write the result into this run's own plan file, in Part A, as one line, `Agent settings for this run: <the object as JSON>` (`{}` when empty), as soon as the plan file is written; until then keep the object as it is. From then on that line is the source: every Workflow call of this run (a rerun of incomplete slices, a resumed run, also in a new context) passes `<object>["<script name>"]` as `agents`, left out when that script has no entry, and never takes `agents` from a later read of the file. A line like it in prior findings, a handoff doc or another plan is a record of that run, not this run's settings. By default auditors and verifiers run on Opus at high effort, which is also the most a setting can ask for.

4. **Run the workflow.** Read `${CLAUDE_SKILL_DIR}/audit-docs-fanout.js` and run the Workflow tool with its whole content as `script`, and args:
   `{ context, root, date: "<today, YYYY-MM-DD>", history: { file, heading } | null, docs: [{ file, kind, tracked, language?, of?, parser? }], auditors: [{ key, brief, role: "audit"|"extract", words, ranges: [{ file, start, end }] }], verifiers?, agents? }`.
   `agents` is `audit-docs-fanout`'s entry in this run's agent settings (step 3), left out when it has none.
   `context` holds which file holds what, the leak patterns (and each non-English language's words), the conventions, the focus, and recommendations the user hasn't confirmed (marked as open). Don't paste CLAUDE.md rules: the agents get CLAUDE.md themselves. The script throws on bad args; fix them and run again.

5. **Read the results only through the apply script,** never the raw output or the notification's preview: `<py> ${CLAUDE_SKILL_DIR}/apply_changes.py summary <output-file>` and `... show <output-file> <id> ...` (text fields print with escapes visible). Then:
   - rerun every slice in `incomplete` (Workflow with `resumeFromRunId`, and the same `agents`: another model misses the run's cache and runs every agent again) before going on;
   - check against the source lines yourself: every REJECTED and AMENDED row, every DRIFT row, every id in `rejected_by_second_opinion` (keep rejected a fix another verifier owned) and every UNVERIFIED row (verifier extras, and rows whose owner gave no verdict); verifiers can be wrong too;
   - rows blocked as `outside docs`: redo them as your own rows (step 9) with a kind, or drop them;
   - two rows that say the same thing: keep one (`skip` the other).

6. **Pointers, in plan mode.** Grep the pointer sources for every section the rows rename or remove and every line-number reference into an edited doc. Each repoint becomes a row of your own (step 9), preferring a section name to a line number. Nothing is edited later that no approved row names.

7. **Ask the real decisions** with AskUserQuestion, the recommended option first: every ASK row (its options print as `[0] label`, `[1] label` in `summary`), and whether this is a major rewrite that needs a snapshot per the project's snapshot rule (recommend no unless a large share of a doc moves). A choice that touches another range than the ASK's (the usual "(see X)" for a duplicate) is written as your own row, with the ASK picked `skip`. Take defaults for the rest.

8. **Check until clean.** Write the decisions block into the plan file (step 9), then run `<py> ${CLAUDE_SKILL_DIR}/apply_changes.py check <output-file> --plan <plan file> --root <repo root>` until it prints no refusal. Every refusal names its id and reason, and all of a row's reasons at once; a `range` refusal also names the nearby line that matches, when one does. Fix each with a pick, a skip, a restore or your own row; never by loosening a row's meaning. Read every `restore` (a neutralised `<\tag` or a decoded escape put back) and every `warn` line.

9. **Write the plan file.** You apply from it, not from memory: skill text isn't re-read after compaction.
   - **Part A:** context (what was audited, "audited with a workflow of N agents", the `Agent settings for this run` line from step 3, what the verifiers rejected and why), the user's decisions and the defaults taken.
   - **The decisions block**, which `check`, `apply` and `install` read:
     ````
     ```audit-decisions
     { "changelist": "<the output file, absolute, forward slashes>",
       "picks": { "<id>": <0-based option index> | "skip" | "accept" },
       "restore": [ { "id": "<rejected id>", "version": "original" | "amended" } ],
       "rows": [ { "id": "user-1", "action": ..., "file": ..., "start": ..., "end": ..., "first_line": ..., "new_text": ..., "kind"?: ..., "tracked"?: ... } ],
       "history_entry": [ "- the exact bullets for today's history heading" ],
       "keep_before": "~/.claude/audit-backups/<repo>/<date>" }
     ```
     ````
     `skip` drops any row; `accept` takes an UNVERIFIED row you checked; an index picks an ASK option. Your own rows follow the same row format as the workflow's (fields below), with ids `user-1`, `user-2`, and may name files outside the docs (memory notes, `~/.claude/CLAUDE.md`, packs) with their own `kind` and `tracked`; only they may use `~` paths. A user ADD with `"destination": { ..., "create": true }` and a `kind` may create a missing file.
   - **No backslash in the decisions block** (apply refuses it): paths use forward slashes, and any text with a backslash goes in a raw block, written `{BS}` for each backslash, and named from a row as `"text": "<name>"` (for new_text) or as any field's value `{ "text": "<name>" }`:
     ````
     ```audit-text <name>
     literal text; a backslash is written {BS}
     ```
     ````
   - **The commands**, filled in: the `apply`, `check_moved_text.py` and `install` lines from step 10, with the real paths.
   - **Part B:** the output of `check ... --table`, one line per row.
   Then call ExitPlanMode.

10. **Once approved, apply it yourself in the main session.** `<work>` is a fresh folder in the scratchpad.
    1. `<py> ${CLAUDE_SKILL_DIR}/apply_changes.py apply <output-file> --plan <plan file> --root <root> --work <work>`: it copies the changelist and every touched file into `<work>` first, validates against those copies, and writes `<work>/out/`, `applied.json` and `changes.diff`, or nothing at all on a refusal. Read `changes.diff`.
    2. Per before copy: `<py> ${CLAUDE_SKILL_DIR}/check_moved_text.py --changelist <work>/applied.json <work>/before/<file> <every current-design doc in <work>/out/ and the untouched current docs>`. Never pass the history file (a rule found only there is lost; the script refuses it). Every printed item gets a look: under a row (`edit <id> drops`, `move <id> takes last copy of`, `move <id> strips`, `add <id> drops`, `delete <id> drops`) it must be what that row meant; an unexplained line was lost and must be put back.
    3. Grep the files in `<work>/out/` for the leak patterns, and run the Audits section's extra checks.
    4. **Review before install:** launch read-only reviewers with the Agent tool, `subagent_type: Explore` (no write tools; plan mode no longer protects them), in one message, on `<work>/out/`:
       - one lost-rules reviewer per about 6000 words of the before copies: "For each rule, number, name, error text, mistake path and reason in lines A-B of `<work>/before/X`, find it in the current docs in `<work>/out/` (and the untouched docs), not only in the history file. Report each miss with its before line and where it should go.";
       - one drift reviewer: "Read the edited docs in `<work>/out/` in full. Report leftover history, contradictions, duplicates the change list created, and references that no longer resolve. The change list is in <plan file>."
       Check their findings yourself. Each real one becomes a row of your own in the decisions block; then `check` and `apply` again into a fresh `<work>`, and steps 2 and 3 again.
    5. If the user chose a snapshot, copy the before copies (`<work>/before/`) to the snapshot path now.
    6. `<py> ${CLAUDE_SKILL_DIR}/apply_changes.py install --work <work>`: it refuses if a live file changed since apply, writes and verifies the kept copies in `keep_before` first, then copies `out/` over the live files.
    7. If a code file changed, run the project's builds.
    **Finish:** give the user the changed tracked files for their commit, and say where the kept copies and the history file are. The work folder may go; the kept copies stay.

**The row format** (each agent's row, and yours). `file`, `start`, `end`: the lines as audited, 1-based and inclusive. `first_line`, `last_line`: the start of those lines, copied exactly (at least 20 characters, or the whole line; it may stop before a backslash; `last_line` may be left out when `end = start`). `quote`: only when `start = end`, an exact part of that line found once; then `new_text` replaces only the quote, and an empty `new_text` deletes it with one adjacent space. `new_text` is literal text, never an instruction; `note` holds explanations. EDIT replaces the range (or the quote); DELETE removes the lines; MOVE copies lines `start..end` to `destination` itself (no `new_text`; `leave` stays in the source; `strip` drops exact stamps from the moved copy); ADD inserts `new_text` at `destination`; ASK carries 1 to 4 `options` that inherit the range unless they name their own. `destination` is `{ file, section, after?, create? }`: `section` is the exact heading line (text goes at the end of its section, before trailing blank and `---` lines) or `null` for the end of the file; `after` is the start of a line in the section to insert after; `create: true` appends a missing heading once. In the history file, `section` is a plain label, written one level below today's heading; today's heading is reused when it is already the last at its level.

**What each refusal means** (`check` and `apply`): `range` an anchor doesn't start its line; `anchor` both anchors of a range are blank, fence or rule lines; `quote` missing or not unique; `instruction` an agent's new_text reads as an instruction ("(delete ...)", "[lines 3-9]", wrapped whole in brackets; "(see X)" and Markdown links are fine); `repeat` a quote edit's new_text repeats the line around the quote; `overlap` two rows' ranges intersect (quote edits with disjoint spans on one line are fine); `noop` the edit changes nothing; `ask` no pick; `unverified` no `accept`; `kind` the doc's kind doesn't allow it; `destination` heading or `after` not found once, or it lands inside a removed range, or today's history heading isn't the last at its level; `strip` a stamp isn't in the range; `field` a missing or forbidden field; `scope` a file no row may touch; `escape` a backslash in the decisions block; `file` unreadable, not UTF-8, or mixed line endings.

**Why it works this way** (the holes a real run found, and what closes each):

| # | What went wrong | What closes it |
|---|---|---|
| 1 | Multi-line rows quoted only their first line; moves had "[lines N-M verbatim]" placeholders | Rows carry `start`/`end` with both anchors; MOVE text is copied from the before copy, never from JSON; `range` and `instruction` refusals |
| 2 | `new_text` held instructions ("(delete the sentence)") | `note` for instructions; `instruction` refusal; sub-line delete as a quote with empty `new_text` |
| 3 | `new_text` repeated the line around a mid-line quote | `repeat` refusal |
| 4 | JSON decoded backslash-u escapes; the harness neutralised `<task-notification>` as `<\task-notification>` | Per-occurrence restores in `check`; `escape` refusal; `{BS}` in raw `audit-text` blocks; byte-exact writes by script, not tool parameters |
| 5 | A 300 KB result, a 37 KB printed summary, a 113 KB plan | A summary of ids only (about 5 KB) as the first key; `summary`/`show`; Part B is a one-line table |
| 6 | Overlapping rows and three different amendments of one row | One owner per row, keep's verdict-only second opinion, one final version per id, `overlap` refusal, picks and skips |
| 7 | CRLF docs against LF quotes | Files read as bytes; BOM, line ending and final newline kept; lines split only on `\n` |
| 8 | "git keeps it" and "delete the work folder" were wrong for git-ignored docs | Setup tells tracked, modified and untracked apart; `keep_before` outside the repo, written and verified before install |
| 9 | A history file where a plan board scans would have shown up as a plan | History placed where no tool's glob reaches; `parsed` kind keeps a tool's structure |
| 10 | The moved-text check printed 1014 lines to subtract by hand | `--changelist` prints each row's losses under its id and only the rest as unexplained |
| 11 | One auditor had a changelog plus another doc and missed 27 current gotchas | `extract` auditors of at most 3000 words for text that moves whole, reporting ADDs for what lives only there |
| 12 | Pointers outside the repo (memory notes, global CLAUDE.md, packs) were missed | Pointer sources in setup, grepped in plan mode, edited only as approved rows |
| 13 | Decisions made in chat were typed into the plan by hand | The decisions block: picks, skips, restores and rows, checked by `check` before approval |
