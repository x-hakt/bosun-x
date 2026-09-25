#!/usr/bin/env node
/*
  bosun-x test suite — no framework, `node test/run.mjs`.

  Covers the three things people rely on once this is published:
    1. the library units  — board rendering, surgical tasks.yml edits, timestamps, config
    2. the CLI loop        — start / checkpoint / finish / status / resume / doctor,
                             ownership guards, --task board coupling, drift reconcile, init
    3. the MCP server      — a real stdio JSON-RPC handshake + tools/list + a tool call

  Each CLI/MCP case runs against a throwaway BOSUN_DATA dir under the OS temp dir.
*/
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));

// ---------------------------------------------------------------- test harness

const filter = process.argv.slice(2);
const tempDirs = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  if (filter.length && !filter.some((f) => name.includes(f))) return;
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(
      String(err && err.stack ? err.stack : err)
        .split("\n")
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
}

// ---------------------------------------------------------------- fixtures

const TASKS_FIXTURE = `seq: 3
tasks:
  - id: demo-1
    num: 1
    title: Wire the widget
    status: todo
    depends_on: []
    created: '2026-01-01T00:00:00.000+00:00'
    updated: '2026-01-01T00:00:00.000+00:00'
  - id: demo-2
    num: 2
    title: Paint the shed
    status: backlog
    depends_on: []
    created: '2026-01-01T00:00:00.000+00:00'
    updated: '2026-01-01T00:00:00.000+00:00'
  - id: demo-3
    num: 3
    title: Ship the thing
    status: done
    depends_on: []
    created: '2026-01-01T00:00:00.000+00:00'
    updated: '2026-01-01T00:00:00.000+00:00'
`;

async function makeDataDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bosun-test-"));
  tempDirs.push(dir);
  const proj = path.join(dir, "projects", "demo");
  await mkdir(proj, { recursive: true });
  await writeFile(
    path.join(proj, "project.yml"),
    "name: Demo\nslug: demo\nkey: DEMO\nstage: active\nstatus: Development\n",
  );
  await writeFile(path.join(proj, "tasks.yml"), TASKS_FIXTURE);
  return { dir, proj };
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

// Run the CLI. Resolves { code, stdout, stderr } for any exit code so a test can
// assert on failures too.
async function bosun(args, data) {
  const env = { ...process.env, BOSUN_DATA: data, BOSUN_TZ: "UTC" };
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { env, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (typeof err.code !== "number") throw err; // spawn failure, not an exit code
    return { code: err.code, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// ---------------------------------------------------------------- library units

await test("board: deriveTaskPrefix", async () => {
  const { deriveTaskPrefix } = await import("../lib/board.mjs");
  assert.equal(deriveTaskPrefix("bosun-x-dashboard"), "BXD");
  assert.equal(deriveTaskPrefix("x-hakt"), "XH");
  assert.equal(deriveTaskPrefix("jellyfin"), "JEL");
  assert.equal(deriveTaskPrefix("byte-basics-web"), "BBW");
  assert.equal(deriveTaskPrefix(""), "T");
});

await test("board: renderBoardBody sections and ordering", async () => {
  const { renderBoardBody } = await import("../lib/board.mjs");
  const tasks = [
    { num: 5, title: "E", status: "todo" },
    { num: 1, title: "A", status: "todo" },
    { num: 2, title: "B", status: "in_progress" },
    { num: 3, title: "C", status: "backlog" },
    { num: 4, title: "D", status: "done" },
    { num: 7, title: "G", status: "done" },
  ];
  const body = renderBoardBody(tasks, "DEMO", "STAMP");
  assert.match(body, /_Generated from tasks\.yml · STAMP_/);
  assert.match(body, /\*\*In progress\*\*\n- DEMO-2 — B/);
  // queue reads oldest-first
  assert.ok(body.indexOf("DEMO-1 — A") < body.indexOf("DEMO-5 — E"), "up-next sorted ascending");
  assert.match(body, /\*\*Backlog\*\* \(1\) — DEMO-3/);
  // shipped reads newest-first
  assert.match(body, /\*\*Shipped\*\* \(2\) — DEMO-7, DEMO-4/);
});

await test("board: renderBoardBody empty in-progress + shipped cap", async () => {
  const { renderBoardBody } = await import("../lib/board.mjs");
  const done = Array.from({ length: 15 }, (_, i) => ({ num: i + 1, title: `T${i + 1}`, status: "done" }));
  const body = renderBoardBody(done, "DEMO", "x");
  assert.match(body, /\*\*In progress\*\*\n- _nothing in progress_/);
  assert.match(body, /\*\*Shipped\*\* \(15\) —/);
  assert.match(body, /… \+3 earlier/);
});

await test("board: taskDisplayKey — dotted keys for sub-tasks (BXD-46)", async () => {
  const { taskDisplayKey } = await import("../lib/board.mjs");
  const tasks = [
    { id: "r", num: 2, title: "root", status: "todo", created: "2026-01-01" },
    { id: "a", num: 3, title: "first child", status: "todo", parent_id: "r", created: "2026-01-02" },
    { id: "b", num: 9, title: "second child", status: "todo", parent_id: "r", created: "2026-01-05" },
    { id: "c", num: 4, title: "same-day child", status: "todo", parent_id: "r", created: "2026-01-05" },
    { id: "d", num: 12, title: "grandchild", status: "todo", parent_id: "b", created: "2026-02-01" },
    { id: "e", num: 1, title: "plain", status: "todo", created: "2026-01-01" },
    { id: "o", num: 7, title: "orphan", status: "todo", parent_id: "gone", created: "2026-01-01" },
  ];
  const key = (id) => taskDisplayKey(tasks.find((t) => t.id === id), tasks, "DEMO");
  assert.equal(key("r"), "DEMO-2");
  assert.equal(key("a"), "DEMO-2.1");
  assert.equal(key("c"), "DEMO-2.2", "same created — num breaks the tie (4 before 9)");
  assert.equal(key("b"), "DEMO-2.3");
  assert.equal(key("d"), "DEMO-2.3.1", "arbitrary nesting depth");
  assert.equal(key("e"), "DEMO-1", "no parent — plain key");
  assert.equal(key("o"), "DEMO-7", "orphaned parent chain falls back to the flat key");
});

await test("board: resolveTaskRef — dotted, keyed, and bare refs (BXD-46)", async () => {
  const { resolveTaskRef } = await import("../lib/board.mjs");
  const tasks = [
    { id: "r", num: 2, parent_id: null, created: "2026-01-01" },
    { id: "a", num: 3, parent_id: "r", created: "2026-01-02" },
    { id: "b", num: 9, parent_id: "r", created: "2026-01-05" },
  ];
  assert.equal(resolveTaskRef("DEMO-2.1", tasks, "DEMO")?.id, "a");
  assert.equal(resolveTaskRef("2.2", tasks, "DEMO")?.id, "b");
  assert.equal(resolveTaskRef("DEMO-3", tasks, "DEMO")?.id, "a", "the bare num still resolves a dotted-displayed task");
  assert.equal(resolveTaskRef("9", tasks, "DEMO")?.id, "b");
  assert.equal(resolveTaskRef("DEMO-2.5", tasks, "DEMO"), undefined, "ordinal out of range");
  assert.throws(() => resolveTaskRef("XYZ-2.1", tasks, "DEMO"), /prefix/);
});

await test("board: renderBoardBody renders sub-tasks dotted (BXD-46)", async () => {
  const { renderBoardBody } = await import("../lib/board.mjs");
  const tasks = [
    { id: "r", num: 2, title: "parent", status: "todo", created: "2026-01-01" },
    { id: "a", num: 3, title: "child", status: "todo", parent_id: "r", created: "2026-01-02" },
    { id: "z", num: 5, title: "plain backlog", status: "backlog", created: "2026-01-03" },
  ];
  const body = renderBoardBody(tasks, "DEMO", "x");
  assert.match(body, /- DEMO-2 — parent/);
  assert.match(body, /- DEMO-2\.1 — child/);
  assert.match(body, /\*\*Backlog\*\* \(1\) — DEMO-5/);
});

await test("board: replaceTaskField is surgical", async () => {
  const { replaceTaskField } = await import("../lib/board.mjs");
  const next = replaceTaskField(TASKS_FIXTURE, "demo-2", "status", "in_progress");
  assert.match(next, /num: 2\n {4}title: Paint the shed\n {4}status: in_progress/);
  assert.match(next, /num: 1\n {4}title: Wire the widget\n {4}status: todo/, "other tasks untouched");
  assert.throws(() => replaceTaskField(TASKS_FIXTURE, "demo-1", "nope", "x"), /could not locate/);
});

await test("board: syncStatusBoard / boardIsCurrent round-trip", async () => {
  const { syncStatusBoard, boardIsCurrent } = await import("../lib/board.mjs");
  const { dir, proj } = await makeDataDir();
  assert.equal(await boardIsCurrent(proj, "demo"), false, "no STATUS.md yet");
  const first = await syncStatusBoard(proj, "demo", "stamp-1");
  assert.equal(first.changed, true);
  assert.equal(await boardIsCurrent(proj, "demo"), true);
  const md = await readFile(path.join(proj, "STATUS.md"), "utf8");
  assert.match(md, /<!-- bosun:task-board:start -->/);
  assert.match(md, /DEMO-1 — Wire the widget/);
  // only the stamp moved -> no rewrite
  const again = await syncStatusBoard(proj, "demo", "stamp-2");
  assert.equal(again.changed, false, "unchanged board content should not rewrite");
  void dir;
});

await test("time: isoTimestamp shape, UTC zone, bad-zone fallback", async () => {
  const { isoTimestamp } = await import("../lib/time.mjs");
  assert.match(isoTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  const at = new Date("2026-01-02T03:04:05.678Z");
  assert.equal(isoTimestamp(at, "UTC"), "2026-01-02T03:04:05.678+00:00");
  assert.equal(isoTimestamp(at, "Not/AZone"), at.toISOString());
});

await test("config: reads config.yml from the data dir", async () => {
  const { dir } = await makeDataDir();
  await writeFile(path.join(dir, "config.yml"), "timezone: Asia/Tokyo\nstale_minutes: 45\n");
  const saved = { tz: process.env.BOSUN_TZ, data: process.env.BOSUN_DATA, stale: process.env.BOSUN_STALE_MINUTES };
  delete process.env.BOSUN_TZ;
  delete process.env.BOSUN_STALE_MINUTES;
  process.env.BOSUN_DATA = dir;
  try {
    const cfg = await import(`../lib/config.mjs?case=${Date.now()}`);
    assert.equal(cfg.dataDir(), dir);
    assert.equal(cfg.timezone(), "Asia/Tokyo");
    assert.equal(cfg.staleMinutes(), 45);
  } finally {
    if (saved.tz === undefined) delete process.env.BOSUN_TZ;
    else process.env.BOSUN_TZ = saved.tz;
    if (saved.stale === undefined) delete process.env.BOSUN_STALE_MINUTES;
    else process.env.BOSUN_STALE_MINUTES = saved.stale;
    if (saved.data === undefined) delete process.env.BOSUN_DATA;
    else process.env.BOSUN_DATA = saved.data;
  }
});

// ---------------------------------------------------------------- CLI loop

await test("cli: start → checkpoint → finish, with --task board coupling", async () => {
  const { dir, proj } = await makeDataDir();

  const start = await bosun(
    ["start", "demo", "--agent", "Tester", "--summary", "begin the widget", "--task", "DEMO-1"],
    dir,
  );
  assert.equal(start.code, 0, start.stderr);
  assert.ok(await exists(path.join(proj, "HANDOFF.md")));
  assert.ok(await exists(path.join(proj, "HANDOFF.yml")));

  let tasks = await readFile(path.join(proj, "tasks.yml"), "utf8");
  assert.match(tasks, /num: 1\n {4}title: Wire the widget\n {4}status: in_progress/, "DEMO-1 moved to in_progress");
  let status = await readFile(path.join(proj, "STATUS.md"), "utf8");
  assert.match(status, /\*\*In progress\*\*\n- DEMO-1/);

  // a second start while active + fresh is refused
  const dup = await bosun(["start", "demo", "--agent", "Other", "--summary", "nope"], dir);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already has active work/);

  // checkpoint by the wrong agent is refused
  const wrong = await bosun(
    ["checkpoint", "demo", "--agent", "Nope", "--done", "d", "--state", "s", "--next", "n"],
    dir,
  );
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /owned by Tester/);

  const cp = await bosun(
    ["checkpoint", "demo", "--agent", "Tester", "--done", "widget wired", "--state", "green", "--next", "paint"],
    dir,
  );
  assert.equal(cp.code, 0, cp.stderr);

  const st = await bosun(["status", "demo"], dir);
  assert.match(st.stdout, /demo: active · Tester/);

  const resume = await bosun(["resume", "demo"], dir);
  assert.match(resume.stdout, /status: active/);
  assert.match(resume.stdout, /next_step: paint/);
  assert.match(resume.stdout, /tasks: DEMO-1/);

  const fin = await bosun(
    ["finish", "demo", "--agent", "Tester", "--done", "done", "--state", "shipped", "--next", "none", "--task", "DEMO-1"],
    dir,
  );
  assert.equal(fin.code, 0, fin.stderr);
  tasks = await readFile(path.join(proj, "tasks.yml"), "utf8");
  assert.match(tasks, /num: 1\n {4}title: Wire the widget\n {4}status: done/, "DEMO-1 moved to done");
  const yml = await readFile(path.join(proj, "HANDOFF.yml"), "utf8");
  assert.match(yml, /active: false/);

  // a clean project passes doctor
  const doc = await bosun(["doctor"], dir);
  assert.equal(doc.code, 0, doc.stdout + doc.stderr);
  assert.match(doc.stdout, /no task\/handoff drift/);
  void status;
});

await test("cli: doctor --fix reconciles an orphaned in_progress task", async () => {
  const { dir, proj } = await makeDataDir();
  // a completed handoff exists...
  await bosun(["start", "demo", "--agent", "T", "--summary", "s"], dir);
  await bosun(["finish", "demo", "--agent", "T", "--done", "d", "--state", "s", "--next", "n"], dir);
  // ...but a task got left in_progress with nothing working it
  const stuck = (await readFile(path.join(proj, "tasks.yml"), "utf8")).replace(
    /(num: 1\n {4}title: Wire the widget\n {4}status: )todo/,
    "$1in_progress",
  );
  await writeFile(path.join(proj, "tasks.yml"), stuck);

  const report = await bosun(["doctor"], dir);
  assert.equal(report.code, 1);
  assert.match(report.stdout, /DEMO-1 is in_progress but no handoff is working it/);

  const fix = await bosun(["doctor", "--fix"], dir);
  assert.equal(fix.code, 0, fix.stderr);
  assert.match(fix.stdout, /→ set todo/);
  assert.match(fix.stdout, /1 correction applied/);
  const tasks = await readFile(path.join(proj, "tasks.yml"), "utf8");
  assert.match(tasks, /num: 1\n {4}title: Wire the widget\n {4}status: todo/);
});

await test("cli: --task accepts a dotted sub-task ref; doctor flags an orphan parent (BXD-46)", async () => {
  const { dir, proj } = await makeDataDir();
  const nested = `seq: 4
tasks:
  - id: p
    num: 2
    title: Parent task
    status: todo
    depends_on: []
    created: '2026-01-01T00:00:00.000+00:00'
    updated: '2026-01-01T00:00:00.000+00:00'
  - id: c1
    num: 3
    title: First child
    status: backlog
    parent_id: p
    depends_on: []
    created: '2026-01-02T00:00:00.000+00:00'
    updated: '2026-01-02T00:00:00.000+00:00'
  - id: c2
    num: 4
    title: Second child
    status: backlog
    parent_id: p
    depends_on: []
    created: '2026-01-03T00:00:00.000+00:00'
    updated: '2026-01-03T00:00:00.000+00:00'
`;
  await writeFile(path.join(proj, "tasks.yml"), nested);

  const start = await bosun(["start", "demo", "--agent", "T", "--summary", "s", "--task", "DEMO-2.2"], dir);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /DEMO-2\.2: backlog → in_progress/);
  const tasks = await readFile(path.join(proj, "tasks.yml"), "utf8");
  assert.match(tasks, /num: 4\n {4}title: Second child\n {4}status: in_progress/, "the dotted ref hit c2, not c1");
  const status = await readFile(path.join(proj, "STATUS.md"), "utf8");
  assert.match(status, /- DEMO-2\.2 — Second child/, "board renders it dotted");

  // now orphan a child and confirm doctor reports it
  await writeFile(path.join(proj, "tasks.yml"), nested.replace("parent_id: p\n    depends_on: []\n    created: '2026-01-02", "parent_id: nope\n    depends_on: []\n    created: '2026-01-02"));
  const doc = await bosun(["doctor"], dir);
  assert.equal(doc.code, 1);
  assert.match(doc.stdout, /DEMO-3 has parent_id nope, which is not a task in this file/);
});

await test("cli: init adds and then idempotently keeps the agent block", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "bosun-repo-"));
  tempDirs.push(repo);
  await writeFile(path.join(repo, "AGENTS.md"), "# My project\n\nSome house rules.\n");

  const first = await bosun(["init", repo], repo);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /updated AGENTS\.md/);
  const md = await readFile(path.join(repo, "AGENTS.md"), "utf8");
  assert.match(md, /<!-- bosun-x:start -->/);
  assert.match(md, /<!-- bosun-x:end -->/);
  assert.match(md, /Some house rules\./, "existing content preserved");

  const second = await bosun(["init", repo], repo);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /already up to date/);
});

await test("cli: dashboard passes every argument through to the dashboard launcher", async () => {
  const { dir } = await makeDataDir();
  const fake = path.join(dir, "fake-dashboard.mjs");
  await writeFile(
    fake,
    'console.log(JSON.stringify({ argv: process.argv.slice(2), data: process.env.BOSUN_DATA })); process.exit(3);\n',
  );
  process.env.BOSUN_DASHBOARD_BIN = fake;
  try {
    const run = await bosun(["dashboard", "--demo", "--port", "4001", "--open"], dir);
    assert.equal(run.code, 3, "exit code propagates");
    const seen = JSON.parse(run.stdout.trim());
    assert.deepEqual(seen.argv, ["--demo", "--port", "4001", "--open"], "flags reach it untouched (no CLI parsing)");
    assert.equal(seen.data, dir, "same data dir as the CLI");
  } finally {
    delete process.env.BOSUN_DASHBOARD_BIN;
  }
});

// ---------------------------------------------------------------- MCP server

await test("activity: validates safe fields, appends, and deduplicates", async () => {
  const { dir } = await makeDataDir();
  const event = ["event", "--provider", "codex", "--session", "session-1", "--kind", "turn_start", "--id", "event-1", "--project", "demo"];
  const first = await bosun(event, dir);
  assert.equal(first.code, 0, first.stderr);
  const repeat = await bosun(event, dir);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.match(repeat.stdout, /duplicate/);
  const day = new Date().toISOString().slice(0, 10);
  const raw = await readFile(path.join(dir, ".activity", `${day}.jsonl`), "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  assert.equal(JSON.parse(raw).project, "demo");
  const unsafe = await bosun([...event, "--prompt", "secret"], dir);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /unsafe event field/);
});

await test("mcp: stdio handshake, tools/list, tools/call", async () => {
  const { dir } = await makeDataDir();
  const server = spawn("node", [MCP], {
    env: { ...process.env, BOSUN_DATA: dir, BOSUN_TZ: "UTC" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (c) => {
    stderr += c;
  });

  let buf = "";
  const pending = new Map();
  server.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const send = (obj) => server.stdin.write(JSON.stringify(obj) + "\n");
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out. stderr:\n${stderr}`)), 10_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  try {
    const init = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bosun-test", version: "0" },
    });
    assert.equal(init.result?.serverInfo?.name, "bosun-x");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await request(2, "tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name);
    for (const expected of [
      "handoff_resume",
      "handoff_start",
      "handoff_checkpoint",
      "handoff_finish",
      "handoff_doctor",
      "list_projects",
      "project_brief",
      "list_tasks",
      "set_task_status",
      "create_task",
    ]) {
      assert.ok(names.includes(expected), `tools/list missing ${expected} (got ${names.join(", ")})`);
    }

    const call = await request(3, "tools/call", { name: "list_projects", arguments: {} });
    const payload = call.result?.content?.[0]?.text ?? "";
    assert.match(payload, /"slug": "demo"/);
    assert.match(payload, /"name": "Demo"/);
  } finally {
    server.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------- summary

for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
