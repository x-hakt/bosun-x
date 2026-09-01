---
name: bosun
description: >-
  Cross-agent handoff and task tracking for a project tracked with bosun-x.
  Use at the start of substantive work, at every verified
  milestone, before a planned stop, and on takeover. Triggers: "pick up work
  on", "resume", "checkpoint", "hand off", "what's the state of", a project
  slug with open tasks, a stale HANDOFF.
---

# bosun — the handoff loop

This project keeps its state in plain files: an append-only `HANDOFF.md`, a
bounded `HANDOFF.yml` resume snapshot, a `tasks.yml` board, and a generated task
board inside `STATUS.md`. The `bosun-x` MCP server exposes all of it as tools;
the `bosun` CLI is the fallback if MCP isn't wired.

## On takeover — before touching anything

1. `project_brief` (MCP) or `bosun resume <project>` (CLI). Read only that.
2. `git status` and the last few commits.
3. Do **not** load the full `HANDOFF.md` history unless the snapshot is missing a
   specific decision you need.

Never assume you can read the previous agent's transcript — the handoff is the
contract.

## The loop

- **Start:** `handoff_start` / `bosun start <project> --agent <you> --summary <what> --task <KEY>`.
  Always name the task with `--task` (a key like `CR-16`, or a bare number) — it
  moves the task to `in_progress` and keeps the board honest.
- **Checkpoint:** after every verified milestone, and at least every 30 minutes of
  active change, and before any long or risky step (builds, migrations, deploys).
  `handoff_checkpoint` / `bosun checkpoint <project> --agent <you> --done <verified>
  --state <where things are> --next <one concrete action> --task <KEY> [--tests <result>]`.
  A checkpoint distinguishes **verified** work from attempted, names blockers, and
  gives exactly one next action. "Should work" when it's untested is worse than
  no checkpoint.
- **Finish:** before a planned stop. `handoff_finish` / `bosun finish ... --task <KEY>`
  moves the task to `done`.

## Tasks

- `list_tasks` / `create_task` / `set_task_status` via MCP, or edit `tasks.yml`
  directly (surgically — keep the folded scalars).
- Prefer `--task` on the handoff calls over `set_task_status` for normal flow.
- `handoff_doctor` (or `bosun doctor`) reports drift; `--fix` reconciles the
  safe cases (a task stuck `in_progress` with no active handoff, a stale board).

## Concurrency

The CLI holds a per-project lock and rejects overlapping owners and
checkpoint/finish from the wrong agent. If `start` reports active work owned by
someone else, `resume` it or wait until it goes stale — don't force past it.
