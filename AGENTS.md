# bosun-x

A CLI + MCP server for cross-agent handoff and task tracking. See README.md.

## Layout

- `cli.mjs` — the CLI (`bosun <command>`). Self-contained; the one lock holder.
- `lib/board.mjs` — the STATUS.md task-board generator + `replaceTaskField` /
  `setTaskStatus` (surgical tasks.yml edits, no js-yaml round-trip).
- `lib/time.mjs` — timezone-aware ISO stamps. `lib/config.mjs` — data dir + tz + stale.
- `mcp/server.mjs` — stdio MCP server. Handoff writes shell out to cli.mjs;
  task edits reuse lib/board.mjs; reads are direct.
- `skill/bosun/SKILL.md` — the Claude Code skill.

## Rules

- Plain files stay hand-editable and greppable. A feature that needs more than a
  text editor is the wrong feature.
- tasks.yml edits are surgical — keep the folded scalars, never a full dump.
- Anything an agent reads on takeover has a token budget: bounded snapshot, a
  trail of clipped one-liners, noisy iteration collapsed before finish.

<!-- bosun-x:start -->
## Handoff — continuity across sessions and agents

This repo is tracked with bosun-x. State lives in plain files under the data dir;
`grep` and a text editor are first-class.

- Start substantive work: `bosun start <project> --agent <you> --summary <what> --task <KEY>`.
- After every verified milestone: `bosun checkpoint ... --task <KEY>`.
- Before a planned stop: `bosun finish ... --task <KEY>`.
- On takeover: `bosun resume <project>` — read only that, then `git status`.
- `bosun doctor [--fix]` reports and reconciles drift.
<!-- bosun-x:end -->
