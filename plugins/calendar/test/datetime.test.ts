import { describe, expect, test } from "bun:test";
import { parseWhen } from "../src/datetime";

// Fixed local reference instant for every case.
const NOW = new Date(2026, 6, 7, 12, 0, 0); // 2026-07-07 12:00 local

describe("parseWhen", () => {
  test("ISO date with time", () => {
    const r = parseWhen("2027-01-15 09:00", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pretty).toBe("2027-01-15 09:00");
  });

  test("ISO date defaults to 09:00", () => {
    const r = parseWhen("2027-01-15", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pretty).toBe("2027-01-15 09:00");
  });

  test("tomorrow with 24h and am/pm times", () => {
    const a = parseWhen("tomorrow 18:00", NOW);
    expect(a.ok && a.pretty === "2026-07-08 18:00").toBe(true);
    const b = parseWhen("tomorrow 6pm", NOW);
    expect(b.ok && b.pretty === "2026-07-08 18:00").toBe(true);
  });

  test("relative: in N days/hours/minutes and shorthand", () => {
    const d = parseWhen("in 3 days", NOW);
    expect(d.ok && d.pretty.startsWith("2026-07-10")).toBe(true);
    const h = parseWhen("in 2 hours", NOW);
    expect(h.ok && h.pretty).toBe("2026-07-07 14:00");
    const m = parseWhen("45m", NOW);
    expect(m.ok && m.pretty).toBe("2026-07-07 12:45");
  });

  test("impossible dates and garbage produce errors, not events", () => {
    expect(parseWhen("2027-02-30", NOW).ok).toBe(false);
    expect(parseWhen("next full moon", NOW).ok).toBe(false);
    expect(parseWhen("", NOW).ok).toBe(false);
  });

  test("event end is 30 minutes after start", () => {
    const r = parseWhen("2027-01-15 09:00", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Date(r.endISO).getTime() - new Date(r.startISO).getTime()).toBe(30 * 60_000);
  });
});
