#!/usr/bin/env node
/*
  bosun-x — MCP server (stdio).

  Exposes the handoff CLI and the project/task data as MCP tools, so
  Claude Code, Codex, Cursor, Cline, Zed — any MCP client — can drive the workflow
  without shelling out or hand-editing files. See mcp/README.md for wiring.

  Write operations on the handoff log go through cli.mjs (the one lock
  holder). Task-status edits reuse lib/board.mjs so tasks.yml keeps its
  formatting and the STATUS.md board stays current. Reads are direct.
*/
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { load as loadYaml } from "js-yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setTaskStatus, taskPrefixFor, syncStatusBoard } from "../lib/board.mjs";
import { isoTimestamp as sydneyIsoTimestamp } from "../lib/time.mjs";
import { projectsDir as projectsDirOf } from "../lib/config.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HANDOFF = path.join(repoRoot, "cli.mjs");
const projectsDir = projectsDirOf();
const dataDir = path.dirname(projectsDir);

const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const fail = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true });

function projectDir(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`bad project slug: ${slug}`);
  return path.join(projectsDir, slug);
}

async function readYaml(file) {
  try {
    return loadYaml(await fs.readFile(file, "utf8")) || {};
  } catch {
    return null;
  }
}

async function listSlugs() {
  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function runHandoff(args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [HANDOFF, ...args], {
      cwd: repoRoot,
      env: { ...process.env, BOSUN_DATA: dataDir },
      timeout: 20_000,
    });
    return text((stdout + stderr).trim() || "ok");
  } catch (err) {
    return fail((err.stdout || "") + (err.stderr || "") || err.message);
  }
}

// --- handoff tools (delegate to the CLI, the single lock holder) --------------

const server = new McpServer({ name: "bosun-x", version: "0.1.0" });

const checkpointShape = {
  project: z.string().describe("project slug"),
  agent: z.string().describe("who is doing the work, e.g. Claude or Codex"),
  done: z.string().describe("what was just verified done (distinguish done from attempted)"),
  state: z.string().describe("current state: what works, what doesn't, blockers"),
  next: z.string().describe("one concrete next action"),
  tests: z.string().optional().describe("actual test/verification results"),
  task: z.string().optional().describe("task key(s) this belongs to, e.g. CR-16 or 16 (comma-separated)"),
};

server.registerTool(
  "handoff_resume",
  {
    title: "Resume a project",
    description: "The bounded resume snapshot for a project — read this on takeover before changing anything.",
    inputSchema: { project: z.string() },
  },
  ({ project }) => runHandoff(["resume", project]),
);

server.registerTool(
  "handoff_status",
  {
    title: "Handoff status",
    description: "One-line active/stale/finished status per project (all projects if none given).",
    inputSchema: { project: z.string().optional() },
  },
  ({ project }) => runHandoff(project ? ["status", project] : ["status"]),
);

server.registerTool(
  "handoff_start",
  {
    title: "Start work",
    description: "Open a handoff at the start of substantive work. Pass `task` so the task board tracks it.",
    inputSchema: {
      project: z.string(),
      agent: z.string(),
      summary: z.string().describe("what you're about to do"),
      task: z.string().optional(),
    },
  },
  ({ project, agent, summary, task }) =>
    runHandoff(["start", project, "--agent", agent, "--summary", summary, ...(task ? ["--task", task] : [])]),
);

for (const kind of ["checkpoint", "finish"]) {
  server.registerTool(
    `handoff_${kind}`,
    {
      title: kind === "finish" ? "Finish work" : "Checkpoint",
      description:
        kind === "finish"
          ? "Close the handoff before a planned stop. `task` moves those tasks to done."
          : "Record a verified milestone (do this at least every 30 min of active work).",
      inputSchema: checkpointShape,
    },
    ({ project, agent, done, state, next, tests, task }) =>
      runHandoff([
        kind,
        project,
        "--agent",
        agent,
        "--done",
        done,
        "--state",
        state,
        "--next",
        next,
        ...(tests ? ["--tests", tests] : []),
        ...(task ? ["--task", task] : []),
      ]),
  );
}

server.registerTool(
  "handoff_doctor",
  {
    title: "Doctor",
    description: "Report task/handoff drift and stale STATUS.md boards across every project. `fix` reconciles the safe cases.",
    inputSchema: { fix: z.boolean().optional() },
  },
  ({ fix }) => runHandoff(fix ? ["doctor", "--fix"] : ["doctor"]),
);

// --- project / task data (direct reads + surgical writes) --------------------

async function projectSummary(slug) {
  const dir = projectDir(slug);
  const meta = await readYaml(path.join(dir, "project.yml"));
  if (!meta) return null;
  const state = (await readYaml(path.join(dir, "HANDOFF.yml"))) || {};
  const tasksDoc = (await readYaml(path.join(dir, "tasks.yml"))) || { tasks: [] };
  const tasks = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
  const age = state.checkpoint_at ? Math.floor((Date.now() - Date.parse(state.checkpoint_at)) / 60000) : null;
  const stale = state.active && age !== null && age > (state.stale_after_minutes ?? 30);
  const count = (s) => tasks.filter((t) => t.status === s).length;
  return {
    slug,
    name: meta.name ?? slug,
    stage: meta.stage,
    status: meta.status ?? null,
    host: meta.host ?? null,
    path: meta.path ?? null,
    handoff: state.checkpoint_at ? (state.active ? (stale ? "stale" : "active") : "finished") : "none",
    handoff_agent: state.agent ?? null,
    tasks: { in_progress: count("in_progress"), todo: count("todo"), backlog: count("backlog"), done: count("done") },
  };
}

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "Every tracked project with its stage, real-world status, host, handoff state, and task counts.",
    inputSchema: {},
  },
  async () => {
    const rows = (await Promise.all((await listSlugs()).map(projectSummary))).filter(Boolean);
    return text(JSON.stringify(rows, null, 2));
  },
);

server.registerTool(
  "project_brief",
  {
    title: "Project brief",
    description:
      "Everything an agent needs to pick up work on a project in one blob: metadata, SPEC.md, the handoff resume snapshot, open tasks, and the STATUS.md board. Call this at session start.",
    inputSchema: { project: z.string() },
  },
  async ({ project }) => {
    const dir = projectDir(project);
    const meta = await readYaml(path.join(dir, "project.yml"));
    if (!meta) return fail(`no such project: ${project}`);
    const prefix = await taskPrefixFor(dir, project);

    const spec = await fs.readFile(path.join(dir, "SPEC.md"), "utf8").catch(() => "");
    const status = await fs.readFile(path.join(dir, "STATUS.md"), "utf8").catch(() => "");
    const board = status.match(/<!-- bosun:task-board:start -->[\s\S]*?<!-- bosun:task-board:end -->/)?.[0];

    const resumeRes = await runHandoff(["resume", project]);
    const resume = resumeRes.isError ? "_no handoff started yet_" : resumeRes.content[0].text;
    const tasksDoc = (await readYaml(path.join(dir, "tasks.yml"))) || { tasks: [] };
    const tasks = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
    const open = tasks
      .filter((t) => t.status === "in_progress" || t.status === "todo")
      .sort((a, b) => (a.num ?? 0) - (b.num ?? 0))
      .map((t) => `- ${prefix}-${t.num} [${t.status}] ${t.title}`);

    return text(
      [
        `# ${meta.name ?? project} (${project})`,
        `stage: ${meta.stage} · status: ${meta.status ?? "?"} · host: ${meta.host ?? "?"} · path: ${meta.path ?? "?"}`,
        meta.repo?.url ? `repo: ${meta.repo.url}` : "",
        "",
        "## Spec",
        spec ? spec.slice(0, 4000) + (spec.length > 4000 ? "\n…(truncated)" : "") : "_no SPEC.md_",
        "",
        "## Handoff (resume snapshot)",
        resume,
        "",
        "## Open tasks",
        open.length ? open.join("\n") : "_none open_",
        `\n_${tasks.filter((t) => t.status === "done").length} done, ${tasks.filter((t) => t.status === "backlog").length} in backlog_`,
        board ? `\n## ${board}` : "",
      ]
        .filter((l) => l !== "")
        .join("\n"),
    );
  },
);

server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description: "Tasks for a project, optionally filtered by status.",
    inputSchema: {
      project: z.string(),
      status: z.enum(["backlog", "todo", "in_progress", "done"]).optional(),
    },
  },
  async ({ project, status }) => {
    const dir = projectDir(project);
    const prefix = await taskPrefixFor(dir, project);
    const doc = (await readYaml(path.join(dir, "tasks.yml"))) || { tasks: [] };
    const rows = (Array.isArray(doc.tasks) ? doc.tasks : [])
      .filter((t) => !status || t.status === status)
      .map((t) => ({
        key: `${prefix}-${t.num}`,
        title: t.title,
        status: t.status,
        parent: t.parent_id ? (doc.tasks.find((p) => p.id === t.parent_id)?.num ?? null) : null,
        updated: t.updated,
      }));
    return text(JSON.stringify(rows, null, 2));
  },
);

server.registerTool(
  "set_task_status",
  {
    title: "Set task status",
    description:
      "Move a task to backlog / todo / in_progress / done. Bumps `updated` and regenerates the STATUS.md board. Prefer passing `task` to handoff_start/checkpoint/finish for normal flow.",
    inputSchema: {
      project: z.string(),
      task: z.string().describe("task key or number, e.g. CR-16 or 16"),
      status: z.enum(["backlog", "todo", "in_progress", "done"]),
    },
  },
  async ({ project, task, status }) => {
    try {
      const r = await setTaskStatus(projectDir(project), project, task, status, sydneyIsoTimestamp());
      return text(r.noop ? `${r.key} already ${status}` : `${r.key}: ${r.from} → ${r.to}`);
    } catch (err) {
      return fail(err.message);
    }
  },
);

server.registerTool(
  "create_task",
  {
    title: "Create task",
    description: "Append a new task (status backlog) to a project's tasks.yml and refresh its STATUS.md board.",
    inputSchema: {
      project: z.string(),
      title: z.string(),
      description: z.string().optional(),
      parent: z.string().optional().describe("parent task key or number, for a sub-task"),
    },
  },
  async ({ project, title, description, parent }) => {
    const dir = projectDir(project);
    const file = path.join(dir, "tasks.yml");
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      return fail(`no tasks.yml for ${project}`);
    }
    const doc = loadYaml(raw) || {};
    const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
    const seq = Math.max(Number(doc.seq) || 0, ...tasks.map((t) => t.num ?? 0)) + 1;
    const prefix = await taskPrefixFor(dir, project);

    let parentId;
    if (parent) {
      const pn = Number(String(parent).replace(/^[A-Za-z]+-/, ""));
      const p = tasks.find((t) => t.num === pn);
      if (!p) return fail(`parent ${parent} not found`);
      parentId = p.id;
    }

    const now = sydneyIsoTimestamp();
    const id = randomUUID();
    const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const block = [
      `  - id: ${id}`,
      `    num: ${seq}`,
      `    title: ${esc(title)}`,
      ...(description ? [`    description: ${esc(description)}`] : []),
      `    status: backlog`,
      ...(parentId ? [`    parent_id: ${parentId}`] : []),
      `    depends_on: []`,
      `    created: ${esc(now)}`,
      `    updated: ${esc(now)}`,
      "",
    ].join("\n");

    let next = raw.replace(/^seq:\s*\d+\s*$/m, `seq: ${seq}`);
    if (!/^seq:/m.test(next)) next = `seq: ${seq}\n${next}`;
    next = next.replace(/\s*$/, "\n") + block + "\n";

    // sanity: must still parse and gain exactly one task
    const after = loadYaml(next);
    if (!after || !Array.isArray(after.tasks) || after.tasks.length !== tasks.length + 1) {
      return fail("refusing to write — the append did not round-trip");
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, file);
    await syncStatusBoard(dir, project, now);
    return text(`created ${prefix}-${seq} — ${title}`);
  },
);

await server.connect(new StdioServerTransport());
