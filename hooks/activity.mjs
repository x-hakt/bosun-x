#!/usr/bin/env node
// Optional Claude/Codex hook. Only a fixed set of metadata crosses to Bosun;
// prompts, tool inputs, transcripts and paths are never forwarded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const provider = process.argv[2];
if (!["claude", "codex"].includes(provider)) process.exit(0);
let payload;
try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(0); }
const kindFor = {
  SessionStart: "session_start", UserPromptSubmit: "turn_start", PreToolUse: "tool_start",
  PostToolUse: "tool_end", PostToolUseFailure: "tool_end", PermissionRequest: "approval_request",
  Stop: "turn_stop", SessionEnd: "session_end", Interrupt: "interrupt",
  SubagentStart: "subagent_start", SubagentStop: "subagent_stop", PostToolBatch: "heartbeat",
};
const kind = payload.hook_event_name === "SessionStart" && payload.source === "compact"
  ? "heartbeat" : kindFor[payload.hook_event_name];
if (!kind || typeof payload.session_id !== "string") process.exit(0);

const home = os.homedir();
const candidates = [process.env.BOSUN_DATA, path.join(home, "devserver/unified-services/bosun-x-data"), path.join(home, "unified-services/bosun-x-data")].filter(Boolean);
const data = candidates.find((dir) => fs.existsSync(path.join(dir, "projects")));
if (!data) process.exit(0);
const normalizedCwd = typeof payload.cwd === "string" ? payload.cwd.replace(/^\/home\/thrax\/devserver\//, "/home/thrax/") : "";
let project;
if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(process.env.BOSUN_PROJECT || "")
    && fs.existsSync(path.join(data, "projects", process.env.BOSUN_PROJECT, "project.yml"))) {
  project = process.env.BOSUN_PROJECT;
}
for (const slug of fs.readdirSync(path.join(data, "projects"))) {
  if (project) break;
  try {
    const record = fs.readFileSync(path.join(data, "projects", slug, "project.yml"), "utf8");
    const projectPath = record.match(/^path:\s*(.+)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
    if (typeof projectPath === "string" && (normalizedCwd === projectPath || normalizedCwd.startsWith(projectPath + "/"))) {
      project = slug; break;
    }
  } catch { /* an incomplete project does not block hook execution */ }
}
const agent = typeof payload.agent_id === "string" ? payload.agent_id : null;
const args = ["event", "--provider", provider, "--session", agent || payload.session_id,
  "--kind", kind, "--id", randomUUID(), "--at", new Date().toISOString(),
  "--host", os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")];
if (agent) args.push("--parent", payload.session_id);
if (typeof payload.turn_id === "string") args.push("--turn", payload.turn_id);
if (project) args.push("--project", project);
if (project && /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)?$/.test(process.env.BOSUN_TASK || "")) {
  args.push("--task", process.env.BOSUN_TASK);
}
const remote = data.includes("/devserver/");
const cli = remote ? "/home/thrax/unified-services/bosun-x/cli.mjs" : path.join(home, "unified-services/bosun-x/cli.mjs");
const commandFor = (eventArgs) => remote
  ? ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "devserver", "env", "BOSUN_DATA=/home/thrax/unified-services/bosun-x-data", "node", cli, ...eventArgs]]
  : ["node", [cli, ...eventArgs]];
const deliver = (eventArgs) => {
  const [command, commandArgs] = commandFor(eventArgs);
  // The hook inherits the agent's working directory, which is usually a project
  // repo rather than the Bosun data root. Pass the resolved data directory to
  // the local CLI just as the remote SSH command does.
  execFileSync(command, commandArgs, {
    timeout: 3000, stdio: "pipe", maxBuffer: 16_384,
    env: remote ? process.env : { ...process.env, BOSUN_DATA: data },
  });
};
let delivered = false;
try {
  deliver(args);
  delivered = true;
} catch (error) {
  // A stale/typoed task key should lose the association, not every event.
  if (args.includes("--task") && /unknown task|prefix .* is not/.test(String(error.stderr || ""))) {
    const at = args.indexOf("--task");
    args.splice(at, 2);
    try { deliver(args); delivered = true; } catch { /* transport failure is spooled below */ }
  }
}
if (!delivered) {
  // Preserve a bounded local retry record. A later hook flushes the spool.
  try {
    const spool = path.join(home, ".local", "state", "bosun-x", "activity-spool");
    fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spool, args[args.indexOf("--id") + 1] + ".json"), JSON.stringify(args), { mode: 0o600 });
  } catch { /* telemetry must never interrupt the agent */ }
}
if (!delivered) process.exit(0);
// Retry at most five old events; the event ID makes delivery idempotent.
try {
  const spool = path.join(home, ".local", "state", "bosun-x", "activity-spool");
  for (const name of fs.readdirSync(spool).filter((n) => n.endsWith(".json")).slice(0, 5)) {
    const file = path.join(spool, name);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(saved)) continue;
    try { deliver(saved); fs.unlinkSync(file); }
    catch { break; }
  }
} catch { /* no spool yet */ }
