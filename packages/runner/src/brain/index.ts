import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_SEED, KNOWLEDGE_SEEDS, MEMORY_DISCIPLINE } from "./seeds";

/**
 * The brain: identity, core knowledge, and self-knowledge assembled into a
 * TWO-BLOCK system prompt.
 *
 *  - STABLE block: identity.md + knowledge/*.md + capabilities + memory
 *    discipline. Byte-identical across consecutive turns, so Ollama's KV
 *    prefix cache re-serves it — on a local model the win is latency, not
 *    dollars, and it means the FULL personality rides on every single turn
 *    instead of being trimmed. That constant presence is the anti-drift.
 *  - DYNAMIC block: the current time and, in deep conversations, the
 *    personality checkpoint. Small, always fresh, appended last.
 *
 * All files live in `<dataDir>/brain/` and are re-read when their mtime
 * changes: edit identity.md mid-conversation and the very next reply
 * follows it. No restart, no redeploy, no programmer.
 */

export interface CapabilitySnapshot {
  model: string | null;
  intents: Array<{ label: string; description: string }>;
  commands: Array<{ prefix: string; usage: string }>;
  integrations: Array<{ provider: string; status: string }>;
  voice: { stt: boolean; tts: boolean };
}

const CHECKPOINT = `PERSONALITY CHECKPOINT — this conversation is deep, the zone where voice
drifts. Before answering, silently check your draft against IDENTITY: right
length (~150 words), status-first structure, no generic-assistant openers,
no hedging. If the draft drifts, rewrite it, then answer.`;

const CAPABILITIES_TTL_MS = 60_000;

export class BrainService {
  private identityCache: { mtimeMs: number; text: string } | null = null;
  private knowledgeCache: { key: string; text: string } | null = null;
  private capsCache: { at: number; text: string } | null = null;

  readonly identityPath: string;
  readonly knowledgeDir: string;

  constructor(
    readonly brainDir: string,
    private readonly capabilities: () => CapabilitySnapshot,
  ) {
    this.identityPath = join(brainDir, "identity.md");
    this.knowledgeDir = join(brainDir, "knowledge");
    this.ensureSeeds();
  }

  /** Write seed files only where nothing exists — never overwrite edits. */
  private ensureSeeds(): void {
    mkdirSync(this.knowledgeDir, { recursive: true });
    if (!existsSync(this.identityPath)) writeFileSync(this.identityPath, IDENTITY_SEED, "utf8");
    for (const [file, body] of Object.entries(KNOWLEDGE_SEEDS)) {
      const path = join(this.knowledgeDir, file);
      if (!existsSync(path)) writeFileSync(path, body, "utf8");
    }
  }

  private knowledgeFile(file: "user.md" | "mission.md"): { path: string; text: string } {
    const path = join(this.knowledgeDir, file);
    return {
      path,
      text: existsSync(path) ? readFileSync(path, "utf8") : (KNOWLEDGE_SEEDS[file] ?? ""),
    };
  }

  /** What `setup` reports: the operator's name and goals as written in their own files. */
  setupState(): { name: string | null; goals: string[] } {
    const user = this.knowledgeFile("user.md").text;
    const raw = user.match(/^- Name:[ \t]*(.*)$/m)?.[1]?.trim() ?? "";
    const name = raw && !raw.startsWith("(") ? raw : null;
    const goals = [...this.knowledgeFile("mission.md").text.matchAll(/^\d+\.[ \t]+(.+)$/gm)].map(
      (m) => (m[1] ?? "").trim(),
    );
    return { name, goals };
  }

  /** Sets the "- Name:" line in knowledge/user.md (adds it under the title if missing). */
  setOperatorName(name: string): void {
    const { path, text } = this.knowledgeFile("user.md");
    const line = `- Name: ${name}`;
    let next: string;
    if (/^- Name:.*$/m.test(text)) next = text.replace(/^- Name:.*$/m, line);
    else if (/^# .*\n/.test(text)) next = text.replace(/^(# .*\n)/, `$1${line}\n`);
    else next = `# Operator\n\n${line}\n${text}`;
    writeFileSync(path, next, "utf8");
  }

  /** Appends a numbered goal to knowledge/mission.md; returns its number. */
  addGoal(goal: string): number {
    const { path, text } = this.knowledgeFile("mission.md");
    const kept = text.replace(/^\(no goals yet.*\)\n?/m, "").replace(/\n*$/, "\n");
    const n = this.setupState().goals.length + 1;
    writeFileSync(path, `${kept}${n}. ${goal}\n`, "utf8");
    return n;
  }

  /** identity.md, re-read only when its mtime changes. */
  identity(): string {
    const mtimeMs = existsSync(this.identityPath) ? statSync(this.identityPath).mtimeMs : -1;
    if (!this.identityCache || this.identityCache.mtimeMs !== mtimeMs) {
      this.identityCache = {
        mtimeMs,
        text: mtimeMs < 0 ? IDENTITY_SEED : readFileSync(this.identityPath, "utf8"),
      };
    }
    return this.identityCache.text;
  }

  /** knowledge/*.md concatenated, cache keyed on the dir's file mtimes. */
  knowledge(): string {
    const files = existsSync(this.knowledgeDir)
      ? readdirSync(this.knowledgeDir)
          .filter((f) => f.endsWith(".md"))
          .sort()
      : [];
    const key = files.map((f) => `${f}:${statSync(join(this.knowledgeDir, f)).mtimeMs}`).join("|");
    if (!this.knowledgeCache || this.knowledgeCache.key !== key) {
      const text = files
        .map((f) => readFileSync(join(this.knowledgeDir, f), "utf8").trim())
        .join("\n\n")
        .trim();
      this.knowledgeCache = { key, text };
    }
    return this.knowledgeCache.text;
  }

  /** Self-knowledge, generated from what the system actually exposes. */
  capabilitiesText(): string {
    if (this.capsCache && Date.now() - this.capsCache.at < CAPABILITIES_TTL_MS)
      return this.capsCache.text;
    const c = this.capabilities();
    const connected = c.integrations.filter((i) => i.status === "connected").map((i) => i.provider);
    const lines = [
      `Model: local Ollama ${c.model ?? "(offline — typed commands still work)"}. Voice in/out: ${c.voice.stt ? "on" : "off"}/${c.voice.tts ? "on" : "off"}.`,
      `Connected integrations: ${connected.length > 0 ? connected.join(", ") : "none (all optional)"}.`,
      `Deck intents: ${c.intents.map((i) => i.label).join(" · ")}.`,
      "Typed commands (parsed by code, work with no model):",
      ...c.commands.map((x) => `- ${x.prefix}: \`${x.usage}\``),
      "You have exactly these capabilities. Never claim one that is not listed.",
    ];
    this.capsCache = { at: Date.now(), text: lines.join("\n") };
    return this.capsCache.text;
  }

  /** The cache-stable prefix: identical bytes turn after turn. */
  stableBlock(): string {
    return [
      "=== IDENTITY (source: brain/identity.md — operator-editable) ===",
      this.identity().trim(),
      "",
      "=== CORE KNOWLEDGE (curated, read-only — never re-ask these) ===",
      this.knowledge(),
      "",
      "=== CAPABILITIES (live) ===",
      this.capabilitiesText(),
      "",
      MEMORY_DISCIPLINE,
    ].join("\n");
  }

  /** Small, always-fresh suffix. `checkpoint` = deep-conversation audit. */
  dynamicBlock(opts?: { checkpoint?: boolean }): string {
    const nowLocal = new Date().toLocaleString("en-GB", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const lines = ["=== NOW ===", `Local time: ${nowLocal}`];
    if (opts?.checkpoint) {
      lines.push("", CHECKPOINT);
    }
    return lines.join("\n");
  }
}
