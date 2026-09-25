import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./config.mjs";

// Runtime telemetry is deliberately outside the tracked task/handoff files. A
// deployment may point BOSUN_ACTIVITY_DIR at a dedicated volume instead.
export const activityDir = () => path.resolve(process.env.BOSUN_ACTIVITY_DIR || path.join(dataDir(), ".activity"));
export const EVENT_KINDS = new Set([
  "session_start", "turn_start", "tool_start", "tool_end", "approval_request",
  "turn_stop", "session_end", "interrupt", "subagent_start", "subagent_stop", "heartbeat",
]);
const SAFE_ID = /^[a-zA-Z0-9_.:@/-]{1,128}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
    const names = await fs.readdir(dir);
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    for (const name of names) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
    return { event, duplicate: false };
  });
}
