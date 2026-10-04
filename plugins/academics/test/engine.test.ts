import { describe, expect, test } from "bun:test";
import {
  type ChapterState,
  DEFAULT_CONFIG,
  applyPaperNudge,
  countdownText,
  currentPhase,
  daysUntil,
  effectiveStrength,
  parsePaperCommand,
  parseSession,
  renderBoard,
  renderRevise,
  suggestPapers,
} from "../src/engine";
import { CS, MATHS, PHYSICS, chapterById, resolveSubject } from "../src/syllabus";

/** An operator who has set their own exam dates. */
const CFG = { asExam: "2027-05-10", alExam: "2028-05-08" };

describe("syllabus data", () => {
  test("subjects resolve by code and alias", () => {
    expect(resolveSubject("9702")?.name).toBe("Physics");
    expect(resolveSubject("phy")?.name).toBe("Physics");
    expect(resolveSubject("MATHS")?.code).toBe("9709");
    expect(resolveSubject("cs")?.code).toBe("9618");
    expect(resolveSubject("bio")).toBeNull();
  });

  test("chapter counts match CAIE structure", () => {
    expect(PHYSICS.chapters.filter((c) => c.level === "AS")).toHaveLength(11);
    expect(PHYSICS.chapters.filter((c) => c.level === "AL")).toHaveLength(14);
    expect(CS.chapters.filter((c) => c.level === "AS")).toHaveLength(12);
    expect(CS.chapters.filter((c) => c.level === "AL")).toHaveLength(8);
    expect(MATHS.chapters).toHaveLength(38);
  });
});

describe("paper command parsing", () => {
  test("full form: subject session paper score/max weak", () => {
    const p = parsePaperCommand("paper 9702 s23 22 48/60 t:95 weak:2,9");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.subject.code).toBe("9702");
    expect(p.value.session).toBe("s23");
    expect(p.value.paperNo).toBe(2);
    expect(p.value.variant).toBe(2);
    expect(p.value.score).toBe(48);
    expect(p.value.max).toBe(60);
    expect(p.value.timeMin).toBe(95);
    expect(p.value.weak).toEqual(["2", "9"]);
  });

  test("aliases, qp prefix, bare score defaults to official marks", () => {
    const p = parsePaperCommand("paper phy mj23 qp22 48");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.session).toBe("s23"); // mj → s
    expect(p.value.max).toBe(60); // physics paper 2 official marks
  });

  test("maths component chapters accepted as weak tags", () => {
    const p = parsePaperCommand("paper maths s24 12 60/75 weak:1.3,1.7");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.weak).toEqual(["1.3", "1.7"]);
  });

  test("precise errors: bad subject, session, paper, score, chapter", () => {
    expect(parsePaperCommand("paper bio s23 22 48/60")).toMatchObject({ ok: false });
    expect(parsePaperCommand("paper 9702 2023 22 48/60")).toMatchObject({ ok: false });
    const badPaper = parsePaperCommand("paper 9702 s23 92 48/60");
    expect(badPaper.ok).toBe(false);
    if (!badPaper.ok) expect(badPaper.error).toContain("valid: 1, 2, 3, 4, 5");
    expect(parsePaperCommand("paper 9702 s23 22 70/60")).toMatchObject({ ok: false });
    const badWeak = parsePaperCommand("paper 9702 s23 22 48/60 weak:99");
    expect(badWeak.ok).toBe(false);
    if (!badWeak.ok) expect(badWeak.error).toContain("unknown Physics chapter");
  });

  test("session normalization", () => {
    expect(parseSession("s23")).toBe("s23");
    expect(parseSession("ON22")).toBe("w22");
    expect(parseSession("fm24")).toBe("m24");
    expect(parseSession("2023")).toBeNull();
  });
});

describe("strength model", () => {
  const mkState = (
    chapter: string,
    status: ChapterState["status"],
    rating: number | null = null,
  ): ChapterState => ({
    subject: "9702",
    chapter,
    status,
    rating,
    adj: 0,
  });

  test("weak tag knocks −0.3 and marks the chapter doing", () => {
    const states = new Map([["2", mkState("2", "todo")]]);
    applyPaperNudge(PHYSICS, 2, 0.8, ["2"], states);
    const st = states.get("2");
    expect(st?.adj).toBe(-0.3);
    expect(st?.status).toBe("doing");
    expect(effectiveStrength(st ?? mkState("2", "doing"))).toBe(2.7); // default rating 3 − 0.3
  });

  test("good paper drifts started chapters up; untouched chapters stay put", () => {
    const states = new Map([
      ["2", mkState("2", "done", 4)],
      ["9", mkState("9", "doing")],
    ]);
    applyPaperNudge(PHYSICS, 2, 0.9, [], states);
    expect(states.get("2")?.adj).toBe(0.04); // (0.9−0.7)×0.2
    expect(states.get("9")?.adj).toBe(0.04);
    expect(states.has("12")).toBe(false); // AL chapter, AS paper — untouched
  });

  test("bad paper drifts down; adj clamps at ±1.5", () => {
    const st = mkState("2", "done", 4);
    st.adj = -1.45;
    const states = new Map([["2", st]]);
    applyPaperNudge(PHYSICS, 2, 0.3, [], states); // drift −0.08
    expect(states.get("2")?.adj).toBe(-1.5);
  });

  test("maths papers only nudge their own component", () => {
    const states = new Map([
      ["1.1", { subject: "9709", chapter: "1.1", status: "done" as const, rating: 3, adj: 0 }],
      ["4.2", { subject: "9709", chapter: "4.2", status: "done" as const, rating: 3, adj: 0 }],
    ]);
    applyPaperNudge(MATHS, 4, 0.9, [], states); // Mechanics paper
    expect(states.get("1.1")?.adj).toBe(0); // P1 chapter untouched
    expect(states.get("4.2")?.adj).toBe(0.04);
  });

  test("practical papers (9702 P3/P5) nudge nothing", () => {
    const states = new Map([["2", mkState("2", "done", 4)]]);
    const touched = applyPaperNudge(PHYSICS, 3, 0.95, [], states);
    expect(touched).toHaveLength(0);
  });
});

describe("countdown, phase, suggestions", () => {
  test("daysUntil and phase flip", () => {
    expect(daysUntil("2027-05-10", "2026-07-07")).toBe(307);
    expect(currentPhase(CFG, "2026-07-07")).toBe("AS");
    expect(currentPhase(CFG, "2027-06-01")).toBe("AL");
  });

  test("a fresh install has no exam dates and says how to set them", () => {
    expect(DEFAULT_CONFIG).toEqual({ asExam: "", alExam: "" });
    expect(currentPhase(DEFAULT_CONFIG, "2030-01-01")).toBe("AS");
    expect(countdownText("AS", "", "2026-07-07")).toContain("`exam as YYYY-MM-DD`");
    expect(countdownText("AL", "2028-05-08", "2026-07-07")).toBe("AL in **671d** (2028-05-08)");
    const body = renderBoard(
      [{ subject: PHYSICS, chapters: new Map(), papers: [] }],
      DEFAULT_CONFIG,
      "2026-07-07",
    );
    expect(body).toContain("AS date not set");
    expect(body).not.toContain("NaN");
  });

  test("suggestions start from last year and skip logged papers", () => {
    const logged = new Set(["w25-1"]);
    const out = suggestPapers(PHYSICS, "AS", logged, "2026-07-07", 2);
    expect(out).toEqual([
      { session: "w25", paperNo: 2, name: "AS Structured Questions" },
      { session: "w25", paperNo: 3, name: "Advanced Practical Skills" },
    ]);
  });

  test("AL phase suggests AL + EITHER papers only", () => {
    const out = suggestPapers(MATHS, "AL", new Set(), "2027-07-01", 3);
    expect(out.every((s) => [3, 4, 5, 6].includes(s.paperNo))).toBe(true);
  });
});

describe("rendering", () => {
  test("board renders countdown, tables and progress", () => {
    const chapters = new Map([
      ["2", { subject: "9702", chapter: "2", status: "done" as const, rating: 4, adj: 0.1 }],
    ]);
    const body = renderBoard([{ subject: PHYSICS, chapters, papers: [] }], CFG, "2026-07-07");
    expect(body).toContain("PHASE AS");
    expect(body).toContain("307d");
    expect(body).toContain("Kinematics");
    expect(body).toContain("★★★★☆ 4.1");
    expect(body).toContain("1/11");
  });

  test("revise names the weakest started chapter first", () => {
    const chapters = new Map([
      ["2", { subject: "9702", chapter: "2", status: "done" as const, rating: 5, adj: 0 }],
      ["9", { subject: "9702", chapter: "9", status: "doing" as const, rating: 2, adj: -0.3 }],
    ]);
    const body = renderRevise(
      [{ subject: PHYSICS, chapters, papers: [] }],
      DEFAULT_CONFIG,
      "2026-07-07",
    );
    const first = body.indexOf("Electricity");
    const second = body.indexOf("Kinematics");
    expect(first).toBeGreaterThan(-1);
    expect(second === -1 || first < second).toBe(true);
  });

  test("chapterById tolerates case and whitespace", () => {
    expect(chapterById(MATHS, " 1.3 ")?.title).toBe("Coordinate geometry");
  });
});
