// Generates the "Task board" block inside a project's STATUS.md from its tasks.yml,
// so the file always reflects real task state without anyone editing it by hand.
//
// Used by cli.mjs (regenerates on every checkpoint) and by mcp/server.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

const START = "<!-- bosun:task-board:start -->";
const END = "<!-- bosun:task-board:end -->";
const SHIPPED_KEYS_SHOWN = 12;

// bosun-x-dashboard -> BXD, x-hakt -> XH, jellyfin -> JEL. Speakable task ids.
export function deriveTaskPrefix(slug) {
  const segments = String(slug).split(/[-_]/).filter(Boolean);
  if (segments.length === 0) return "T";
  if (segments.length === 1) return segments[0].slice(0, 3).toUpperCase();
  return segments.map((segment) => segment[0]).join("").slice(0, 4).toUpperCase();
}

export async function taskPrefixFor(dir, slug) {
  try {
    const meta = loadYaml(await fs.readFile(path.join(dir, "project.yml"), "utf8")) || {};
    if (meta.key && String(meta.key).trim()) return String(meta.key).trim().toUpperCase();
  } catch {
    // fall through to the derived prefix
  }
  return deriveTaskPrefix(slug);
}

async function atomicWrite(file, content) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
  await fs.rename(temp, file);
}

const TASK_STATUSES = ["backlog", "todo", "in_progress", "done"];

// Surgical single-field rewrite of one task block in tasks.yml text, so the file keeps
// its hand-authored folded scalars (a full js-yaml round-trip would reflow every one).
export function replaceTaskField(text, id, field, value) {
  const lines = text.split("\n");
  let inTarget = false;
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^ {2}- id:\s*(.+?)\s*$/.exec(lines[i]);
    if (idMatch) {
      inTarget = idMatch[1].replace(/^["']|["']$/g, "") === id;
      continue;
    }
    if (inTarget) {
      const fieldMatch = new RegExp(`^( {4})${field}:\\s`).exec(lines[i]);
      if (fieldMatch) {
        lines[i] = `${fieldMatch[1]}${field}: ${value}`;
        return lines.join("\n");
      }
    }
  }
  throw new Error(`could not locate "${field}" for task ${id} in tasks.yml`);
}

// Sets one task's status in projects/<slug>/tasks.yml (surgically), bumps `updated`, and
// regenerates the STATUS.md board. Returns { key, from, to }. Used by the handoff CLI's
// --task and by the MCP server's set_task_status.
export async function setTaskStatus(dir, slug, ref, target, now) {
  if (!TASK_STATUSES.includes(target)) {
    throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}`);
  }
  const file = path.join(dir, "tasks.yml");
  const raw = await fs.readFile(file, "utf8");
  const doc = loadYaml(raw);
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const prefix = await taskPrefixFor(dir, slug);

  const upper = String(ref).toUpperCase();
  const keyed = /^([A-Z]+)-(\d+)$/.exec(upper);
  const num = keyed ? Number(keyed[2]) : /^\d+$/.test(upper) ? Number(upper) : NaN;
  if (keyed && keyed[1] !== prefix) throw new Error(`task ${ref}: prefix is not ${slug}'s (${prefix})`);
  if (Number.isNaN(num)) throw new Error(`unrecognised task ref: ${ref}`);

  const task = tasks.find((t) => t.num === num);
  if (!task) throw new Error(`task ${prefix}-${num} not found in ${slug}`);
  const key = `${prefix}-${num}`;
  if (task.status === target) return { key, from: task.status, to: target, noop: true };

  let text = replaceTaskField(raw, task.id, "status", target);
  try {
    text = replaceTaskField(text, task.id, "updated", `'${now}'`);
  } catch {
    /* pre-numbering record with no updated: */
  }
  const after = loadYaml(text);
  if (!after || after.tasks.length !== tasks.length || after.tasks.find((t) => t.id === task.id)?.status !== target) {
    throw new Error(`refusing to write ${slug}/tasks.yml — status edit did not round-trip`);
  }
  await atomicWrite(file, text);
  await syncStatusBoard(dir, slug, now);
  return { key, from: task.status, to: target };
}

const clipTitle = (title) => {
  const value = String(title || "").replace(/\s+/g, " ").trim();
  return value.length > 90 ? `${value.slice(0, 89).trimEnd()}…` : value;
};

// Renders the board body (everything between the markers, timestamp line included).
// `stamp` is passed separately so callers can compare bodies while ignoring the stamp.
export function renderBoardBody(tasks, prefix, stamp) {
  const asc = (a, b) => (a.num ?? 0) - (b.num ?? 0);
  const desc = (a, b) => (b.num ?? 0) - (a.num ?? 0);
  // Queues read oldest-first (do-next order); shipped reads newest-first.
  const of = (status) => tasks.filter((task) => task.status === status).sort(status === "done" ? desc : asc);
  const line = (task) => `- ${prefix}-${task.num} — ${clipTitle(task.title)}`;
  const keys = (list) => list.map((task) => `${prefix}-${task.num}`).join(", ");

  const inProgress = of("in_progress");
  const upNext = of("todo");
  const backlog = of("backlog");
  const shipped = of("done");

  const out = ["## Task board", "", `_Generated from tasks.yml · ${stamp}_`, ""];

  out.push("**In progress**");
  out.push(...(inProgress.length ? inProgress.map(line) : ["- _nothing in progress_"]));
  out.push("");

  if (upNext.length) {
    out.push("**Up next**", ...upNext.map(line), "");
  }
  if (backlog.length) {
    out.push(`**Backlog** (${backlog.length}) — ${keys(backlog)}`, "");
  }
  if (shipped.length) {
    const shown = keys(shipped.slice(0, SHIPPED_KEYS_SHOWN));
    const more = shipped.length > SHIPPED_KEYS_SHOWN ? ` … +${shipped.length - SHIPPED_KEYS_SHOWN} earlier` : "";
    out.push(`**Shipped** (${shipped.length}) — ${shown}${more}`, "");
  }

  return out.join("\n").trimEnd();
}

// Strip the "_Generated from tasks.yml · ..._" line so an unchanged board doesn't
// churn STATUS.md (and git) on every checkpoint just because the clock moved.
const withoutStamp = (body) => body.replace(/^_Generated from tasks\.yml · .*_$/m, "").trim();

function spliceBlock(statusMd, block) {
  const s = statusMd.indexOf(START);
  const e = statusMd.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    const before = statusMd.slice(0, s).trimEnd();
    const after = statusMd.slice(e + END.length).trimStart();
    return `${before}\n\n${block}\n${after ? `\n${after}` : ""}`.trimEnd() + "\n";
  }
  const base = statusMd.trim() ? statusMd.trimEnd() : "# Status";
  return `${base}\n\n${block}\n`;
}

// Reads projects/<slug>/tasks.yml, rewrites the marked block in STATUS.md, and only
// writes when the task content actually changed. Returns { changed }.
export async function syncStatusBoard(dir, slug, stamp) {
  let doc;
  try {
    doc = loadYaml(await fs.readFile(path.join(dir, "tasks.yml"), "utf8"));
  } catch {
    return { changed: false }; // no tasks.yml — nothing to board
  }
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  const prefix = await taskPrefixFor(dir, slug);
  const body = renderBoardBody(tasks, prefix, stamp);
  const block = `${START}\n\n${body}\n\n${END}`;

  const file = path.join(dir, "STATUS.md");
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    // STATUS.md may not exist yet — spliceBlock seeds it
  }

  const existing = current.match(new RegExp(`${START}\\n\\n([\\s\\S]*?)\\n\\n${END}`));
  if (existing && withoutStamp(existing[1]) === withoutStamp(body)) {
    return { changed: false };
  }

  await atomicWrite(file, spliceBlock(current, block));
  return { changed: true };
}

// For `handoff doctor`: is STATUS.md's board in step with tasks.yml right now?
export async function boardIsCurrent(dir, slug) {
  let doc;
  try {
    doc = loadYaml(await fs.readFile(path.join(dir, "tasks.yml"), "utf8"));
  } catch {
    return true;
  }
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : [];
  if (!tasks.length) return true;
  const prefix = await taskPrefixFor(dir, slug);
  const fresh = withoutStamp(renderBoardBody(tasks, prefix, "x"));

  let current = "";
  try {
    current = await fs.readFile(path.join(dir, "STATUS.md"), "utf8");
  } catch {
    return false;
  }
  const existing = current.match(new RegExp(`${START}\\n\\n([\\s\\S]*?)\\n\\n${END}`));
  return Boolean(existing) && withoutStamp(existing[1]) === fresh;
}
