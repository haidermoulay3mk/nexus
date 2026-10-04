import {
  type ChapterDef,
  SUBJECTS,
  type SubjectDef,
  chapterById,
  paperByNo,
  resolveSubject,
} from "./syllabus";

/**
 * Pure, deterministic academics engine. No LLM, no I/O — every function
 * here is unit-tested and behaves identically under any (or no) model.
 *
 * THE STRENGTH MODEL (hybrid, mechanical — agreed with the operator):
 *  - Each touched chapter stores: status (todo|doing|done), rating (1–5,
 *    operator-set, default 3) and adj (automatic drift, clamped ±1.5).
 *  - effective strength = clamp(rating + adj, 1, 5).
 *  - Logging a paper with `weak:<chapters>` knocks each tagged chapter's
 *    adj down 0.3 — strong evidence.
 *  - The paper's overall % nudges every OTHER started chapter the paper
 *    covers by (pct − 0.70) × 0.2 — weak evidence, slow drift. 70% is the
 *    neutral line (≈ an A-grade threshold); score above it and strengths
 *    creep up, below it and they sag.
 */

export type ChapterStatus = "todo" | "doing" | "done";

export interface ChapterState {
  subject: string;
  chapter: string;
  status: ChapterStatus;
  rating: number | null;
  adj: number;
}

export interface PaperAttempt {
  date: string; // YYYY-MM-DD
  score: number;
  max: number;
  pct: number; // 0..100, 1dp
  timeMin: number | null;
}

export interface PaperState {
  subject: string;
  session: string; // normalized, e.g. "s23"
  paper: string; // as logged, e.g. "22" (paper 2 variant 2) or "4"
  paperNo: number;
  variant: number | null;
  attempts: PaperAttempt[];
  weak: string[];
}

export interface AcademicsConfig {
  asExam: string; // YYYY-MM-DD — nominal first day of the AS exam season
  alExam: string;
}

/** A fresh install has no exam dates — the operator sets their own (`exam as YYYY-MM-DD`). */
export const DEFAULT_CONFIG: AcademicsConfig = { asExam: "", alExam: "" };

export const NEUTRAL_PCT = 0.7;
export const NUDGE_FACTOR = 0.2;
export const WEAK_PENALTY = 0.3;
export const ADJ_CLAMP = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
// adj accumulates ±0.04-sized drifts — 2dp storage so they don't round to zero
const round2 = (v: number) => Math.round(v * 100) / 100;

export function effectiveStrength(ch: Pick<ChapterState, "rating" | "adj">): number {
  return round1(clamp((ch.rating ?? 3) + ch.adj, 1, 5));
}

/* ------------------------------------------------------------------ */
/* Command parsing — plain TS, exact errors, zero AI                   */
/* ------------------------------------------------------------------ */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PaperLog {
  subject: SubjectDef;
  session: string;
  paper: string;
  paperNo: number;
  variant: number | null;
  score: number;
  max: number;
  timeMin: number | null;
  weak: string[];
}

/** Normalize a session token: s23 / w22 / m24, also mj23→s23, on22→w22, fm24→m24. */
export function parseSession(token: string): string | null {
  const t = token.trim().toLowerCase().replace(/^mj/, "s").replace(/^on/, "w").replace(/^fm/, "m");
  return /^[msw]\d{2}$/.test(t) ? t : null;
}

/** "22" | "qp22" | "p22" | "4" → { paperNo, variant, token } */
export function parsePaperToken(
  raw: string,
  subject: SubjectDef,
): Parsed<{ paperNo: number; variant: number | null; token: string }> {
  const digits = raw.trim().toLowerCase().replace(/^qp/, "").replace(/^p/, "");
  if (!/^\d{1,2}$/.test(digits)) {
    return { ok: false, error: `"${raw}" is not a paper — use e.g. 22 (paper 2 variant 2) or 4` };
  }
  const paperNo = Number(digits[0]);
  const variant = digits.length === 2 ? Number(digits[1]) : null;
  const def = paperByNo(subject, paperNo);
  if (!def) {
    const valid = subject.papers.map((p) => p.no).join(", ");
    return { ok: false, error: `${subject.name} has no paper ${paperNo} (valid: ${valid})` };
  }
  return { ok: true, value: { paperNo, variant, token: digits } };
}

/**
 * `paper 9702 s23 22 48/60 [t:95] [weak:2,9]`
 * Subject aliases (phy/maths/cs), qp/p prefixes, bare scores and mj/on/fm
 * session forms are all accepted. Everything else is a precise error.
 */
export function parsePaperCommand(line: string): Parsed<PaperLog> {
  const usage =
    "usage: paper <subject> <session> <paper> <score>[/max] [t:<min>] [weak:<ch,ch>]  — e.g. paper 9702 s23 22 48/60 weak:2,9";
  const tokens = line.trim().split(/\s+/);
  // tokens[0] is the "paper" prefix itself
  if (tokens.length < 5) return { ok: false, error: usage };

  const subject = resolveSubject(tokens[1] ?? "");
  if (!subject)
    return {
      ok: false,
      error: `unknown subject "${tokens[1]}" — use 9702/phy, 9709/maths or 9618/cs`,
    };

  const session = parseSession(tokens[2] ?? "");
  if (!session)
    return {
      ok: false,
      error: `bad session "${tokens[2]}" — use s23 (May/June 23), w22 (Oct/Nov 22) or m24 (Feb/Mar 24)`,
    };

  const paperTok = parsePaperToken(tokens[3] ?? "", subject);
  if (!paperTok.ok) return paperTok;
  const paperDef = paperByNo(subject, paperTok.value.paperNo);
  if (!paperDef) return { ok: false, error: "unreachable" };

  const scoreRaw = tokens[4] ?? "";
  const scoreMatch = scoreRaw.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!scoreMatch) return { ok: false, error: `bad score "${scoreRaw}" — use 48 or 48/60` };
  const score = Number(scoreMatch[1]);
  const max = scoreMatch[2] ? Number(scoreMatch[2]) : paperDef.marks;
  if (max <= 0) return { ok: false, error: "max marks must be positive" };
  if (score > max) return { ok: false, error: `score ${score} exceeds max ${max}` };

  let timeMin: number | null = null;
  const weak: string[] = [];
  for (const extra of tokens.slice(5)) {
    const t = extra.toLowerCase();
    const time = t.match(/^t:(\d+)m?$/) ?? t.match(/^(\d+)m$/);
    if (time) {
      timeMin = Number(time[1]);
      continue;
    }
    const weakMatch = t.match(/^weak:(.+)$/);
    if (weakMatch?.[1]) {
      for (const id of weakMatch[1].split(",")) {
        const ch = chapterById(subject, id);
        if (!ch) {
          const valid = subject.chapters.map((c) => c.id).join(", ");
          return { ok: false, error: `unknown ${subject.name} chapter "${id}" (valid: ${valid})` };
        }
        weak.push(ch.id);
      }
      continue;
    }
    return { ok: false, error: `unrecognized token "${extra}" — ${usage}` };
  }

  return {
    ok: true,
    value: {
      subject,
      session,
      paper: paperTok.value.token,
      paperNo: paperTok.value.paperNo,
      variant: paperTok.value.variant,
      score,
      max,
      timeMin,
      weak,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Strength updates                                                    */
/* ------------------------------------------------------------------ */

/**
 * Apply one logged paper to the chapter states of its subject.
 * `states` maps chapter id → state (only touched chapters are present).
 * Returns the ids whose adj changed.
 */
export function applyPaperNudge(
  subject: SubjectDef,
  paperNo: number,
  pct01: number,
  weak: string[],
  states: Map<string, ChapterState>,
): string[] {
  const paper = paperByNo(subject, paperNo);
  if (!paper) return [];
  const touched: string[] = [];

  const ensure = (ch: ChapterDef): ChapterState => {
    let st = states.get(ch.id);
    if (!st) {
      st = { subject: subject.code, chapter: ch.id, status: "todo", rating: null, adj: 0 };
      states.set(ch.id, st);
    }
    return st;
  };

  for (const id of weak) {
    const def = chapterById(subject, id);
    if (!def) continue;
    const st = ensure(def);
    st.adj = round2(clamp(st.adj - WEAK_PENALTY, -ADJ_CLAMP, ADJ_CLAMP));
    // Tagging a chapter weak on a paper implies you're studying it.
    if (st.status === "todo") st.status = "doing";
    touched.push(id);
  }

  const drift = (pct01 - NEUTRAL_PCT) * NUDGE_FACTOR;
  if (drift !== 0) {
    for (const ch of subject.chapters) {
      if (!paper.nudges(ch) || weak.includes(ch.id)) continue;
      const st = states.get(ch.id);
      if (!st || st.status === "todo") continue; // only started chapters drift
      st.adj = round2(clamp(st.adj + drift, -ADJ_CLAMP, ADJ_CLAMP));
      touched.push(ch.id);
    }
  }
  return touched;
}

/* ------------------------------------------------------------------ */
/* Countdown / phase / suggestions                                     */
/* ------------------------------------------------------------------ */

export function daysUntil(dateISO: string, todayISO: string): number {
  const ms =
    new Date(`${dateISO}T00:00:00Z`).getTime() - new Date(`${todayISO}T00:00:00Z`).getTime();
  return Math.ceil(ms / 86_400_000);
}

/** AS until the AS exam date passes, then AL. No AS date set yet → AS. */
export function currentPhase(config: AcademicsConfig, todayISO: string): "AS" | "AL" {
  if (!config.asExam) return "AS";
  return daysUntil(config.asExam, todayISO) >= 0 ? "AS" : "AL";
}

/** "AS in **307d** (2027-05-10)", or how to set the date when it isn't set. */
export function countdownText(level: "AS" | "AL", dateISO: string, todayISO: string): string {
  if (!dateISO) return `${level} date not set (\`exam ${level.toLowerCase()} YYYY-MM-DD\`)`;
  return `${level} in **${daysUntil(dateISO, todayISO)}d** (${dateISO})`;
}

/**
 * Past-paper suggestions: recent sessions (newest first) × papers of the
 * current phase, minus what's already logged. Deterministic, no AI.
 */
export function suggestPapers(
  subject: SubjectDef,
  phase: "AS" | "AL",
  loggedKeys: Set<string>, // `${session}-${paperNo}`
  todayISO: string,
  count = 2,
): Array<{ session: string; paperNo: number; name: string }> {
  // Start from LAST year so we never suggest a session whose papers CAIE
  // hasn't published yet (w-sessions release the following January).
  const year = Number(todayISO.slice(2, 4)) - 1;
  const sessions: string[] = [];
  for (let y = year; y >= year - 6; y--) {
    const yy = String(y).padStart(2, "0");
    sessions.push(`w${yy}`, `s${yy}`, `m${yy}`);
  }
  const out: Array<{ session: string; paperNo: number; name: string }> = [];
  for (const session of sessions) {
    for (const p of subject.papers) {
      if (p.level !== phase && p.level !== "EITHER") continue;
      if (loggedKeys.has(`${session}-${p.no}`)) continue;
      out.push({ session, paperNo: p.no, name: p.name });
      if (out.length >= count) return out;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rendering — markdown the HUD shows; plain code, no AI               */
/* ------------------------------------------------------------------ */

const STATUS_GLYPH: Record<ChapterStatus, string> = { done: "✔", doing: "●", todo: "○" };

export function stars(effective: number): string {
  const n = Math.round(effective);
  return "★".repeat(clamp(n, 0, 5)) + "☆".repeat(clamp(5 - n, 0, 5));
}

export interface SubjectSnapshot {
  subject: SubjectDef;
  chapters: Map<string, ChapterState>;
  papers: PaperState[];
}

export function renderBoard(
  snapshots: SubjectSnapshot[],
  config: AcademicsConfig,
  todayISO: string,
): string {
  const phase = currentPhase(config, todayISO);
  const lines: string[] = [
    `**PHASE ${phase}** · ${countdownText("AS", config.asExam, todayISO)} · ${countdownText("AL", config.alExam, todayISO)}`,
    "",
  ];

  for (const snap of snapshots) {
    const { subject, chapters, papers } = snap;
    const phaseChapters = subject.chapters.filter((c) => c.level === phase || c.level === "EITHER");
    const done = phaseChapters.filter((c) => chapters.get(c.id)?.status === "done").length;
    const attempts = papers.flatMap((p) => p.attempts);
    const avg =
      attempts.length > 0
        ? Math.round(attempts.reduce((a, b) => a + b.pct, 0) / attempts.length)
        : null;

    lines.push(`## ${subject.name} ${subject.code}`);
    lines.push(
      `${phase} chapters done: **${done}/${phaseChapters.length}** · papers logged: **${papers.length}** (${attempts.length} attempts${avg !== null ? `, avg **${avg}%**` : ""})`,
    );
    lines.push("");
    lines.push("| CH | TITLE | STATUS | STRENGTH |");
    lines.push("|---|---|---|---|");
    for (const ch of phaseChapters) {
      const st = chapters.get(ch.id);
      const status = st?.status ?? "todo";
      const strength =
        st && status !== "todo"
          ? `${stars(effectiveStrength(st))} ${effectiveStrength(st).toFixed(1)}`
          : "—";
      lines.push(`| ${ch.id} | ${ch.title} | ${STATUS_GLYPH[status]} ${status} | ${strength} |`);
    }
    lines.push("");
  }
  lines.push("_Log work with `paper …` and `chapter …` — type `help` for every command._");
  return lines.join("\n");
}

export function renderRevise(
  snapshots: SubjectSnapshot[],
  config: AcademicsConfig,
  todayISO: string,
): string {
  const phase = currentPhase(config, todayISO);
  const asDays = daysUntil(config.asExam, todayISO);
  const lines: string[] = [
    `**PHASE ${phase}** · ${asDays >= 0 ? `AS exams in **${asDays}d**` : `AL exams in **${daysUntil(config.alExam, todayISO)}d**`}`,
    "",
  ];

  // Weakest started chapters across all subjects (lowest effective strength).
  const started: Array<{ subject: SubjectDef; ch: ChapterDef; st: ChapterState }> = [];
  for (const snap of snapshots) {
    for (const ch of snap.subject.chapters) {
      if (ch.level !== phase && ch.level !== "EITHER") continue;
      const st = snap.chapters.get(ch.id);
      if (st && st.status !== "todo") started.push({ subject: snap.subject, ch, st });
    }
  }
  started.sort((a, b) => effectiveStrength(a.st) - effectiveStrength(b.st));

  lines.push("## REVISE FIRST");
  if (started.length === 0) {
    lines.push(
      "No chapters marked yet. Mark what you've studied: `chapter 9702 2 doing` / `chapter 9702 2 done`.",
    );
  } else {
    for (const { subject, ch, st } of started.slice(0, 3)) {
      lines.push(
        `- **${subject.name} ${ch.id} — ${ch.title}** · ${stars(effectiveStrength(st))} ${effectiveStrength(st).toFixed(1)}`,
      );
    }
  }
  lines.push("");

  lines.push("## PAPERS TO DO NEXT");
  for (const snap of snapshots) {
    const logged = new Set(snap.papers.map((p) => `${p.session}-${p.paperNo}`));
    const suggestions = suggestPapers(snap.subject, phase, logged, todayISO);
    for (const s of suggestions) {
      lines.push(
        `- ${snap.subject.name}: **${s.session} paper ${s.paperNo}** (${s.name}) — log it with \`paper ${snap.subject.code} ${s.session} ${s.paperNo}1 <score>\``,
      );
    }
  }
  return lines.join("\n");
}

export function renderPapersList(subject: SubjectDef | null, papers: PaperState[]): string {
  const rows = papers
    .filter((p) => !subject || p.subject === subject.code)
    .sort((a, b) =>
      (a.subject + a.session + a.paper).localeCompare(b.subject + b.session + b.paper),
    );
  if (rows.length === 0) return "No papers logged yet. Log one: `paper 9702 s23 22 48/60`";
  const lines = [
    "| SUBJECT | SESSION | PAPER | BEST | ATTEMPTS | WEAK CHAPTERS |",
    "|---|---|---|---|---|---|",
  ];
  for (const p of rows) {
    const best = p.attempts.length > 0 ? Math.max(...p.attempts.map((a) => a.pct)) : 0;
    lines.push(
      `| ${p.subject} | ${p.session} | ${p.paper} | ${best.toFixed(0)}% | ${p.attempts.length} | ${p.weak.join(", ") || "—"} |`,
    );
  }
  const attempts = rows.flatMap((p) => p.attempts);
  const avg =
    attempts.length > 0 ? Math.round(attempts.reduce((a, b) => a + b.pct, 0) / attempts.length) : 0;
  lines.push("");
  lines.push(`**${rows.length} papers · ${attempts.length} attempts · avg ${avg}%**`);
  return lines.join("\n");
}

export { SUBJECTS };
