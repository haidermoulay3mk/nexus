import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MockOllama, startMockOllama } from "./helpers/mockOllama";
import { type TestHarness, makeTestApp } from "./helpers/testApp";

let ollama: MockOllama;
let h: TestHarness;

beforeAll(async () => {
  ollama = startMockOllama();
  h = await makeTestApp({ ollamaUrl: ollama.url });
  await h.app.ollama.healthcheck();
});

afterAll(() => {
  h.cleanup();
  ollama.stop();
});

describe("4-layer memory", () => {
  test("semantic: write then retrieve the same fact as the top hit", async () => {
    await h.app.memory.write("fact", "The operator ships videos about local AI terminals", "test");
    await h.app.memory.write("pref", "The operator prefers amber-on-black interfaces", "test");
    await h.app.memory.write("note", "Completely unrelated grocery list: milk, eggs", "test");

    const hits = await h.app.memory.search("videos about local AI", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain("local AI terminals");
  });

  test("structured: recent() filters by kind", async () => {
    const prefs = await h.app.memory.recent("pref", 10);
    expect(prefs.every((p) => p.kind === "pref")).toBe(true);
    expect(prefs.some((p) => p.text.includes("amber"))).toBe(true);
  });

  test("working: buffer trims to its token budget", () => {
    for (let i = 0; i < 60; i++) {
      h.app.memory.appendWorking("user", `filler message ${i} ${"x".repeat(400)}`);
    }
    const buf = h.app.memory.workingBuffer();
    const totalChars = buf.reduce((s, m) => s + m.content.length, 0);
    expect(totalChars / 4).toBeLessThan(2_400); // budget 2000 tokens + slack
    expect(buf.length).toBeGreaterThan(0);
  });
});
