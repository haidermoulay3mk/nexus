import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INTENT } from "@nexus/core";
import { buildApp } from "../src/app";
import { type MockOllama, startMockOllama } from "./helpers/mockOllama";
import { type TestHarness, makeTestApp, until } from "./helpers/testApp";

/**
 * The brain, end to end through the real runner: identity edits landing
 * mid-run, session continuity across a restart, memory files as source of
 * truth, semantic + keyword recall, and the extractor writing real files
 * through the code gates.
 */

let ollama: MockOllama;
let h: TestHarness;
const brainDir = () => join(h.cfg.dataDir, "brain");

const lastSystemPrompt = (): string => {
  const chats = ollama.requests.filter((r) => r.path === "/v1/chat/completions");
  const body = chats[chats.length - 1]?.body as {
    messages?: Array<{ role: string; content: string }>;
  } | null;
  return body?.messages?.find((m) => m.role === "system")?.content ?? "";
};

beforeAll(async () => {
  ollama = startMockOllama("Copy. Standing by.");
  h = await makeTestApp({ ollamaUrl: ollama.url });
  await h.app.ollama.healthcheck();
});

afterAll(() => {
  h.cleanup();
  ollama.stop();
});

describe("two-block prompt + living identity", () => {
  test("every agent turn carries identity, knowledge, capabilities and fresh time", async () => {
    const res = await h.app.orchestrator.execute(INTENT.COMMAND, "status check, anything urgent?");
    expect(res.ok).toBe(true);
    const system = lastSystemPrompt();
    expect(system).toContain("=== IDENTITY");
    expect(system).toContain("mission-control");
    expect(system).toContain("# Mission"); // core knowledge resident
    expect(system).toContain("brain:"); // generated self-knowledge (typed commands)
    expect(system).toContain("Local time:"); // dynamic block
    expect(system).not.toContain("PERSONALITY CHECKPOINT"); // shallow conversation
  });

  test("editing identity.md changes the very next response's prompt — no restart", async () => {
    await new Promise((r) => setTimeout(r, 15));
    const idPath = join(brainDir(), "identity.md");
    writeFileSync(idPath, `${readFileSync(idPath, "utf8")}\n\nCODEWORD: AMBER-FALCON.\n`, "utf8");
    await h.app.orchestrator.execute(INTENT.COMMAND, "still there?");
    expect(lastSystemPrompt()).toContain("AMBER-FALCON");
  });
});

describe("working memory (sessions)", () => {
  test("free text is a persisted conversation; typed commands are not", async () => {
    const { id } = h.app.chatSvc.current();
    const before = h.app.chatSvc.depth(id);
    await h.app.orchestrator.execute(INTENT.COMMAND, "let's plan this week's physics");
    expect(h.app.chatSvc.depth(id)).toBe(before + 2); // user + assistant
    await h.app.orchestrator.execute(INTENT.COMMAND, "help");
    expect(h.app.chatSvc.depth(id)).toBe(before + 2); // help never pollutes the thread
  });

  test("the transcript actually reaches the model on the next turn", async () => {
    await h.app.orchestrator.execute(INTENT.COMMAND, "the codephrase for tonight is violet-echo");
    await h.app.orchestrator.execute(INTENT.COMMAND, "repeat the codephrase back");
    const chats = ollama.requests.filter((r) => r.path === "/v1/chat/completions");
    const body = chats[chats.length - 1]?.body as {
      messages?: Array<{ content: string; role: string }>;
    };
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("violet-echo"); // carried via CONVERSATION SO FAR
  });

  test("conversation survives a full Runner restart", async () => {
    const { id } = h.app.chatSvc.current();
    const depth = h.app.chatSvc.depth(id);
    expect(depth).toBeGreaterThan(0);

    h.app.shutdown();
    const app2 = await buildApp(h.cfg, { nativePlugins: [], emitStatus: false });
    await app2.ollama.healthcheck();
    try {
      const resumed = app2.chatSvc.current();
      expect(resumed.id).toBe(id); // same thread, within the idle window
      expect(app2.chatSvc.depth(id)).toBe(depth); // every turn persisted
      const res = await app2.orchestrator.execute(INTENT.COMMAND, "where were we?");
      expect(res.ok).toBe(true);
      expect(app2.chatSvc.depth(id)).toBe(depth + 2);
    } finally {
      // hand the harness the live app so afterAll shuts down cleanly
      (h as { app: typeof app2 }).app = app2;
    }
  });

  test("session list / new / resume typed commands", async () => {
    const { id: original } = h.app.chatSvc.current();
    await h.app.orchestrator.execute(INTENT.BRAIN_CMD, "session new");
    const fresh = h.app.chatSvc.current();
    expect(fresh.id).not.toBe(original);
    await h.app.orchestrator.execute(INTENT.BRAIN_CMD, `session resume ${original.slice(0, 8)}`);
    expect(h.app.chatSvc.current().id).toBe(original);
  });
});

describe("long-term memory files", () => {
  test("human save → readable file + index + derived DB row", async () => {
    const res = await h.app.orchestrator.execute(
      INTENT.BRAIN_CMD,
      "brain save preference | Revision suggestions capped at three items | Longer lists overwhelm; revise output stays at 3.",
    );
    expect(res.ok).toBe(true);
    const files = readdirSync(join(brainDir(), "memories")).filter((f) => f !== "INDEX.md");
    expect(files.length).toBe(1);
    const raw = readFileSync(join(brainDir(), "memories", files[0] ?? ""), "utf8");
    expect(raw).toContain("type: preference");
    expect(raw).toContain("hook: Revision suggestions capped at three items");
    expect(readFileSync(join(brainDir(), "memories", "INDEX.md"), "utf8")).toContain(
      "capped at three items",
    );
    const row = h.app.handle.sqlite
      .query("SELECT kind, source FROM memories WHERE source LIKE 'brain:%'")
      .get() as { kind: string; source: string } | null;
    expect(row?.kind).toBe("preference");
  });

  test("semantic recall finds it from a paraphrase; near-duplicates are rejected", async () => {
    const hits = await h.app.memory.search("cap the revise list at three suggestions", 3);
    expect(hits[0]?.text).toContain("capped at three items");

    const dupe = await h.app.brainStore.save(
      "preference",
      "Revision suggestions should be capped at three items",
      "he prefers three suggestions",
    );
    expect(dupe.saved).toBe(false);
    if (!dupe.saved) expect(dupe.reason).toContain("already covered");
  });

  test("model-path red lines block; keyword fallback still recalls; index rebuilds from files", async () => {
    const blocked = await h.app.brainStore.save("user", "Sam's api key is sk-12345", "never");
    expect(blocked.saved).toBe(false);

    const kw = h.app.memory.keywordSearch("revision capped items", 3);
    expect(kw[0]?.text).toContain("capped at three items");

    h.app.handle.sqlite.exec("DELETE FROM memories WHERE source LIKE 'brain:%'");
    const re = await h.app.brainStore.reindex();
    expect(re.files).toBe(1);
    const back = await h.app.memory.search("cap the revise list at three suggestions", 3);
    expect(back[0]?.text).toContain("capped at three items");
  });

  test("forget requires confirmation and then really deletes", async () => {
    const file = readdirSync(join(brainDir(), "memories")).find((f) => f !== "INDEX.md") ?? "";
    await h.app.orchestrator.execute(INTENT.BRAIN_CMD, `brain forget ${file}`);
    expect(existsSync(join(brainDir(), "memories", file))).toBe(true); // no confirm → untouched
    await h.app.orchestrator.execute(INTENT.BRAIN_CMD, `brain forget ${file} confirm`);
    expect(existsSync(join(brainDir(), "memories", file))).toBe(false);
    const rows = h.app.handle.sqlite
      .query("SELECT id FROM memories WHERE source LIKE 'brain:%'")
      .all();
    expect(rows.length).toBe(0);
  });
});

describe("automatic extractor (model output passes code gates)", () => {
  let jsonOllama: MockOllama;
  let hx: TestHarness;

  beforeAll(async () => {
    jsonOllama = startMockOllama(
      '[{"type":"preference","hook":"Sam wants numbers-first status answers","body":"Open with the figure, then one line of context."}]',
    );
    hx = await makeTestApp({ ollamaUrl: jsonOllama.url });
    await hx.app.ollama.healthcheck();
  });

  afterAll(() => {
    hx.cleanup();
    jsonOllama.stop();
  });

  const seedConversation = (texts: string[]): string => {
    const { id } = hx.app.chatSvc.startNew();
    for (const t of texts) {
      hx.app.chatSvc.append(id, "user", t);
      hx.app.chatSvc.append(
        id,
        "assistant",
        "Understood — noted and standing by for the next step.",
      );
    }
    return id;
  };

  test("a real conversation yields a memory file; the session is marked", async () => {
    const id = seedConversation([
      "when you give me status I want the number first, context after",
      "also stop padding answers with pleasantries",
    ]);
    const res = await hx.app.orchestrator.execute(INTENT.BRAIN_EXTRACT, id);
    expect(res.ok).toBe(true);
    const files = readdirSync(join(hx.cfg.dataDir, "brain", "memories")).filter(
      (f) => f !== "INDEX.md",
    );
    expect(files.length).toBe(1);
    expect(
      readFileSync(join(hx.cfg.dataDir, "brain", "memories", files[0] ?? ""), "utf8"),
    ).toContain("numbers-first");
    const row = hx.app.handle.sqlite
      .query("SELECT extracted_at FROM sessions WHERE id = ?")
      .get(id) as {
      extracted_at: string | null;
    };
    expect(row.extracted_at).toContain("saved 1");
  });

  test("a second session proposing the same fact is deduped, not duplicated", async () => {
    const id = seedConversation([
      "numbers first please, always",
      "figure first then context, remember that",
    ]);
    await hx.app.orchestrator.execute(INTENT.BRAIN_EXTRACT, id);
    const files = readdirSync(join(hx.cfg.dataDir, "brain", "memories")).filter(
      (f) => f !== "INDEX.md",
    );
    expect(files.length).toBe(1); // still exactly one
  });

  test("too-short sessions are skipped without touching the model's opinion", async () => {
    const { id } = hx.app.chatSvc.startNew();
    hx.app.chatSvc.append(id, "user", "hi");
    hx.app.chatSvc.append(id, "assistant", "hello");
    await hx.app.orchestrator.execute(INTENT.BRAIN_EXTRACT, id);
    const row = hx.app.handle.sqlite
      .query("SELECT extracted_at FROM sessions WHERE id = ?")
      .get(id) as {
      extracted_at: string | null;
    };
    expect(row.extracted_at).toContain("too short");
    const files = readdirSync(join(hx.cfg.dataDir, "brain", "memories")).filter(
      (f) => f !== "INDEX.md",
    );
    expect(files.length).toBe(1); // unchanged
  });
});

describe("personality checkpoint", () => {
  test("appears only once the conversation is deep", async () => {
    const { id } = h.app.chatSvc.current();
    // Bring the thread to the depth threshold with persisted turns.
    while (h.app.chatSvc.depth(id) < 12) {
      h.app.chatSvc.append(id, "user", "quick check-in message to deepen the thread");
      h.app.chatSvc.append(id, "assistant", "Copy.");
    }
    await h.app.orchestrator.execute(INTENT.COMMAND, "how are we looking overall?");
    expect(lastSystemPrompt()).toContain("PERSONALITY CHECKPOINT");
  });
});
