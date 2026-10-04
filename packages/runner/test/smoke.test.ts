import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AGENT, ok } from "@nexus/core";
import { definePlugin } from "@nexus/plugin-sdk";
import { createServer } from "../src/server";
import { type MockOllama, startMockOllama } from "./helpers/mockOllama";
import { type TestHarness, makeTestApp, until } from "./helpers/testApp";

/**
 * SMOKE: boot the full Runner server, assert RUNNER·ALIVE over HTTP,
 * dispatch an intent through the public /cmd API, and watch the document
 * appear — the same path the HUD uses. Fully offline (mock Ollama).
 */

let ollama: MockOllama;
let h: TestHarness;
let server: ReturnType<typeof createServer>;
let base: string;

const smokePlugin = () =>
  definePlugin({
    manifest: {
      id: "smoke.plugin",
      name: "Smoke",
      version: "0.0.1",
      description: "smoke",
      capabilities: ["fs.documents", "llm.chat", "memory.read", "memory.write"],
    },
    tools: [],
    scheduledJobs: [],
    intents: [
      {
        key: "smoke.run",
        label: "SMOKE RUN",
        agent: AGENT.SYSTEM,
        description: "smoke intent (no LLM needed)",
        scheduleCron: null,
        requiresIntegration: null,
        async handler() {
          return ok({
            document: { kind: "note", title: "Smoke Doc", bodyMd: "it works" },
            speak: null,
            wire: ["SMOKE · ok"],
          });
        },
      },
    ],
  });

beforeAll(async () => {
  ollama = startMockOllama();
  h = await makeTestApp({ ollamaUrl: ollama.url, plugins: [() => smokePlugin()] });
  server = createServer(h.app);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  h.cleanup();
  ollama.stop();
});

describe("smoke: RUNNER·ALIVE + full command path", () => {
  test("/health reports alive without auth", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runner: string };
    expect(body.runner).toBe("alive");
  });

  test("auth is enforced everywhere else", async () => {
    const res = await fetch(`${base}/state`);
    expect(res.status).toBe(401);
    const ws = await fetch(`${base}/ws`);
    expect(ws.status).toBe(401);
  });

  test("dispatch via /cmd completes a reference run end-to-end", async () => {
    const auth = { authorization: "Bearer test-token", "content-type": "application/json" };
    const res = await fetch(`${base}/cmd`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "intent.dispatch", intentKey: "smoke.run", input: null }),
    });
    expect(res.status).toBe(200);

    await until(async () => {
      const state = await fetch(`${base}/state`, { headers: auth });
      const snap = (await state.json()) as { documents: Array<{ title: string }> };
      return snap.documents.some((d) => d.title === "Smoke Doc");
    });

    const state = await fetch(`${base}/state`, { headers: auth });
    const snap = (await state.json()) as {
      status: { runner: string };
      intents: Array<{ key: string }>;
      cards: Array<{ title: string }>;
    };
    expect(snap.status.runner).toBe("alive");
    expect(snap.intents.some((i) => i.key === "smoke.run")).toBe(true);
    expect(snap.cards.some((c) => c.title === "Smoke Doc")).toBe(true);
  });
});
