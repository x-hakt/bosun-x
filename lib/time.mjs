import { timezone } from "./config.mjs";

// An ISO-8601 timestamp with a real offset, stamped in the configured timezone
// (BOSUN_TZ / config.yml / the system zone). Falls back to plain UTC ISO
// if the zone is unusable.
export function isoTimestamp(date = new Date(), tz = timezone()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
    const offset = parts.timeZoneName.replace("GMT", "").replace("UTC", "").replace(/^([+-]\d{2})$/, "$1:00") || "+00:00";
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}${offset}`;
  } catch {
    return date.toISOString();
  }
}
