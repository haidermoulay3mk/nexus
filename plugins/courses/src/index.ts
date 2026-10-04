import { AGENT, INTENT, err, ok } from "@nexus/core";
import {
  type IntentResult,
  type NexusPlugin,
  type RunContext,
  definePlugin,
} from "@nexus/plugin-sdk";
import { z } from "zod";

/**
 * COURSES plugin — track online courses and nag when they go stale.
 *
 * A course untouched for STALE_DAYS while `active` produces ONE open
 * directive (deduped by title) plus a wire line. The daily check runs at
 * 09:00; it is silent when everything is fresh. No LLM anywhere.
 *
 * Collection: courses.items  id = slug(name)
 */

const COL = "courses.items";
export const STALE_DAYS = 7;

const CourseZ = z.object({
  name: z.string(),
  platform: z.string(),
  url: z.string().nullable(),
  status: z.enum(["active", "done", "dropped"]),
  pct: z.number().min(0).max(100),
  addedAt: z.string(),
  lastTouch: z.string(),
});
type Course = z.infer<typeof CourseZ>;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
const today = () => new Date().toISOString().slice(0, 10);

/** Days between two YYYY-MM-DD dates. Exported for tests. */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.floor(
    (new Date(`${toISO}T00:00:00Z`).getTime() - new Date(`${fromISO}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

async function loadCourses(ctx: RunContext): Promise<Array<Course & { id: string }>> {
  const rows = await ctx.records.list(COL);
  const out: Array<Course & { id: string }> = [];
  for (const row of rows) {
    const parsed = CourseZ.safeParse(row.data);
    if (parsed.success) out.push({ ...parsed.data, id: row.id });
  }
  return out;
}

/** Find by name fragment; exact-ish errors when ambiguous. */
function findCourse(
  courses: Array<Course & { id: string }>,
  frag: string,
): { course?: Course & { id: string }; error?: string } {
  const f = frag.toLowerCase();
  const hits = courses.filter((c) => c.name.toLowerCase().includes(f) || c.id.includes(slug(frag)));
  if (hits.length === 0) return { error: `no course matches "${frag}" — see \`course list\`` };
  if (hits.length > 1)
    return {
      error: `"${frag}" matches ${hits.length} courses (${hits.map((h) => h.name).join(", ")}) — be more specific`,
    };
  return { course: hits[0] };
}

const doc = (title: string, bodyMd: string, wire: string[] = []): IntentResult => ({
  document: { kind: "courses", title, bodyMd },
  speak: null,
  wire,
});

const USAGE = [
  "| COMMAND | EXAMPLE |",
  "|---|---|",
  "| Add | `course add CS50 \\| edX \\| https://cs50.io` (url optional) |",
  "| Progress | `course progress cs50 45` (also refreshes last-touch) |",
  "| Touch (worked on it) | `course touch cs50` |",
  "| Finish / drop | `course done cs50` · `course drop cs50` |",
  "| List | `course list` |",
].join("\n");

function renderList(courses: Array<Course & { id: string }>): string {
  if (courses.length === 0)
    return "No courses tracked. Add one: `course add <name> | <platform> | <url?>`";
  const t = today();
  const lines = ["| COURSE | PLATFORM | STATUS | PROGRESS | LAST TOUCH |", "|---|---|---|---|---|"];
  for (const c of courses.sort(
    (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
  )) {
    const idle = daysBetween(c.lastTouch, t);
    const staleMark = c.status === "active" && idle >= STALE_DAYS ? ` ⚠ ${idle}d` : "";
    lines.push(
      `| ${c.url ? `[${c.name}](${c.url})` : c.name} | ${c.platform} | ${c.status} | ${c.pct}% | ${c.lastTouch}${staleMark} |`,
    );
  }
  return lines.join("\n");
}

async function handleCommand(ctx: RunContext): Promise<IntentResult> {
  const line = (ctx.input ?? "").trim();
  const tokens = line.split(/\s+/).slice(1); // drop "course"
  const sub = (tokens[0] ?? "list").toLowerCase();
  const courses = await loadCourses(ctx);

  if (sub === "add") {
    const parts = line
      .replace(/^\S+\s+add\s+/i, "")
      .split("|")
      .map((s) => s.trim());
    const [name, platform, url] = [parts[0] ?? "", parts[1] ?? "self-paced", parts[2] ?? null];
    if (!name)
      return doc(
        "Course — bad command",
        `usage: \`course add <name> | <platform> | <url?>\`\n\n${USAGE}`,
      );
    const id = slug(name);
    const existing = courses.find((c) => c.id === id);
    if (existing)
      return doc(
        "Course exists",
        `**${existing.name}** is already tracked (${existing.status}, ${existing.pct}%).`,
      );
    const course: Course = {
      name,
      platform,
      url: url || null,
      status: "active",
      pct: 0,
      addedAt: today(),
      lastTouch: today(),
    };
    await ctx.records.put(COL, id, course);
    await ctx.metrics.record(
      "courses.active",
      "COURSES ACTIVE",
      courses.filter((c) => c.status === "active").length + 1,
      "",
    );
    return doc(`Course added: ${name}`, `**${name}** on ${platform} — tracked from today.`, [
      `COURSE · added ${name}`,
    ]);
  }

  if (sub === "list" || sub === "") return doc("Courses", renderList(courses));

  if (["progress", "touch", "done", "drop"].includes(sub)) {
    const frag =
      sub === "progress"
        ? tokens.slice(1, -1).join(" ") || tokens[1] || ""
        : tokens.slice(1).join(" ");
    const { course, error } = findCourse(courses, frag.trim());
    if (!course) return doc("Course — not found", error ?? "no match");

    if (sub === "progress") {
      const pct = Number(tokens[tokens.length - 1]);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        return doc(
          "Course — bad progress",
          "last token must be 0–100, e.g. `course progress cs50 45`",
        );
      course.pct = Math.round(pct);
      if (course.pct >= 100) course.status = "done";
    }
    if (sub === "done") {
      course.status = "done";
      course.pct = 100;
    }
    if (sub === "drop") course.status = "dropped";
    course.lastTouch = today();

    const { id, ...data } = course;
    await ctx.records.put(COL, id, data);
    await ctx.metrics.record(
      "courses.active",
      "COURSES ACTIVE",
      (await loadCourses(ctx)).filter((c) => c.status === "active").length,
      "",
    );
    return doc(
      `${course.name} — ${course.status}, ${course.pct}%`,
      `Updated **${course.name}**: status **${course.status}**, progress **${course.pct}%**, last touch today.`,
      [`COURSE · ${course.name} ${sub}`],
    );
  }

  return doc("Courses — commands", USAGE);
}

async function runCheck(ctx: RunContext): Promise<IntentResult> {
  const courses = await loadCourses(ctx);
  const t = today();
  const stale = courses.filter(
    (c) => c.status === "active" && daysBetween(c.lastTouch, t) >= STALE_DAYS,
  );
  await ctx.metrics.record(
    "courses.active",
    "COURSES ACTIVE",
    courses.filter((c) => c.status === "active").length,
    "",
  );

  if (stale.length === 0) {
    return {
      document: null,
      speak: null,
      wire: courses.length > 0 ? ["COURSE · daily check — all fresh"] : [],
    };
  }

  // One directive per stale course, deduped against open directives.
  const open = await ctx.directives.list(false);
  const wire: string[] = [];
  for (const c of stale) {
    const text = `COURSE: ${c.name} untouched ${daysBetween(c.lastTouch, t)}d — do a session or \`course drop\``;
    if (!open.some((d) => d.text.startsWith(`COURSE: ${c.name}`)))
      await ctx.directives.add(text, 1);
    wire.push(`COURSE · STALE ${c.name} (${daysBetween(c.lastTouch, t)}d)`);
  }
  return {
    document: {
      kind: "courses",
      title: `Stale courses — ${t}`,
      bodyMd: [
        `**${stale.length}** active course(s) look abandoned:`,
        "",
        renderList(stale),
        "",
        "Directives added — clear them by touching the course.",
      ].join("\n"),
    },
    speak: `${stale.length} course${stale.length > 1 ? "s" : ""} going stale.`,
    wire,
  };
}

export function createCoursesPlugin(): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.courses",
      name: "Courses",
      version: "0.1.0",
      description:
        "Course tracker with automatic staleness nags (7 days untouched → directive). Zero-LLM.",
      capabilities: ["records", "fs.documents", "metrics.read", "metrics.write"],
    },
    tools: [],
    scheduledJobs: [],
    commands: [
      {
        prefix: "course",
        intentKey: INTENT.COURSE_CMD,
        usage: "course add <name> | <platform> | <url?>",
        description: "Track courses (add/progress/touch/done/drop/list)",
      },
    ],
    intents: [
      {
        key: INTENT.COURSE_CHECK,
        label: "COURSE CHECK",
        agent: AGENT.SYSTEM,
        description:
          "Flag active courses untouched for 7+ days. Runs daily 09:00; silent when all fresh.",
        scheduleCron: "0 9 * * *",
        requiresIntegration: null,
        async handler(ctx) {
          try {
            return ok(await runCheck(ctx));
          } catch (e) {
            return err("COURSE_CHECK", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        key: INTENT.COURSE_CMD,
        label: "COURSE CMD",
        agent: AGENT.SYSTEM,
        description: "Typed course commands — parsed by code, no AI.",
        scheduleCron: null,
        requiresIntegration: null,
        hidden: true,
        async handler(ctx) {
          try {
            return ok(await handleCommand(ctx));
          } catch (e) {
            return err("COURSE_CMD", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ],
  });
}
