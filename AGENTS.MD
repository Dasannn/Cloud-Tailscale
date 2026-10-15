# Agent Rules

Multiple AI agents may work on this repository concurrently.

## General

* Read relevant project documentation before working.
* Never work directly on `main` unless explicitly instructed.
* One task per worktree. Never modify another agent's worktree.
* Do not merge into `main` until I say so.
* Follow documented requirements and architecture.
* Do not invent requirements or change architecture without approval.
* Do not add yourself as co-author, never
* If missing, conflicting, or ambiguous information materially affects implementation, ask before proceeding.

## Source of Truth

Priority order:

1. `docs/constitution.md`
2. `docs/spec.md`
3. `ARCHITECTURE.md`
4. `docs/plan.md`
5. `docs/tasks.md`

## Documentation

Keep `docs/` organized:

```text
docs/
├── constitution.md
├── spec.md
├── plan.md
├── tasks.md
├── decisions/
├── guides/
└── reference/
```

* Do not add miscellaneous files directly to `docs/`.
* Create documentation only when it has durable project value.
* Update existing documentation instead of creating duplicates.
* Do not create documentation merely to report completed work.

## Repository Hygiene

* Only commit product code, tests, tooling, configuration, and durable documentation.
* Temporary agent work belongs in `.agent/` and must never be committed.
* Do not commit generated, debug, cache, build, scratch, or local-only artifacts.
* Before handoff, verify the task introduced no unintended files.

## New Projects

If the core project documentation does not exist, do not implement application code.

First inspect the repository and clarify the product with the user.

Create in order:

1. `docs/constitution.md`
2. `docs/spec.md`
3. `ARCHITECTURE.md`
4. `docs/plan.md`
5. `docs/tasks.md`

For each stage:

* clarify material ambiguities
* propose the document
* revise from feedback
* continue only after approval

Do not implement application code until planning is approved.
