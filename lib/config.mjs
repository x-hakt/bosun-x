// Where the data lives and which clock to stamp with. Resolution order:
//   1. environment  (BOSUN_DATA / BOSUN_TZ, or the legacy DATA_DIR)
//   2. bosun.config.json in the data dir  ({ "timezone": "...", "staleMinutes": 30 })
//   3. defaults  (cwd for data, the system timezone for stamps)
//
// The data dir holds one directory per project under projects/<slug>/, each with a
// project.yml plus HANDOFF.md / HANDOFF.yml / tasks.yml / STATUS.md. That's the whole
// contract — a folder of Markdown and YAML, editable by hand or by any agent.

import fs from "node:fs";
import path from "node:path";

export function dataDir() {
  const dir = process.env.BOSUN_DATA || process.env.DATA_DIR || process.cwd();
  return path.resolve(dir);
}

export function projectsDir() {
  return path.join(dataDir(), "projects");
}

let cachedConfig;
function fileConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    cachedConfig = JSON.parse(fs.readFileSync(path.join(dataDir(), "bosun.config.json"), "utf8")) || {};
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

export function timezone() {
  const tz = process.env.BOSUN_TZ || fileConfig().timezone;
  if (tz) return tz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function staleMinutes() {
  return Number(process.env.BOSUN_STALE_MINUTES || fileConfig().staleMinutes || 30);
}
