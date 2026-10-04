import { AGENT, INTENT, err, ok } from "@nexus/core";
import {
  type IntentResult,
  type NexusPlugin,
  type RunContext,
  definePlugin,
} from "@nexus/plugin-sdk";
import { z } from "zod";
import {
  type AcademicsConfig,
  type ChapterState,
  DEFAULT_CONFIG,
  type PaperState,
  type SubjectSnapshot,
  applyPaperNudge,
  countdownText,
  currentPhase,
  daysUntil,
  effectiveStrength,
  parsePaperCommand,
  parsePaperToken,
  parseSession,
  renderBoard,
  renderPapersList,
  renderRevise,
  stars,
} from "./engine";
import { SUBJECTS, chapterById, resolveSubject } from "./syllabus";

/**
 * ACADEMICS plugin — CAIE A Level tracking (9702 / 9709 / 9618).
 *
 * DESIGN LAW: every write goes through a typed command parsed by plain
 * TypeScript and validated with Zod. No LLM is involved anywhere in this
 * plugin — it works identically with Ollama running, broken, or absent.
 *
 * Collections:
 *   acad.papers    id `${subject}-${session}-${paper}`  → PaperState
 *   acad.chapters  id `${subject}:${chapter}`           → ChapterState
 *   acad.config    id `config`                          → AcademicsConfig
 */

const COL_PAPERS = "acad.papers";
const COL_CHAPTERS = "acad.chapters";
const COL_CONFIG = "acad.config";

const ChapterStateZ = z.object({
  subject: z.string(),
  chapter: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  rating: z.number().min(1).max(5).nullable(),
  adj: z.number(),
});

const PaperStateZ = z.object({
  subject: z.string(),
  session: z.string(),
  paper: z.string(),
  paperNo: z.number().int(),
  variant: z.number().int().nullable(),
  attempts: z.array(
    z.object({
      date: z.string(),
      score: z.number(),
      max: z.number(),
      pct: z.number(),
      timeMin: z.number().nullable(),
    }),
  ),
  weak: z.array(z.string()),
});

const ConfigZ = z.object({ asExam: z.string(), alExam: z.string() });

const today = () => new Date().toISOString().slice(0, 10);

async function loadConfig(ctx: RunContext): Promise<AcademicsConfig> {
  const row = await ctx.records.get(COL_CONFIG, "config");
  const parsed = ConfigZ.safeParse(row?.data);
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

async function loadChapters(
  ctx: RunContext,
  subjectCode: string,
): Promise<Map<string, ChapterState>> {
  const rows = await ctx.records.list(COL_CHAPTERS);
  const map = new Map<string, ChapterState>();
  for (const row of rows) {
    const parsed = ChapterStateZ.safeParse(row.data);
    if (parsed.success && parsed.data.subject === subjectCode)
      map.set(parsed.data.chapter, parsed.data);
  }
  return map;
}

async function loadPapers(ctx: RunContext, subjectCode?: string): Promise<PaperState[]> {
  const rows = await ctx.records.list(COL_PAPERS);
  const out: PaperState[] = [];
  for (const row of rows) {
    const parsed = PaperStateZ.safeParse(row.data);
    if (parsed.success && (!subjectCode || parsed.data.subject === subjectCode))
      out.push(parsed.data);
  }
  return out;
}

async function loadSnapshots(ctx: RunContext): Promise<SubjectSnapshot[]> {
  const snapshots: SubjectSnapshot[] = [];
  for (const subject of SUBJECTS) {
    snapshots.push({
      subject,
      chapters: await loadChapters(ctx, subject.code),
      papers: await loadPapers(ctx, subject.code),
    });
  }
  return snapshots;
}

async function refreshMetrics(ctx: RunContext): Promise<void> {
  const papers = await loadPapers(ctx);
  const attempts = papers.flatMap((p) => p.attempts);
  const avg =
    attempts.length > 0 ? Math.round(attempts.reduce((a, b) => a + b.pct, 0) / attempts.length) : 0;
  const config = await loadConfig(ctx);
  await ctx.metrics.record("acad.papers", "PAPERS LOGGED", attempts.length, "");
  await ctx.metrics.record("acad.avg", "PAPER AVG", avg, "%");
  if (config.asExam) {
    await ctx.metrics.record(
      "acad.days",
      "DAYS TO AS",
      Math.max(0, daysUntil(config.asExam, today())),
      "d",
    );
  }
}

const doc = (
  title: string,
  bodyMd: string,
  wire: string[] = [],
  speak: string | null = null,
): IntentResult => ({
  document: { kind: "academics", title, bodyMd },
  speak,
  wire,
});

const USAGE = [
  "## ACADEMICS COMMANDS",
  "",
  "| COMMAND | EXAMPLE |",
  "|---|---|",
  "| Log a paper | `paper 9702 s23 22 48/60` (optionally ` t:95 weak:2,9`) |",
  "| Remove a paper | `paper rm 9702 s23 22` |",
  "| List papers | `papers` or `papers 9702` |",
  "| Chapter status | `chapter 9702 2 done` (or `doing` / `todo`) |",
  "| Rate a chapter 1–5 | `chapter 9702 2 rate 4` |",
  "| List chapters | `chapter 9702` |",
  "| Exam dates | `exam` · `exam as 2027-05-14` · `exam al 2028-05-12` |",
  "",
  "Subjects: `9702`/`phy`, `9709`/`maths`, `9618`/`cs`. Sessions: `s23` `w22` `m24`.",
].join("\n");

async function handleCommand(ctx: RunContext): Promise<IntentResult> {
  const line = (ctx.input ?? "").trim();
  const [prefix, ...rest] = line.split(/\s+/);
  const sub = (prefix ?? "").toLowerCase();

  /* ---- paper … ---- */
  if (sub === "paper") {
    if ((rest[0] ?? "").toLowerCase() === "rm") {
      const subject = resolveSubject(rest[1] ?? "");
      const session = parseSession(rest[2] ?? "");
      if (!subject || !session) return doc("Paper — bad command", "usage: `paper rm 9702 s23 22`");
      const tok = parsePaperToken(rest[3] ?? "", subject);
      if (!tok.ok) return doc("Paper — bad command", tok.error);
      const id = `${subject.code}-${session}-${tok.value.token}`;
      const removed = await ctx.records.remove(COL_PAPERS, id);
      await refreshMetrics(ctx);
      return doc(
        removed ? `Removed ${id}` : "Nothing to remove",
        removed
          ? `Deleted paper record \`${id}\`.`
          : `No logged paper \`${id}\`. See \`papers ${subject.code}\`.`,
        removed ? [`ACAD · removed ${id}`] : [],
      );
    }

    const parsed = parsePaperCommand(line);
    if (!parsed.ok) return doc("Paper — bad command", `${parsed.error}\n\n${USAGE}`);
    const p = parsed.value;
    const id = `${p.subject.code}-${p.session}-${p.paper}`;
    const pct = Math.round((p.score / p.max) * 1000) / 10;

    const existing = await ctx.records.get(COL_PAPERS, id);
    const prev = existing ? PaperStateZ.safeParse(existing.data) : null;
    const state: PaperState =
      prev?.success === true
        ? prev.data
        : {
            subject: p.subject.code,
            session: p.session,
            paper: p.paper,
            paperNo: p.paperNo,
            variant: p.variant,
            attempts: [],
            weak: [],
          };
    state.attempts.push({ date: today(), score: p.score, max: p.max, pct, timeMin: p.timeMin });
    state.weak = [...new Set([...state.weak, ...p.weak])];
    await ctx.records.put(COL_PAPERS, id, state);

    // Mechanical strength nudge — documented in engine.ts.
    const chapters = await loadChapters(ctx, p.subject.code);
    const touched = applyPaperNudge(p.subject, p.paperNo, p.score / p.max, p.weak, chapters);
    for (const chId of touched) {
      const st = chapters.get(chId);
      if (st) await ctx.records.put(COL_CHAPTERS, `${p.subject.code}:${chId}`, st);
    }
    await refreshMetrics(ctx);

    const attemptNote = state.attempts.length > 1 ? ` (attempt ${state.attempts.length})` : "";
    const weakNote =
      p.weak.length > 0
        ? `\n\nWeak chapters noted: **${p.weak.join(", ")}** (strength −0.3 each).`
        : "";
    return doc(
      `${p.subject.name} ${p.session} P${p.paper} — ${pct}%`,
      `Logged **${p.score}/${p.max} (${pct}%)**${attemptNote}${p.timeMin ? ` in ${p.timeMin} min` : ""}.${weakNote}\n\n${touched.length} chapter strengths updated.`,
      [`ACAD · ${p.subject.code} ${p.session} p${p.paper} → ${pct}%`],
      `Paper logged. ${pct} percent.`,
    );
  }

  /* ---- papers [subject] ---- */
  if (sub === "papers") {
    const subject = rest[0] ? resolveSubject(rest[0]) : null;
    if (rest[0] && !subject) return doc("Papers — bad subject", `unknown subject "${rest[0]}"`);
    const papers = await loadPapers(ctx, subject?.code);
    return doc(
      subject ? `Papers — ${subject.name}` : "Papers — all subjects",
      renderPapersList(subject, papers),
    );
  }

  /* ---- chapter … ---- */
  if (sub === "chapter" || sub === "chapters") {
    const subject = resolveSubject(rest[0] ?? "");
    if (!subject)
      return doc("Chapter — bad command", `unknown subject "${rest[0] ?? ""}"\n\n${USAGE}`);

    if (!rest[1]) {
      const states = await loadChapters(ctx, subject.code);
      const lines = ["| CH | TITLE | LEVEL | STATUS | STRENGTH |", "|---|---|---|---|---|"];
      for (const ch of subject.chapters) {
        const st = states.get(ch.id);
        const status = st?.status ?? "todo";
        const strength =
          st && status !== "todo"
            ? `${stars(effectiveStrength(st))} ${effectiveStrength(st).toFixed(1)}`
            : "—";
        lines.push(`| ${ch.id} | ${ch.title} | ${ch.level} | ${status} | ${strength} |`);
      }
      return doc(`Chapters — ${subject.name}`, lines.join("\n"));
    }

    const ch = chapterById(subject, rest[1]);
    if (!ch) {
      const valid = subject.chapters.map((c) => c.id).join(", ");
      return doc(
        "Chapter — bad id",
        `unknown ${subject.name} chapter "${rest[1]}" (valid: ${valid})`,
      );
    }
    const states = await loadChapters(ctx, subject.code);
    const st: ChapterState = states.get(ch.id) ?? {
      subject: subject.code,
      chapter: ch.id,
      status: "todo",
      rating: null,
      adj: 0,
    };

    const action = (rest[2] ?? "").toLowerCase();
    if (action === "done" || action === "doing" || action === "todo") {
      st.status = action;
    } else if (action === "rate") {
      const rating = Number(rest[3]);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5)
        return doc(
          "Chapter — bad rating",
          "rating must be a whole number 1–5, e.g. `chapter 9702 2 rate 4`",
        );
      st.rating = rating;
      if (st.status === "todo") st.status = "doing";
    } else {
      return doc(
        "Chapter — bad command",
        `unknown action "${rest[2] ?? ""}" — use done / doing / todo / rate <1-5>`,
      );
    }
    await ctx.records.put(COL_CHAPTERS, `${subject.code}:${ch.id}`, st);
    const eff = effectiveStrength(st);
    return doc(
      `${subject.name} ch ${ch.id} — ${st.status}`,
      `**${ch.title}** → status **${st.status}**, rating **${st.rating ?? "unset (3)"}**, strength **${stars(eff)} ${eff.toFixed(1)}**.`,
      [`ACAD · ${subject.code} ch${ch.id} ${st.status}${st.rating ? ` r${st.rating}` : ""}`],
    );
  }

  /* ---- exam … ---- */
  if (sub === "exam" || sub === "exams") {
    const config = await loadConfig(ctx);
    const which = (rest[0] ?? "").toLowerCase();
    if (which === "as" || which === "al") {
      const date = rest[1] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return doc("Exam — bad date", "usage: `exam as 2027-05-14` (YYYY-MM-DD)");
      const next = { ...config, [which === "as" ? "asExam" : "alExam"]: date };
      await ctx.records.put(COL_CONFIG, "config", next);
      await refreshMetrics(ctx);
      return doc(
        `${which.toUpperCase()} exam date set`,
        `${which.toUpperCase()} exam season now starts **${date}**.`,
        [`ACAD · ${which} exam → ${date}`],
      );
    }
    const t = today();
    return doc(
      "Exam countdown",
      `${countdownText("AS", config.asExam, t)}\n\n${countdownText("AL", config.alExam, t)}\n\nPhase: **${currentPhase(config, t)}**. Set or change with \`exam as YYYY-MM-DD\` / \`exam al YYYY-MM-DD\`.`,
    );
  }

  return doc("Academics — unknown command", USAGE);
}

export function createAcademicsPlugin(): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.academics",
      name: "Academics",
      version: "0.1.0",
      description:
        "CAIE A Level tracker (Physics 9702, Maths 9709, Computer Science 9618): past papers, chapters, strength, exam countdown.",
      capabilities: ["records", "metrics.read", "metrics.write", "fs.documents"],
      optional: true,
    },
    tools: [],
    scheduledJobs: [],
    commands: [
      {
        prefix: "paper",
        intentKey: INTENT.ACADEMICS_CMD,
        usage: "paper 9702 s23 22 48/60 [t:95] [weak:2,9]",
        description: "Log a past paper (or `paper rm …`)",
      },
      {
        prefix: "papers",
        intentKey: INTENT.ACADEMICS_CMD,
        usage: "papers [9702]",
        description: "List logged papers",
      },
      {
        prefix: "chapter",
        intentKey: INTENT.ACADEMICS_CMD,
        usage: "chapter 9702 2 done|doing|todo|rate 4",
        description: "Set chapter status / rating (or list: `chapter 9702`)",
      },
      {
        prefix: "exam",
        intentKey: INTENT.ACADEMICS_CMD,
        usage: "exam [as|al YYYY-MM-DD]",
        description: "Show or set exam dates",
      },
      {
        prefix: "board",
        intentKey: INTENT.ACADEMICS_BOARD,
        usage: "board",
        description: "Full A Level status board",
      },
      {
        prefix: "revise",
        intentKey: INTENT.ACADEMICS_REVISE,
        usage: "revise",
        description: "What to revise next (weakest chapters + unlogged papers)",
      },
    ],
    intents: [
      {
        key: INTENT.ACADEMICS_CMD,
        label: "ACAD CMD",
        agent: AGENT.SYSTEM,
        description:
          "Typed academics commands (paper/papers/chapter/exam) — parsed by code, no AI.",
        scheduleCron: null,
        requiresIntegration: null,
        hidden: true,
        async handler(ctx) {
          if (!ctx.input?.trim()) return ok(doc("Academics", USAGE));
          try {
            return ok(await handleCommand(ctx));
          } catch (e) {
            return err("ACAD_CMD", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        key: INTENT.ACADEMICS_BOARD,
        label: "A-LEVEL BOARD",
        agent: AGENT.SYSTEM,
        description:
          "Chapters, strengths, papers and exam countdown for 9702/9709/9618 — straight from the database.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("load", "papers + chapters + config");
          const snapshots = await loadSnapshots(ctx);
          const config = await loadConfig(ctx);
          await refreshMetrics(ctx);
          const t = today();
          return ok(
            doc(`A-Level Board — ${t}`, renderBoard(snapshots, config, t), [
              config.asExam
                ? `ACAD · board · AS in ${daysUntil(config.asExam, t)}d`
                : "ACAD · board · exam dates not set",
            ]),
          );
        },
      },
      {
        key: INTENT.ACADEMICS_REVISE,
        label: "REVISE NEXT",
        agent: AGENT.SYSTEM,
        description:
          "Weakest chapters and best next past papers, picked mechanically from your logged data.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("rank", "weakest chapters");
          const snapshots = await loadSnapshots(ctx);
          const config = await loadConfig(ctx);
          const t = today();
          return ok(
            doc(
              `Revise Next — ${t}`,
              renderRevise(snapshots, config, t),
              ["ACAD · revision targets computed"],
              "Revision targets ready.",
            ),
          );
        },
      },
    ],
  });
}
