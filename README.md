# bosun-x

**Cross-agent handoff and task tracking for projects worked by AI agents.**
Plain files, one lock, no vendor. A CLI and an MCP server over the same data.

The bosun is the hand who keeps the ship and crew in working order — rigging,
stores, the watch. `bosun-x` does that for a set of projects you build with
Claude, Codex, Cursor, or a mix: it keeps a record of what's actually done, hands
the next session a clean starting point, and stops the task board drifting away
from reality.

---

## The problem

If you build software with AI agents across more than one repo, you know the tax:

- **Every session starts cold.** You re-explain what the project is, what's done,
  what you were in the middle of, what not to touch.
- **The record drifts.** The agent thinks a task is finished; the code says
  otherwise. A task gets added mid-session, worked, and left sitting at "backlog"
  because nobody updated it.
- **Two agents collide.** Claude in one terminal, Codex in another, both editing
  the same project, neither aware of the other.
- **Compaction and context limits lose the thread.** A session runs out mid-task
  and the next one has to reconstruct — or worse, re-decide — what was already
  settled.

`bosun-x` is the small amount of structure that fixes this without a database, a
web app, or a subscription.

## Who it's for

Solo developers, homelab operators, and small teams running a handful of projects
who lean on AI agents. If you have **one repo and one agent**, you probably don't
need this — Claude Code's own memory is enough. It earns its place when you're
switching between projects, between agents, or between machines, and the cost of
picking work back up has started to hurt.

## How it's different

- **Agent-agnostic by construction.** A plain Node CLI writing plain files.
  Claude, Codex, a human, a cron job — anything that can run a command or speak
  MCP can use it. Not tied to one vendor's memory feature.
- **A real concurrency guarantee.** A per-project lock serialises writers and
  rejects a checkpoint or finish from the wrong agent. Markdown-convention
  approaches ("just keep a HANDOFF.md") have no such guard.
- **Bounded by design.** The resume snapshot is a fixed size — the current
  checkpoint in full, plus a trail of the last four as one-liners, so a hasty
  checkpoint can't erase the trajectory that led to it. Anything an incoming
  agent reads has a token budget.
- **The task board can't drift.** `--task` on a checkpoint moves the matching
  task through `in_progress` → `done`, regenerates a summary block in
  `STATUS.md`, and `bosun doctor` catches anything that slips.

## Install

```
npm i -g bosun-x      # or: npx bosun-x <command>
```

Node 20+. Run `bosun` from your data directory (or point `$BOSUN_DATA` at it).

## The loop

```
# starting substantive work
bosun start my-app --agent Claude --summary "add rate limiting to the API" --task API-7

# after every verified milestone — and at least every 30 min, and before any
# long or risky step (a build, a migration, a deploy)
bosun checkpoint my-app --agent Claude \
  --done "token-bucket limiter in place, unit tests green" \
  --state "middleware wired on /api; the Redis backend is stubbed, not real yet" \
  --next "swap the in-memory store for Redis and load-test" \
  --task API-7 --tests "npm test: 41 passing"

# before you stop
bosun finish my-app --agent Claude \
  --done "rate limiting shipped, Redis-backed, load-tested to 2k rps" \
  --state "live on staging" --next "watch error rates for a day, then promote" \
  --task API-7
```

On the next session — **before touching anything**:

```
bosun resume my-app
```

That prints the bounded snapshot and nothing else. Read it, check `git status`
and recent commits, and pick up where the last hand left off. Don't load the full
`HANDOFF.md` history unless the snapshot is missing a specific decision.

A checkpoint must distinguish **verified** work from attempted, name any blocker,
and give exactly one next action. "Should work" when it's untested is worse than
no checkpoint — it invites the next session to build on sand.

## Keeping the board honest

```
bosun status                 # one line per project: active / stale / finished
bosun doctor                 # report task/handoff drift and stale STATUS.md boards
bosun doctor --fix           # reconcile the safe cases and regenerate every board
```

`doctor` flags a task stuck `in_progress` with no active handoff, a live handoff
whose task never advanced, and a `STATUS.md` board that fell behind `tasks.yml`.
`--fix` promotes or resets the stray task and rewrites the boards.

## Wiring an agent

**1. The convention, in the repo the agent reads.** From inside a project repo:

```
bosun init
```

adds a managed `<!-- bosun-x -->` block — the checkpoint discipline in a few
lines — to whichever of `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or
`.github/copilot-instructions.md` already exists. Re-run to update it in place.

**2. The MCP server**, so the agent has real tools instead of shelling out:

```json
{
  "mcpServers": {
    "bosun-x": {
      "command": "bosun-mcp",
      "env": { "BOSUN_DATA": "/abs/path/to/your/data" }
    }
  }
}
```

Drop that into Claude Code's `.mcp.json`, Claude Desktop's config, or the
equivalent in Cursor / Cline / Zed / Codex. Tools: `project_brief` (the
session-start blob), `list_projects`, `list_tasks`, `handoff_resume`,
`handoff_status`, `handoff_start` / `handoff_checkpoint` / `handoff_finish`,
`handoff_doctor`, `set_task_status`, `create_task`.

**3. The skill** (Claude Code) — `skill/bosun/SKILL.md` teaches the discipline and
triggers on "resume", "checkpoint", "pick up work on". Copy it to
`~/.claude/skills/bosun/` or a project `.claude/skills/`.

## The data model

One directory per project, under `<data>/projects/<slug>/`:

| file | what it is |
| --- | --- |
| `project.yml` | metadata — name, stage, status, host, repo |
| `HANDOFF.md` | the append-only narrative log, newest entry on top |
| `HANDOFF.yml` | the bounded machine-readable resume snapshot (latest + a trail of 4) |
| `tasks.yml` | the task list — `<PREFIX>-<num>` ids, statuses, dependencies, sub-tasks |
| `STATUS.md` | your prose, plus a generated `<!-- bosun:task-board -->` block |

Every file is designed to be hand-edited as comfortably as it's written by the
tool. The test applied to any feature: *could someone do this with a text editor
alone?* If not, it doesn't ship. `grep` is a first-class client.

## Configuration

| | resolution |
| --- | --- |
| data directory | `$BOSUN_DATA`, else `$DATA_DIR`, else the current directory |
| timezone for stamps | `$BOSUN_TZ`, else `bosun.config.json` → `timezone`, else the system zone |
| stale threshold | `$BOSUN_STALE_MINUTES`, else `bosun.config.json` → `staleMinutes`, else 30 |

## License

MIT.
