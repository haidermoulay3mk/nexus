import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INTENT } from "@nexus/core";
import { createAcademicsPlugin } from "@nexus/plugin-academics";
import { createAgencyPlugin } from "@nexus/plugin-agency";
import { createCoursesPlugin } from "@nexus/plugin-courses";
import { createOpsPlugin } from "@nexus/plugin-ops";
import { createScholarshipsPlugin } from "@nexus/plugin-scholarships";
import { type MockOllama, startMockOllama } from "./helpers/mockOllama";
import { type TestHarness, makeTestApp, until } from "./helpers/testApp";

/**
 * End-to-end proof of the durability law: every tracking operation below
 * goes typed command → router → queue → deterministic handler → SQLite,
 * with the LLM never on the write path.
 */

let ollama: MockOllama;
let h: TestHarness;

beforeAll(async () => {
  ollama = startMockOllama("unused — no test below needs the model");
  h = await makeTestApp({
    ollamaUrl: ollama.url,
    plugins: [
      () => createAcademicsPlugin(),
      () => createScholarshipsPlugin(),
      () => createCoursesPlugin(),
      () => createAgencyPlugin(),
      (deps) => createOpsPlugin({ introspect: deps.introspect }),
    ],
  });
  await h.app.ollama.healthcheck();
});

afterAll(() => {
  h.cleanup();
  ollama.stop();
});

describe("records service", () => {
  test("put/get/list/remove round-trip", async () => {
    await h.app.recordsSvc.put("t.col", "a", { x: 1 });
    await h.app.recordsSvc.put("t.col", "a", { x: 2 }); // upsert
    await h.app.recordsSvc.put("t.col", "b", { x: 3 });
    expect((await h.app.recordsSvc.get("t.col", "a"))?.data).toEqual({ x: 2 });
    expect(await h.app.recordsSvc.count("t.col")).toBe(2);
    expect(await h.app.recordsSvc.remove("t.col", "a")).toBe(true);
    expect(await h.app.recordsSvc.get("t.col", "a")).toBeNull();
  });
});

describe("academics end-to-end (zero LLM)", () => {
  test("paper log writes the record, nudges strength, updates metrics", async () => {
    const res = await h.app.orchestrator.execute(
      INTENT.ACADEMICS_CMD,
      "paper 9702 s23 22 48/60 weak:2",
    );
    expect(res.ok).toBe(true);

    const paper = await h.app.recordsSvc.get("acad.papers", "9702-s23-22");
    expect(paper).not.toBeNull();
    const data = paper?.data as { attempts: Array<{ pct: number }>; weak: string[] };
    expect(data.attempts).toHaveLength(1);
    expect(data.attempts[0]?.pct).toBe(80);
    expect(data.weak).toEqual(["2"]);

    const ch = await h.app.recordsSvc.get("acad.chapters", "9702:2");
    expect((ch?.data as { adj: number }).adj).toBe(-0.3);
    expect((ch?.data as { status: string }).status).toBe("doing");

    const metrics = await h.app.metricsSvc.all();
    expect(metrics.find((m) => m.key === "acad.papers")?.value).toBe(1);
  });

  test("re-logging the same paper appends an attempt instead of overwriting", async () => {
    await h.app.orchestrator.execute(INTENT.ACADEMICS_CMD, "paper 9702 s23 22 55/60");
    const paper = await h.app.recordsSvc.get("acad.papers", "9702-s23-22");
    expect((paper?.data as { attempts: unknown[] }).attempts).toHaveLength(2);
  });

  test("bad commands produce usage documents, not failed runs", async () => {
    const res = await h.app.orchestrator.execute(INTENT.ACADEMICS_CMD, "paper 9702 s23 92 48/60");
    expect(res.ok).toBe(true); // run completes; the document explains the mistake
    const docs = await h.app.documents.recent(3);
    expect(docs.some((d) => d.title.includes("bad command"))).toBe(true);
  });

  test("board renders from the database", async () => {
    const res = await h.app.orchestrator.execute(INTENT.ACADEMICS_BOARD, null);
    expect(res.ok).toBe(true);
    const docs = await h.app.documents.recent(3);
    const board = docs.find((d) => d.title.startsWith("A-Level Board"));
    expect(board?.bodyMd).toContain("Physics 9702");
    expect(board?.bodyMd).toContain("papers logged: **1**");
  });
});

describe("command routing through nexus.command", () => {
  test("typed prefix routes to the owning intent via the queue (no LLM)", async () => {
    const res = await h.app.orchestrator.execute(INTENT.COMMAND, "chapter 9702 3 done");
    expect(res.ok).toBe(true);
    await until(async () => (await h.app.recordsSvc.get("acad.chapters", "9702:3")) !== null);
    const ch = await h.app.recordsSvc.get("acad.chapters", "9702:3");
    expect((ch?.data as { status: string }).status).toBe("done");
  });

  test("help lists every registered command prefix", async () => {
    const res = await h.app.orchestrator.execute(INTENT.COMMAND, "help");
    expect(res.ok).toBe(true);
    const docs = await h.app.documents.recent(3);
    const help = docs.find((d) => d.title === "Typed Commands");
    for (const prefix of [
      "paper",
      "chapter",
      "scholar",
      "course",
      "agency",
      "audit",
      "board",
      "revise",
    ]) {
      expect(help?.bodyMd).toContain(`\`${prefix}\``);
    }
  });
});

describe("courses", () => {
  test("add → progress → stale detection creates a directive", async () => {
    await h.app.orchestrator.execute(INTENT.COURSE_CMD, "course add CS50 | edX | https://cs50.io");
    await h.app.orchestrator.execute(INTENT.COURSE_CMD, "course progress cs50 40");
    const rec = await h.app.recordsSvc.get("courses.items", "cs50");
    expect((rec?.data as { pct: number }).pct).toBe(40);

    // Backdate lastTouch to force staleness, then run the daily check.
    const data = rec?.data as Record<string, unknown>;
    await h.app.recordsSvc.put("courses.items", "cs50", { ...data, lastTouch: "2026-01-01" });
    const res = await h.app.orchestrator.execute(INTENT.COURSE_CHECK, null);
    expect(res.ok).toBe(true);
    const directives = await h.app.directivesSvc.list(false);
    expect(directives.some((d) => d.text.startsWith("COURSE: CS50"))).toBe(true);

    // Second run must not duplicate the directive.
    await h.app.orchestrator.execute(INTENT.COURSE_CHECK, null);
    const again = await h.app.directivesSvc.list(false);
    expect(again.filter((d) => d.text.startsWith("COURSE: CS50"))).toHaveLength(1);
  });
});

describe("agency pipeline", () => {
  test("lead → won → project → paid, with revenue metric", async () => {
    await h.app.orchestrator.execute(INTENT.AGENCY_CMD, "agency lead Acme Corp | wants a chatbot");
    await h.app.orchestrator.execute(INTENT.AGENCY_CMD, "agency won acme");
    expect(await h.app.recordsSvc.get("agency.clients", "acme-corp")).not.toBeNull();

    await h.app.orchestrator.execute(INTENT.AGENCY_CMD, "agency project Chatbot v1 | acme | 500");
    await h.app.orchestrator.execute(INTENT.AGENCY_CMD, "agency paid acme 250 first half");

    const metrics = await h.app.metricsSvc.all();
    expect(metrics.find((m) => m.key === "agency.revenue")?.value).toBe(250);

    const res = await h.app.orchestrator.execute(INTENT.AGENCY_BOARD, null);
    expect(res.ok).toBe(true);
    const docs = await h.app.documents.recent(3);
    const board = docs.find((d) => d.title.startsWith("Agency Board"));
    expect(board?.bodyMd).toContain("Chatbot v1");
    expect(board?.bodyMd).toContain("$250");
  });
});

describe("scholarships (offline paths)", () => {
  test("list and star behave sanely with no data", async () => {
    const res = await h.app.orchestrator.execute(INTENT.SCHOLAR_CMD, "scholar list");
    expect(res.ok).toBe(true);
    const bad = await h.app.orchestrator.execute(INTENT.SCHOLAR_CMD, "scholar star ffffffff");
    expect(bad.ok).toBe(true); // completes with an explanatory document
  });
});

describe("system audit", () => {
  test("audit passes with all life plugins loaded and mock model ready", async () => {
    const res = await h.app.orchestrator.execute(INTENT.SYS_AUDIT, null);
    expect(res.ok).toBe(true);
    const docs = await h.app.documents.recent(3);
    const audit = docs.find((d) => d.title.startsWith("System Audit"));
    expect(audit).toBeDefined();
    expect(audit?.title).toContain("(PASS)");
    expect(audit?.bodyMd).toContain("SYSTEM HEALTHY");
    // The data footprint proves records persisted across the suite.
    expect(audit?.bodyMd).toContain("acad.papers:1");
  });
});
