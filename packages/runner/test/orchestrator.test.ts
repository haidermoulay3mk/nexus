import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGENT, INTENT, type NexusEvent, ok } from "@nexus/core";
import { definePlugin } from "@nexus/plugin-sdk";
import { type MockOllama, startMockOllama } from "./helpers/mockOllama";
import { type TestHarness, makeTestApp, until } from "./helpers/testApp";

let ollama: MockOllama;
let h: TestHarness;
const events: NexusEvent[] = [];

/** A minimal plugin that exercises the full agent loop against mock Ollama. */
const testPlugin = () =>
  definePlugin({
    manifest: {
      id: "test.plugin",
      name: "Test Plugin",
      version: "0.0.1",
      description: "test",
      capabilities: ["memory.read", "memory.write", "fs.documents", "llm.chat", "metrics.read"],
    },
    tools: [],
    scheduledJobs: [],
    intents: [
      {
        key: "test.report",
        label: "TEST REPORT",
        agent: AGENT.SCRIBE,
        description: "produce a test report through the real agent loop",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          const agent = await ctx.runAgent({
            agent: AGENT.SCRIBE,
            brief: "Write the test report.",
            tools: ["memory.search"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: { kind: "report", title: "Test Report", bodyMd: agent.value.text },
            speak: "done",
            wire: ["TEST · report compiled"],
          });
        },
      },
      {
        key: "test.forbidden",
        label: "FORBIDDEN",
        agent: AGENT.SYSTEM,
        description: "tries to use a capability it was never granted",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          // net.fetch is NOT in this plugin's manifest → must throw.
          await ctx.net.fetchCached("k", "https://example.com", 60);
          return ok({ document: null, speak: null, wire: [] });
        },
      },
    ],
  });

beforeAll(async () => {
  ollama = startMockOllama("STATUS nominal. SIGNALS strong. PRIORITIES ship.");
  h = await makeTestApp({ ollamaUrl: ollama.url, plugins: [() => testPlugin()] });
  await h.app.ollama.healthcheck();
  h.app.bus.subscribe((e) => events.push(e));
});

afterAll(() => {
  h.cleanup();
  ollama.stop();
});

describe("orchestrator: intent → run → document pipeline (mocked Ollama)", () => {
  test("completes a run, writes the document, creates a card, streams tokens", async () => {
    const result = await h.app.orchestrator.execute("test.report", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("completed");
    expect(result.value.tokensOut).toBeGreaterThan(0);

    const docs = await h.app.documents.recent(5);
    expect(docs.some((d) => d.title === "Test Report")).toBe(true);
    const cards = h.app.cardsSvc.list();
    expect(cards.some((c) => c.title === "Test Report")).toBe(true);

    expect(events.some((e) => e.type === "run.started")).toBe(true);
    expect(events.some((e) => e.type === "run.token")).toBe(true);
    expect(events.some((e) => e.type === "run.completed")).toBe(true);
    expect(events.some((e) => e.type === "document.created")).toBe(true);
    expect(events.some((e) => e.type === "wire.append")).toBe(true);
  });

  test("capability gating: ungranted tool access fails the run and audits it", async () => {
    const result = await h.app.orchestrator.execute("test.forbidden", null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("net.fetch");
    const audits = h.app.handle.sqlite
      .query("SELECT action FROM audit WHERE action = 'permission.denied'")
      .all();
    expect(audits.length).toBeGreaterThan(0);
  });

  test("unknown intent is rejected", async () => {
    const result = await h.app.orchestrator.execute("nope.nothing", null);
    expect(result.ok).toBe(false);
  });
});

describe("queue + scheduler", () => {
  test("enqueued task drains to done and emits queue status", async () => {
    const taskId = h.app.queue.enqueue("test.report", null);
    expect(taskId).toBeTruthy();
    await until(() => {
      const row = h.app.handle.sqlite
        .query("SELECT status FROM tasks WHERE id = ?")
        .get(taskId) as { status: string } | null;
      return row?.status === "done";
    });
    expect(events.some((e) => e.type === "run.queued")).toBe(true);
  });

  test("scheduler registers the AM report cron with a future next-run", async () => {
    // The reports plugin isn't loaded in this harness; register directly.
    h.app.scheduler.register([{ id: "test-cron", cron: "0 8 * * *", intentKey: "test.report" }]);
    const jobs = h.app.scheduler.list();
    const job = jobs.find((j) => j.id === "test-cron");
    expect(job).toBeDefined();
    expect(job?.next).toBeTruthy();
    expect(new Date(job?.next ?? 0).getTime()).toBeGreaterThan(Date.now());
  });
});
