import { AGENT, INTENT, type Result, err, ok } from "@nexus/core";
import { type NexusPlugin, definePlugin } from "@nexus/plugin-sdk";
import { z } from "zod";
import { parseWhen } from "./datetime";

/**
 * CALENDAR plugin — the `calendar.today` tool used by Planner/Scribe, plus
 * the confirm-gated `remind` command that writes a real Google Calendar
 * event (so reminders reach the phone even when Nexus is closed).
 *
 * Providers (both optional + free): Google Calendar (OAuth loopback) or any
 * CalDAV server (tsdav). Reads are cached so plans still reference the
 * last-known schedule offline. Writes are Google-only (CalDAV write is not
 * implemented) and only ever happen from an explicit typed `remind`.
 */

type Ev = { start: string; summary: string };

interface CalendarHub {
  google: {
    isConnected(): Promise<boolean>;
    calendarToday(): Promise<Result<Ev[]>>;
    createEvent(
      summary: string,
      startISO: string,
      endISO: string,
      description?: string,
    ): Promise<Result<string>>;
  };
}

export function createCalendarPlugin(deps: { hub: CalendarHub }): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.calendar",
      name: "Calendar",
      version: "0.2.0",
      description:
        "Calendar context + confirm-gated reminders via Google Calendar or CalDAV (both optional, free).",
      capabilities: ["calendar", "net.fetch", "memory.read", "fs.documents"],
      secretKeys: ["caldav.url", "caldav.user", "caldav.pass"],
    },
    commands: [
      {
        prefix: "remind",
        intentKey: INTENT.CAL_REMIND,
        usage: "remind <what> | <when>",
        description: "Create a Google Calendar reminder (fires on your phone)",
      },
    ],
    intents: [
      {
        key: INTENT.CAL_REMIND,
        label: "REMIND",
        agent: AGENT.SYSTEM,
        description:
          "Create a real Google Calendar event from `remind <what> | <when>`. Date parsed by code, not AI.",
        scheduleCron: null,
        requiresIntegration: "calendar",
        hidden: true,
        async handler(ctx) {
          const rest = (ctx.input ?? "").replace(/^\S+\s+/i, ""); // drop "remind"
          const [what, whenRaw] = rest.split("|").map((s) => s.trim());
          if (!what || !whenRaw) {
            return ok({
              document: {
                kind: "reminder",
                title: "Reminder — usage",
                bodyMd:
                  "usage: `remind <what> | <when>`\n\nExamples:\n- `remind Submit UCL application | 2027-01-15 09:00`\n- `remind Physics past paper | tomorrow 18:00`\n- `remind Call the exam board | in 3 days`",
              },
              speak: null,
              wire: [],
            });
          }
          const when = parseWhen(whenRaw);
          if (!when.ok) {
            return ok({
              document: { kind: "reminder", title: "Reminder — bad time", bodyMd: when.error },
              speak: null,
              wire: [],
            });
          }
          if (!(await deps.hub.google.isConnected())) {
            return ok({
              document: {
                kind: "reminder",
                title: "Reminder — connect Google Calendar",
                bodyMd: `Reminders write to **Google Calendar** (so they notify your phone). Connect it in Settings → Integrations.\n\nParsed OK: **${what}** at **${when.pretty}** — re-run once connected.`,
              },
              speak: null,
              wire: [],
            });
          }
          ctx.step("create", `${what} @ ${when.pretty}`);
          const res = await deps.hub.google.createEvent(
            what,
            when.startISO,
            when.endISO,
            "Created by Nexus",
          );
          if (!res.ok) {
            return ok({
              document: {
                kind: "reminder",
                title: "Reminder — failed",
                bodyMd: `Could not create the event: ${res.error.message}`,
              },
              speak: null,
              wire: ["CAL · reminder failed"],
            });
          }
          return ok({
            document: {
              kind: "reminder",
              title: `Reminder set — ${when.pretty}`,
              bodyMd: `**${what}**\n\nAdded to Google Calendar for **${when.pretty}** (local). Your phone will notify you.`,
            },
            speak: `Reminder set for ${when.pretty}.`,
            wire: [`CAL · remind "${what.slice(0, 40)}" @ ${when.pretty}`],
          });
        },
      },
    ],
    scheduledJobs: [],
    tools: [
      {
        name: "calendar.today",
        description: "Today's (and tomorrow's) calendar events, when a calendar is connected.",
        capability: "calendar",
        inputSchema: z.object({}),
        async execute(_input, ctx) {
          // 1) Google
          if (await deps.hub.google.isConnected()) {
            const events = await deps.hub.google.calendarToday();
            if (events.ok) {
              await cacheEvents(ctx, events.value);
              return ok(formatEvents(events.value, false));
            }
            const cached = await readCache(ctx);
            if (cached) return ok(formatEvents(cached, true));
            return err("CAL_OFFLINE", "calendar unreachable and no cache yet");
          }
          // 2) CalDAV
          const url = await ctx.secrets.get("caldav.url");
          if (url) {
            const events = await caldavToday(ctx, url);
            if (events.ok) {
              await cacheEvents(ctx, events.value);
              return ok(formatEvents(events.value, false));
            }
            const cached = await readCache(ctx);
            if (cached) return ok(formatEvents(cached, true));
            return err("CAL_OFFLINE", events.error.message);
          }
          return ok(
            "No calendar connected. (Optional — connect Google Calendar or CalDAV in Settings.)",
          );
        },
      },
    ],
  });

  function formatEvents(events: Ev[], fromCache: boolean): string {
    if (events.length === 0) return "No events scheduled.";
    return (
      events.map((e) => `- ${e.start.slice(0, 16).replace("T", " ")} · ${e.summary}`).join("\n") +
      (fromCache ? "\n(last-known schedule — offline)" : "")
    );
  }

  async function cacheEvents(
    ctx: { net: { fetchCached: unknown } } & {
      secrets: { set(k: string, v: string): Promise<void> };
    },
    events: Ev[],
  ): Promise<void> {
    await ctx.secrets.set("cache.calendar.today", JSON.stringify(events));
  }

  async function readCache(ctx: { secrets: { get(k: string): Promise<string | null> } }): Promise<
    Ev[] | null
  > {
    const raw = await ctx.secrets.get("cache.calendar.today");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Ev[];
    } catch {
      return null;
    }
  }

  async function caldavToday(
    ctx: { secrets: { get(k: string): Promise<string | null> } },
    serverUrl: string,
  ): Promise<Result<Ev[]>> {
    try {
      const { createDAVClient } = await import("tsdav");
      const client = await createDAVClient({
        serverUrl,
        credentials: {
          username: (await ctx.secrets.get("caldav.user")) ?? "",
          password: (await ctx.secrets.get("caldav.pass")) ?? "",
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      const calendars = await client.fetchCalendars();
      const first = calendars[0];
      if (!first) return ok([]);
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 2);
      const objects = await client.fetchCalendarObjects({
        calendar: first,
        timeRange: { start: start.toISOString(), end: end.toISOString() },
      });
      const events: Ev[] = [];
      for (const obj of objects) {
        const data = obj.data ?? "";
        const summary = data.match(/SUMMARY:(.*)/)?.[1]?.trim() ?? "(untitled)";
        const dtstart = data.match(/DTSTART[^:]*:(\S+)/)?.[1] ?? "";
        events.push({ start: dtstart, summary });
      }
      return ok(events);
    } catch (e) {
      return err("CALDAV_FAIL", e instanceof Error ? e.message : String(e), e);
    }
  }
}
