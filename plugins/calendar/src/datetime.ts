/**
 * Deterministic natural-ish datetime parser for the `remind` command.
 * Pure and unit-tested — NO model is ever asked to interpret a date, so
 * reminders land at the exact instant on any (or no) model.
 *
 * Wall-clock inputs are interpreted in the machine's LOCAL time and emitted
 * as absolute UTC ISO strings, so Google places the event at the right
 * instant regardless of how the calendar displays it.
 */

export type WhenResult =
  | { ok: true; startISO: string; endISO: string; pretty: string }
  | { ok: false; error: string };

const pad = (n: number) => String(n).padStart(2, "0");

function build(d: Date, durationMin: number): WhenResult {
  if (Number.isNaN(d.getTime())) return { ok: false, error: "could not read that date/time" };
  const end = new Date(d.getTime() + durationMin * 60_000);
  const pretty = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { ok: true, startISO: d.toISOString(), endISO: end.toISOString(), pretty };
}

/** Parse a "when" phrase relative to `now` (defaults to real now). */
export function parseWhen(raw: string, now: Date = new Date()): WhenResult {
  const s = raw.trim().toLowerCase();
  if (!s)
    return {
      ok: false,
      error: "when is required, e.g. `2027-01-15 09:00`, `tomorrow 18:00`, `in 3 days`",
    };

  const time = (str: string): { h: number; m: number } | null => {
    const m24 = str.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m24) return { h: Number(m24[1]), m: Number(m24[2]) };
    const mAmPm = str.match(/\b(\d{1,2})\s*(am|pm)\b/);
    if (mAmPm) {
      let h = Number(mAmPm[1]) % 12;
      if (mAmPm[2] === "pm") h += 12;
      return { h, m: 0 };
    }
    return null;
  };

  // in N days / hours / minutes
  const rel = s.match(/^in\s+(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] ?? "m";
    const ms = unit.startsWith("d")
      ? n * 86_400_000
      : unit.startsWith("h")
        ? n * 3_600_000
        : n * 60_000;
    return build(new Date(now.getTime() + ms), 30);
  }
  // shorthand: 3d, 2h, 45m
  const short = s.match(/^(\d+)\s*(d|h|m)$/);
  if (short) {
    const n = Number(short[1]);
    const ms = short[2] === "d" ? n * 86_400_000 : short[2] === "h" ? n * 3_600_000 : n * 60_000;
    return build(new Date(now.getTime() + ms), 30);
  }

  // today / tomorrow [time]
  if (/^today\b/.test(s) || /^tomorrow\b/.test(s) || /^tmrw\b/.test(s)) {
    const d = new Date(now);
    if (!/^today\b/.test(s)) d.setDate(d.getDate() + 1);
    const t = time(s) ?? { h: 9, m: 0 };
    d.setHours(t.h, t.m, 0, 0);
    return build(d, 30);
  }

  // ISO date with optional time: YYYY-MM-DD [HH:MM]
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [y, mo, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const t = time(s) ?? { h: 9, m: 0 };
    const d = new Date(y, mo - 1, day, t.h, t.m, 0, 0);
    if (d.getMonth() !== mo - 1 || d.getDate() !== day)
      return { ok: false, error: `"${raw.trim()}" is not a real calendar date` };
    return build(d, 30);
  }

  return {
    ok: false,
    error: `couldn't parse "${raw.trim()}" — try \`2027-01-15 09:00\`, \`tomorrow 18:00\`, or \`in 3 days\``,
  };
}
