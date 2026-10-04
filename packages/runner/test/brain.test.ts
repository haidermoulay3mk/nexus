import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainService } from "../src/brain";
import { looksLikeCommands, parseExtractorReply } from "../src/brain/extractor";
import {
  hookOverlap,
  parseMemoryFile,
  redLineViolation,
  renderMemoryFile,
} from "../src/brain/store";

/** Pure-logic coverage: everything here must behave identically on any model. */

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "nexus-brain-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold locks briefly; OS temp cleaner reclaims */
    }
  }
});

const CAPS = {
  model: "test-model",
  intents: [{ label: "A-LEVEL BOARD", description: "board" }],
  commands: [{ prefix: "paper", usage: "paper 9702 s23 22 48/60" }],
  integrations: [{ provider: "google", status: "connected" }],
  voice: { stt: false, tts: false },
};

describe("red lines (code-enforced, model-independent)", () => {
  test("secrets, health and money are caught; normal facts pass", () => {
    expect(redLineViolation("the API key is sk-123")).toContain("secrets");
    expect(redLineViolation("Sam mentioned feeling sick before the exam")).toContain("health");
    expect(redLineViolation("agency revenue hit $500 this month")).toContain("money");
    expect(redLineViolation("Sam prefers revision lists capped at three items")).toBeNull();
    expect(redLineViolation("his school uses the CAIE March series")).toBeNull();
  });
});

describe("memory file format", () => {
  test("render → parse round-trip", () => {
    const raw = renderMemoryFile({
      type: "preference",
      hook: "Keep revision lists to three items",
      body: "Longer lists overwhelm; cap revise output.",
      created: "2026-07-08T00:00:00Z",
    });
    const parsed = parseMemoryFile("preference-keep.md", raw);
    expect(parsed?.type).toBe("preference");
    expect(parsed?.hook).toBe("Keep revision lists to three items");
    expect(parsed?.body).toContain("overwhelm");
  });

  test("corrupt files parse to null instead of throwing", () => {
    expect(parseMemoryFile("x.md", "just some text")).toBeNull();
    expect(parseMemoryFile("x.md", "---\ntype: banana\nhook: h\n---\nbody")).toBeNull();
  });

  test("hook overlap ratio for embedding-less dedupe", () => {
    expect(
      hookOverlap("Sam prefers dark editor themes", "prefers dark themes in his editor"),
    ).toBeGreaterThanOrEqual(0.7);
    expect(
      hookOverlap("Sam prefers dark editor themes", "the agency launches in March"),
    ).toBeLessThan(0.3);
  });
});

describe("extractor parsing (tolerant of small-model output)", () => {
  test("recovers a JSON array wrapped in prose", () => {
    const out = parseExtractorReply(
      'Sure! Here you go: [{"type":"preference","hook":"Sam wants numbers-first answers","body":"status then detail"}] hope that helps',
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("preference");
  });

  test("garbage, empty arrays and bad shapes yield []", () => {
    expect(parseExtractorReply("no json here")).toEqual([]);
    expect(parseExtractorReply("[]")).toEqual([]);
    expect(parseExtractorReply('[{"type":"nope","hook":"x","body":"y"}]')).toEqual([]);
  });

  test("caps at three memories per session", () => {
    const item = '{"type":"user","hook":"a fact about the operator here","body":"b"}';
    expect(parseExtractorReply(`[${item},${item},${item},${item},${item}]`)).toHaveLength(3);
  });

  test("command-heavy sessions are recognized as not-conversation", () => {
    const t =
      "USER: paper 9702 s23 22 48/60\nNEXUS: logged\nUSER: board\nNEXUS: here\nUSER: revise\nNEXUS: ok";
    expect(looksLikeCommands(t, ["paper", "board", "revise"])).toBe(true);
    const chat =
      "USER: how are my weak chapters\nNEXUS: kinematics 1.7\nUSER: thanks, cap lists at three\nNEXUS: noted";
    expect(looksLikeCommands(chat, ["paper", "board", "revise"])).toBe(false);
  });
});

describe("BrainService — living identity + two-block prompt", () => {
  test("seeds on first boot, never overwrites, re-reads on edit", async () => {
    const dir = tmp();
    const brain = new BrainService(dir, () => CAPS);
    expect(readFileSync(join(dir, "identity.md"), "utf8")).toContain("mission-control");
    expect(brain.identity()).toContain("NEXUS");

    await new Promise((r) => setTimeout(r, 15)); // ensure a distinct mtime
    writeFileSync(join(dir, "identity.md"), "# NEXUS\n\nSpeak only in haiku.\n", "utf8");
    expect(brain.identity()).toContain("haiku"); // picked up with no restart

    // a second construction must NOT restore the seed over the edit
    new BrainService(dir, () => CAPS);
    expect(readFileSync(join(dir, "identity.md"), "utf8")).toContain("haiku");
  });

  test("stable block carries identity + knowledge + capabilities + discipline", () => {
    const brain = new BrainService(tmp(), () => CAPS);
    const block = brain.stableBlock();
    expect(block).toContain("=== IDENTITY");
    expect(block).toContain("=== CORE KNOWLEDGE");
    expect(block).toContain("# Mission"); // seeded knowledge
    expect(block).toContain("paper 9702 s23 22 48/60"); // generated self-knowledge
    expect(block).toContain("Never claim one that is not listed");
    expect(block).toContain("Memory discipline");
    // byte-stable across consecutive calls → Ollama prefix cache can hold
    expect(brain.stableBlock()).toBe(block);
  });

  test("dynamic block is fresh and checkpoint appears only when asked", () => {
    const brain = new BrainService(tmp(), () => CAPS);
    expect(brain.dynamicBlock()).toContain("Local time:");
    expect(brain.dynamicBlock()).not.toContain("PERSONALITY CHECKPOINT");
    expect(brain.dynamicBlock({ checkpoint: true })).toContain("PERSONALITY CHECKPOINT");
  });

  test("knowledge edits invalidate the cache by mtime", async () => {
    const dir = tmp();
    const brain = new BrainService(dir, () => CAPS);
    expect(brain.knowledge()).not.toContain("Falcon 9");
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(
      join(dir, "knowledge", "extra.md"),
      "# Extra\n\nSam's favorite rocket is Falcon 9.\n",
      "utf8",
    );
    expect(brain.knowledge()).toContain("Falcon 9");
  });
});

describe("first-run setup — a fresh install knows nobody", () => {
  test("seeds carry no name, no goals and no personal details", () => {
    const dir = tmp();
    const brain = new BrainService(dir, () => CAPS);
    expect(brain.setupState()).toEqual({ name: null, goals: [] });
    const all = `${brain.identity()}\n${brain.knowledge()}`;
    // nothing about any particular person: no subjects, exams, businesses or plans
    for (const personal of ["CAIE", "A Level", "9702", "agency", "scholarship"]) {
      expect(all.toLowerCase()).not.toContain(personal.toLowerCase());
    }
    expect(all).toContain("setup name <first name>");
  });

  test("setup name / goal write the operator's own files and survive a restart", () => {
    const dir = tmp();
    const brain = new BrainService(dir, () => CAPS);
    brain.setOperatorName("Sam");
    expect(brain.addGoal("Ship my first app by June")).toBe(1);
    expect(brain.addGoal("Read 12 books this year")).toBe(2);
    brain.setOperatorName("Samira"); // replaces, never duplicates
    const again = new BrainService(dir, () => CAPS);
    expect(again.setupState()).toEqual({
      name: "Samira",
      goals: ["Ship my first app by June", "Read 12 books this year"],
    });
    const user = readFileSync(join(dir, "knowledge", "user.md"), "utf8");
    expect(user.match(/- Name:/g)).toHaveLength(1);
    expect(readFileSync(join(dir, "knowledge", "mission.md"), "utf8")).not.toContain(
      "no goals yet",
    );
    expect(again.knowledge()).toContain("- Name: Samira");
  });
});
