import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, projectsDir } from "./config.mjs";
import { load as loadYaml } from "js-yaml";
import { resolveTaskRef, taskDisplayKey, taskPrefixFor } from "./board.mjs";

// Runtime telemetry is deliberately outside the tracked task/handoff files. A
// deployment may point BOSUN_ACTIVITY_DIR at a dedicated volume instead.
export const activityDir = () => path.resolve(process.env.BOSUN_ACTIVITY_DIR || path.join(dataDir(), ".activity"));
export const EVENT_KINDS = new Set([
  "session_start", "turn_start", "tool_start", "tool_end", "approval_request", "assignment",
  "turn_stop", "session_end", "interrupt", "subagent_start", "subagent_stop", "heartbeat",
]);
const SAFE_ID = /^[a-zA-Z0-9_.:@/-]{1,128}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_KEY = /^([A-Z]+)-\d+(?:\.\d+)*$/;

export async function resolveTaskKey(ref, project) {
  const key = String(ref || "").trim().toUpperCase();
  const match = TASK_KEY.exec(key);
  if (!match) throw new Error("a full task key such as BX-13 is required");
  if (project && !SAFE_SLUG.test(project)) throw new Error("invalid project");
  const candidates = project ? [project] : await fs.readdir(projectsDir());
  const found = [];
  for (const slug of candidates) {
    if (!SAFE_SLUG.test(slug)) continue;
    const dir = path.join(projectsDir(), slug);
    const prefix = await taskPrefixFor(dir, slug);
    if (prefix !== match[1]) continue;
    const raw = await fs.readFile(path.join(dir, "tasks.yml"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!raw) continue;
    const board = loadYaml(raw);
    const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
    const task = resolveTaskRef(key, tasks, prefix);
    if (task) found.push({ project: slug, task: taskDisplayKey(task, tasks, prefix) });
  }
  if (found.length > 1) throw new Error(`ambiguous task ${key}; pass --project`);
  if (!found.length) throw new Error(`unknown task ${key}`);
  return found[0];
}

export async function assignTask({ task, project, provider, session, host }) {
  if (!["codex", "claude"].includes(provider)) throw new Error("provider must be codex or claude");
  if (!session) throw new Error("session is required; pass --session or use an agent session environment");
  const resolved = await resolveTaskKey(task, project);
  const result = await appendEvent({ provider, session, host, kind: "assignment", ...resolved });
  return { ...resolved, session, provider, duplicate: result.duplicate };
}

export function validateEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("event must be an object");
  const allowed = new Set(["id", "provider", "session", "parent", "turn", "host", "kind", "project", "task", "at"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unsafe event field: ${key}`);
  const check = (value, name, pattern = SAFE_ID) => {
    if (typeof value !== "string" || !pattern.test(value)) throw new Error(`invalid ${name}`);
    return value;
  };
  if (!EVENT_KINDS.has(input.kind)) throw new Error("invalid event kind");
  if (!["claude", "codex", "bosun", "job"].includes(input.provider)) throw new Error("invalid provider");
  const at = input.at || new Date().toISOString();
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at)) || at.length > 40) throw new Error("invalid event time");
  return {
    v: 1,
    id: check(input.id || randomUUID(), "id"),
    provider: input.provider,
    session: check(input.session, "session"),
    parent: input.parent ? check(input.parent, "parent") : null,
    turn: input.turn ? check(input.turn, "turn") : null,
    host: input.host ? check(input.host, "host", SAFE_SLUG) : null,
    kind: input.kind,
    project: input.project ? check(input.project, "project", SAFE_SLUG) : null,
    task: input.task ? check(input.task, "task", SAFE_ID) : null,
    at: new Date(at).toISOString(),
    received: new Date().toISOString(),
  };
}

async function withLock(dir, callback) {
  const file = path.join(dir, ".writer.lock");
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try { return await callback(); }
      finally { await handle.close(); await fs.unlink(file).catch(() => {}); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 15_000) await fs.unlink(file).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("activity writer busy");
}

export async function appendEvent(input) {
  const event = validateEvent(input);
  if (event.task) {
    if (!event.project) throw new Error("task requires a project");
    const projectDir = path.join(dataDir(), "projects", event.project);
    const board = loadYaml(await fs.readFile(path.join(projectDir, "tasks.yml"), "utf8"));
    const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
    const prefix = await taskPrefixFor(projectDir, event.project);
    const match = resolveTaskRef(event.task, tasks, prefix);
    if (!match) throw new Error(`unknown task ${event.task} in ${event.project}`);
    event.task = taskDisplayKey(match, tasks, prefix);
  }
  const dir = activityDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return withLock(dir, async () => {
    const file = path.join(dir, `${event.received.slice(0, 10)}.jsonl`);
    const raw = await fs.readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (raw.length > 8_000_000) throw new Error("daily activity file full");
    if (raw.includes(`"id":"${event.id}"`)) return { event, duplicate: true };
    await fs.appendFile(file, JSON.stringify(event) + "\n", { mode: 0o600 });
    if (event.kind === "assignment" || event.kind === "session_end") {
      const mapFile = path.join(dir, "session-assignments.json");
      let assignments = {};
      try {
        const saved = JSON.parse(await fs.readFile(mapFile, "utf8"));
        if (saved && typeof saved === "object" && !Array.isArray(saved)) assignments = saved;
      } catch { /* first assignment or damaged cache; the event log remains authoritative */ }
      const key = `${event.provider}:${event.session}`;
      if (event.kind === "session_end" && (!assignments[key] || assignments[key].at <= event.at)) delete assignments[key];
      else if (!assignments[key] || assignments[key].at <= event.at) {
        assignments[key] = { project: event.project, task: event.task, at: event.at };
      }
      const cutoff = Date.now() - 60 * 86_400_000;
      for (const [name, value] of Object.entries(assignments)) {
        if (!value?.at || Date.parse(value.at) < cutoff) delete assignments[name];
      }
      const temp = `${mapFile}.tmp-${process.pid}`;
      await fs.writeFile(temp, JSON.stringify(assignments), { mode: 0o600 });
      await fs.rename(temp, mapFile);
    }
    const names = await fs.readdir(dir);
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    for (const name of names) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
    return { event, duplicate: false };
  });
}
