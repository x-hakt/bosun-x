#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { isoTimestamp } from "./lib/time.mjs";
import { syncStatusBoard, boardIsCurrent, taskPrefixFor, replaceTaskField } from "./lib/board.mjs";
import { projectsDir as projectsDirOf, staleMinutes as staleMinutesOf } from "./lib/config.mjs";

const sydneyIsoTimestamp = isoTimestamp;
const projectsDir = projectsDirOf();
const staleMinutes = staleMinutesOf();
const TRAIL_LENGTH = 4;

const clip = (text, max) => {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

function parseTaskRefs(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw).split(",").map((token) => token.trim()).filter(Boolean);
}

// Moves the named tasks to targetStatus in projects/<slug>/tasks.yml. Returns one record
// per ref describing what happened (transition / noop / skipped) for the caller to print
// and to record in the handoff snapshot. Never reopens a task that is already done.
async function applyTaskStatus(dir, slug, refs, targetStatus, now) {
  if (!refs.length) return [];
  const file = path.join(dir, "tasks.yml");
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`--task given but ${slug}/tasks.yml does not exist`);
  }
  const parsed = loadYaml(raw) || {};
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const prefix = await taskPrefixFor(dir, slug);

  let text = raw;
  const results = [];
  for (const ref of refs) {
    const upper = ref.toUpperCase();
    const keyed = /^([A-Z]+)-(\d+)$/.exec(upper);
    let num;
    if (keyed) {
      if (keyed[1] !== prefix) throw new Error(`task ${ref}: prefix ${keyed[1]} is not ${slug}'s prefix ${prefix}`);
      num = Number(keyed[2]);
    } else if (/^\d+$/.test(upper)) {
      num = Number(upper);
    } else {
      throw new Error(`--task value "${ref}" is not a task number or key (e.g. ${prefix}-13 or 13)`);
    }

    const task = tasks.find((entry) => entry.num === num);
    if (!task) throw new Error(`task ${prefix}-${num} not found in ${slug}/tasks.yml`);
    const key = `${prefix}-${num}`;

    if (task.status === targetStatus) {
      results.push({ key, id: task.id, from: task.status, to: targetStatus, noop: true });
      continue;
    }
    if (task.status === "done" && targetStatus === "in_progress") {
      results.push({ key, id: task.id, from: "done", to: targetStatus, skipped: true });
      continue;
    }
    text = replaceTaskField(text, task.id, "status", targetStatus);
    try {
      text = replaceTaskField(text, task.id, "updated", `'${now}'`);
    } catch {
      // A pre-numbering record with no `updated:` — status still moves, timestamp just isn't bumped.
    }
    results.push({ key, id: task.id, from: task.status, to: targetStatus });
  }

  const changed = results.filter((result) => !result.noop && !result.skipped);
  if (changed.length) {
    const after = loadYaml(text);
    const ok = after && Array.isArray(after.tasks) && after.tasks.length === tasks.length
      && changed.every((result) => after.tasks.find((entry) => entry.id === result.id)?.status === targetStatus);
    if (!ok) throw new Error(`refusing to write ${slug}/tasks.yml — the surgical status edit did not round-trip cleanly`);
    await atomicWrite(file, text);
  }
  return results;
}

function reportTransitions(results) {
  for (const result of results) {
    if (result.noop) console.log(`  ${result.key}: already ${result.to}`);
    else if (result.skipped) console.log(`  ${result.key}: left at done — set it back explicitly if that is wrong`);
    else console.log(`  ${result.key}: ${result.from} → ${result.to}`);
  }
}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  bosun start <slug> --agent <name> --summary <work> [--task <KEY[,KEY]>]
  bosun checkpoint <slug> --agent <name> --done <work> --state <state> --next <step> [--tests <result>] [--task <KEY[,KEY]>]
  bosun finish <slug> --agent <name> --done <work> --state <state> --next <step> [--tests <result>] [--task <KEY[,KEY]>]
  bosun resume <slug>
  bosun heartbeat <slug> --agent <name>
  bosun status [slug]
  bosun doctor [--fix]
  bosun init [dir]        # add the bosun-x block to this repo's CLAUDE.md / AGENTS.md

Data dir: $BOSUN_DATA, else the current directory. Projects live under <data>/projects/<slug>/.
Timezone for stamps: $BOSUN_TZ, else bosun.config.json, else the system zone.

--task couples a checkpoint to one or more tasks.yml entries (e.g. CR-13, or just 13):
start/checkpoint move them to in_progress, finish moves them to done. Optional — the
handoff works exactly as before without it. It never reopens a task already done.

`);
  process.exit(message ? 1 : 0);
}

const BOOLEAN_FLAGS = new Set(["fix"]);

function parseArgs(argv) {
  const [command, maybeSlug, ...tail] = argv;
  // `status` and `doctor` take an optional positional slug; everything after that is
  // flags. A `--`-prefixed second token is a flag, not the slug.
  const slug = maybeSlug && !maybeSlug.startsWith("--") ? maybeSlug : undefined;
  const rest = slug ? tail : (maybeSlug ? [maybeSlug, ...tail] : tail);
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key?.startsWith("--")) usage(`invalid option ${key ?? ""}`);
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (rest[i + 1] === undefined) usage(`--${name} requires a value`);
    options[name] = rest[i + 1];
    i += 1;
  }
  return { command, slug, options };
}

function requireOptions(options, names) {
  for (const name of names) if (!options[name]?.trim()) usage(`--${name} is required`);
}

function projectPath(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) usage("a valid project slug is required");
  return path.join(projectsDir, slug);
}

async function assertProject(dir) {
  try {
    await fs.access(path.join(dir, "project.yml"));
  } catch {
    usage(`project not found: ${path.basename(dir)}`);
  }
}

async function withProjectLock(dir, action) {
  const lockDir = path.join(dir, ".handoff.lock");
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`handoff is locked for ${path.basename(dir)}; another writer may be active`);
    throw error;
  }
  try {
    return await action();
  } finally {
    await fs.rmdir(lockDir).catch(() => {});
  }
}

async function atomicWrite(file, content) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o644 });
  await fs.rename(temp, file);
}

async function readState(dir) {
  try {
    return loadYaml(await fs.readFile(path.join(dir, "HANDOFF.yml"), "utf8")) || {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function handoffHeader() {
  return `# Handoff Log\n\nAppend-only, newest entry on top. Each entry records timestamp, agent, verified work,\ncurrent state, tests, and explicit next steps. Read this before changing the project.\n\n---\n`;
}

async function prependEntry(dir, entry) {
  const file = path.join(dir, "HANDOFF.md");
  let current;
  try {
    current = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    current = handoffHeader();
  }
  const divider = current.indexOf("\n---\n");
  const next = divider >= 0
    ? `${current.slice(0, divider + 5)}\n${entry.trim()}\n\n${current.slice(divider + 5).trimStart()}`
    : `${handoffHeader()}\n${entry.trim()}\n\n${current.trim()}\n`;
  await atomicWrite(file, next.trimEnd() + "\n");
}

function entryFor(command, options, now, taskKeys) {
  const label = command === "start" ? "Work started" : command === "finish" ? "Work finished" : "Checkpoint";
  const lines = [`## ${now} — ${options.agent}`, "", `**${label}**: ${options.summary || options.done}`];
  if (taskKeys && taskKeys.length) lines.push("", `**Tasks**: ${taskKeys.join(", ")} (${command === "finish" ? "done" : "in progress"})`);
  if (options.state) lines.push("", `**Current state**: ${options.state}`);
  if (options.tests) lines.push("", `**Verification**: ${options.tests}`);
  if (options.next) lines.push("", `**Next step**: ${options.next}`);
  return lines.join("\n");
}

async function writeCheckpoint(command, slug, options) {
  requireOptions(options, command === "start" ? ["agent", "summary"] : ["agent", "done", "state", "next"]);
  const dir = projectPath(slug);
  await assertProject(dir);
  const now = sydneyIsoTimestamp();
  await withProjectLock(dir, async () => {
    const previous = await readState(dir);
    const age = stateAgeMinutes(previous);
    const previousStale = previous.active && age !== null && age > (previous.stale_after_minutes || staleMinutes);
    if (command === "start" && previous.active && !previousStale) {
      throw new Error(`${slug} already has active work owned by ${previous.agent || "unknown"}; resume it or wait until it is stale`);
    }
    if (command !== "start" && !previous.active) {
      throw new Error(`${slug} has no active handoff; run start first`);
    }
    if (command !== "start" && previous.agent !== options.agent) {
      throw new Error(`${slug} is owned by ${previous.agent || "unknown"}, not ${options.agent}`);
    }
    const active = command !== "finish";
    const targetStatus = command === "finish" ? "done" : "in_progress";
    const refs = parseTaskRefs(options.task);
    const transitions = await applyTaskStatus(dir, slug, refs, targetStatus, now);

    // Tasks recorded on the snapshot: the ones just touched, or — if this checkpoint
    // named none — whatever the previous checkpoint was already carrying, so the
    // link survives a checkpoint that forgot to repeat --task.
    const carried = Array.isArray(previous.latest?.tasks) ? previous.latest.tasks : [];
    const taskKeys = refs.length ? transitions.map((t) => t.key) : carried;

    const latest = {
      kind: command,
      work: options.summary || options.done,
      current_state: options.state || (command === "start" ? "Work has started; no milestone verified yet." : ""),
      verification: options.tests || "Not yet verified.",
      next_step: options.next || (command === "start" ? "Complete the first bounded milestone and checkpoint it." : ""),
    };
    if (taskKeys.length) latest.tasks = taskKeys;
    const priorTrail = Array.isArray(previous.trail) ? previous.trail : [];
    const trail = [
      { at: now, kind: command, agent: options.agent, work: clip(latest.work, 120) },
      ...priorTrail,
    ].slice(0, TRAIL_LENGTH);
    const nextState = {
      active,
      agent: options.agent,
      summary: options.summary || options.done,
      started_at: command === "start" || !previous.started_at ? now : previous.started_at,
      checkpoint_at: now,
      stale_after_minutes: staleMinutes,
      latest,
      trail,
    };
    await prependEntry(dir, entryFor(command, options, now, taskKeys));
    await atomicWrite(path.join(dir, "HANDOFF.yml"), dumpYaml(nextState, { noRefs: true, lineWidth: 1000 }));

    // STATUS.md's task board is regenerated from tasks.yml on every checkpoint —
    // whether or not --task was used — so the file never drifts from real state.
    const board = await syncStatusBoard(dir, slug, now).catch((error) => ({ error }));

    console.log(`${command}: ${slug} at ${now}`);
    reportTransitions(transitions);
    if (board?.changed) console.log("  STATUS.md task board refreshed");
    if (board?.error) console.log(`  warning: could not refresh STATUS.md board (${board.error.message})`);
    if (command === "finish" && !refs.length && carried.length) {
      console.log(`  note: this handoff was carrying ${carried.join(", ")} — pass --task to mark done, or set the status directly`);
    }
  });
}

async function resume(slug) {
  const dir = projectPath(slug);
  await assertProject(dir);
  const state = await readState(dir);
  if (!state.checkpoint_at) throw new Error(`${slug} has no handoff state`);
  const age = stateAgeMinutes(state);
  const stale = state.active && age !== null && age > (state.stale_after_minutes || staleMinutes);
  const latest = state.latest || {};
  const lines = [
    `project: ${slug}`,
    `status: ${state.active ? (stale ? "stale" : "active") : "complete"}`,
    `agent: ${state.agent || "unknown"}`,
    ...(Array.isArray(latest.tasks) && latest.tasks.length ? [`tasks: ${latest.tasks.join(", ")}`] : []),
    `checkpoint: ${state.checkpoint_at} (${age}m ago)`,
    `work: ${latest.work || state.summary || "not recorded"}`,
    `current_state: ${latest.current_state || "Legacy handoff: inspect only the newest HANDOFF.md entry if more detail is required."}`,
    `verification: ${latest.verification || "not recorded"}`,
    `next_step: ${latest.next_step || "not recorded"}`,
  ];
  const olderTrail = (Array.isArray(state.trail) ? state.trail : []).slice(1);
  if (olderTrail.length) {
    lines.push("", "trail (older, newest first):");
    for (const item of olderTrail) {
      lines.push(`  - ${item.at || "?"} ${item.agent || "?"}: ${item.work || "not recorded"}`);
    }
  }
  console.log(lines.join("\n"));
}

async function heartbeat(slug, options) {
  requireOptions(options, ["agent"]);
  const dir = projectPath(slug);
  await assertProject(dir);
  await withProjectLock(dir, async () => {
    const state = await readState(dir);
    if (!state.active) throw new Error(`${slug} has no active handoff`);
    if (state.agent !== options.agent) throw new Error(`${slug} is owned by ${state.agent || "unknown"}, not ${options.agent}`);
    state.checkpoint_at = sydneyIsoTimestamp();
    await atomicWrite(path.join(dir, "HANDOFF.yml"), dumpYaml(state, { noRefs: true, lineWidth: 1000 }));
  });
}

function stateAgeMinutes(state) {
  const timestamp = Date.parse(state.checkpoint_at || "");
  return Number.isFinite(timestamp) ? Math.floor((Date.now() - timestamp) / 60000) : null;
}

async function listProjectSlugs() {
  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function showStatus(slug) {
  const slugs = slug ? [slug] : await listProjectSlugs();
  for (const item of slugs) {
    const dir = projectPath(item);
    await assertProject(dir);
    const state = await readState(dir);
    if (!state.checkpoint_at) {
      console.log(`${item}: no checkpoint state`);
      continue;
    }
    const age = stateAgeMinutes(state);
    const stale = state.active && age !== null && age > (state.stale_after_minutes || staleMinutes);
    const tasks = Array.isArray(state.latest?.tasks) && state.latest.tasks.length ? ` · ${state.latest.tasks.join(",")}` : "";
    console.log(`${item}: ${state.active ? (stale ? "STALE" : "active") : "finished"} · ${state.agent || "unknown"} · ${age}m${tasks} · ${state.summary || ""}`);
  }
}

async function doctor(fix) {
  let failed = false;
  let fixes = 0;
  const now = sydneyIsoTimestamp();
  for (const slug of await listProjectSlugs()) {
    const dir = projectPath(slug);
    const missing = [];
    for (const name of ["HANDOFF.md", "HANDOFF.yml"]) {
      try { await fs.access(path.join(dir, name)); } catch { missing.push(name); }
    }
    if (missing.length) {
      failed = true;
      console.log(`${slug}: missing ${missing.join(", ")}`);
      continue;
    }
    const state = await readState(dir);
    const required = [state.agent, state.summary, state.checkpoint_at, state.latest?.work, state.latest?.current_state, state.latest?.verification, state.latest?.next_step];
    const trailOk = state.trail === undefined || (Array.isArray(state.trail) && state.trail.length > 0);
    if (typeof state.active !== "boolean" || !Number.isFinite(state.stale_after_minutes) || required.some((value) => !value) || !trailOk) {
      failed = true;
      console.log(`${slug}: HANDOFF.yml is not a complete bounded resume snapshot`);
    }

    // Task/handoff drift — the CR-13 failure mode: a task left mid-flight with nothing
    // active to explain it, or a live handoff whose named task never moved. --fix
    // reconciles what it safely can and regenerates the STATUS.md board.
    const drift = await reconcileTasks(dir, slug, state, now, fix);
    for (const line of drift.messages) console.log(line);
    if (drift.messages.length && !drift.resolved) failed = true;
    fixes += drift.fixed;

    const boardStale = !(await boardIsCurrent(dir, slug));
    if (boardStale) {
      if (fix) {
        await syncStatusBoard(dir, slug, now);
        console.log(`${slug}: STATUS.md task board regenerated`);
        fixes += 1;
      } else {
        failed = true;
        console.log(`${slug}: STATUS.md task board is out of step with tasks.yml (run: bosun doctor --fix)`);
      }
    }
  }
  if (fix) console.log(`bosun doctor --fix: ${fixes} correction${fixes === 1 ? "" : "s"} applied`);
  if (failed && !fix) process.exitCode = 1;
  else if (!failed && !fix) console.log("bosun doctor: all tracked projects are initialized, no task/handoff drift");
}

function setStatusInText(text, id, status, now) {
  let next = replaceTaskField(text, id, "status", status);
  try {
    next = replaceTaskField(next, id, "updated", `'${now}'`);
  } catch {
    // pre-numbering record with no updated: — status still moves
  }
  return next;
}

// Returns { messages, fixed, resolved }. When `fix` is true it applies the safe
// corrections (surgical tasks.yml edits) and `resolved` is true if nothing was left
// unaddressed.
async function reconcileTasks(dir, slug, state, now, fix) {
  const file = path.join(dir, "tasks.yml");
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { messages: [], fixed: 0, resolved: true };
  }
  const doc = loadYaml(raw);
  if (!doc || !Array.isArray(doc.tasks)) return { messages: [], fixed: 0, resolved: true };

  const prefix = await taskPrefixFor(dir, slug);
  const named = new Set((Array.isArray(state.latest?.tasks) ? state.latest.tasks : []).map((key) => Number(String(key).split("-").pop())));
  const finishForgotTask = !state.active && state.latest?.kind === "finish";

  const messages = [];
  let text = raw;
  let fixed = 0;
  let unresolved = 0;

  for (const task of doc.tasks) {
    const key = `${prefix}-${task.num}`;
    let target = null;
    let why = "";

    if (state.active && named.has(task.num) && task.status !== "in_progress" && task.status !== "done") {
      target = "in_progress";
      why = `active handoff names ${key} but it is "${task.status}"`;
    } else if (!state.active && task.status === "in_progress") {
      if (named.has(task.num) && finishForgotTask) {
        target = "done";
        why = `${key} was the finished handoff's task but is still in_progress`;
      } else {
        target = "todo";
        why = `${key} is in_progress but no handoff is working it`;
      }
    }

    if (!target) continue;
    if (fix) {
      text = setStatusInText(text, task.id, target, now);
      fixed += 1;
      messages.push(`${slug}: ${why} → set ${target}`);
    } else {
      unresolved += 1;
      messages.push(`${slug}: ${why} (fix: → ${target})`);
    }
  }

  if (fix && fixed) {
    const after = loadYaml(text);
    if (!after || !Array.isArray(after.tasks) || after.tasks.length !== doc.tasks.length) {
      throw new Error(`refusing to write ${slug}/tasks.yml — reconcile edit did not round-trip`);
    }
    await atomicWrite(file, text);
    await syncStatusBoard(dir, slug, now);
  }

  return { messages, fixed, resolved: unresolved === 0 };
}

const AGENT_BLOCK = [
  "<!-- bosun-x:start -->",
  "## Handoff — continuity across sessions and agents",
  "",
  "This repo is tracked with bosun-x. State lives in plain files under the data dir;",
  "`grep` and a text editor are first-class.",
  "",
  "- Start substantive work: `bosun start <project> --agent <you> --summary <what> --task <KEY>`.",
  "- After every verified milestone (≥ every 30 min of active change, and before any long or",
  "  risky step): `bosun checkpoint <project> --agent <you> --done <verified> --state <where things are>",
  "  --next <one concrete action> --task <KEY>`.",
  "- Before a planned stop: `bosun finish ... --task <KEY>` (moves the task to done).",
  "- On takeover: `bosun resume <project>` — read only that, then `git status` and recent commits.",
  "- `--task` keeps the task board honest; `bosun doctor [--fix]` reports and reconciles drift.",
  "",
  "A checkpoint distinguishes verified work from attempts, names blockers, and gives one next action.",
  "Never assume the next agent can read your transcript.",
  "<!-- bosun-x:end -->",
].join("\n");

async function initRepo(dir) {
  const root = dir ? path.resolve(dir) : process.cwd();
  const candidates = ["CLAUDE.md", "AGENTS.md", ".cursorrules", path.join(".github", "copilot-instructions.md")];
  let found = 0;
  let changed = 0;
  for (const rel of candidates) {
    const file = path.join(root, rel);
    let current;
    try {
      current = await fs.readFile(file, "utf8");
    } catch {
      continue; // only update files that already exist — don't guess which an agent uses
    }
    found += 1;
    const next = current.includes("<!-- bosun-x:start -->")
      ? current.replace(/<!-- bosun-x:start -->[\s\S]*?<!-- bosun-x:end -->/, AGENT_BLOCK)
      : `${current.trimEnd()}\n\n${AGENT_BLOCK}\n`;
    if (next !== current) {
      await atomicWrite(file, next);
      console.log(`updated ${rel}`);
      changed += 1;
    }
  }
  if (found === 0) {
    console.log("no CLAUDE.md / AGENTS.md / .cursorrules / copilot-instructions.md here — create one and re-run");
  } else if (changed === 0) {
    console.log("already up to date");
  }
}

const { command, slug, options } = parseArgs(process.argv.slice(2));
try {
  if (["start", "checkpoint", "finish"].includes(command)) await writeCheckpoint(command, slug, options);
  else if (command === "status") await showStatus(slug);
  else if (command === "resume") await resume(slug);
  else if (command === "heartbeat") await heartbeat(slug, options);
  else if (command === "doctor") await doctor(Boolean(options.fix));
  else if (command === "init") await initRepo(slug);
  else usage();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
