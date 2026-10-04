import { AGENT, INTENT, err, ok } from "@nexus/core";
import { type IntentResult, type NexusPlugin, definePlugin } from "@nexus/plugin-sdk";
import { z } from "zod";
import type { ChatService } from "./chat";
import { extractSession } from "./extractor";
import type { BrainService } from "./index";
import { type BrainStore, MEMORY_TYPES, type MemoryType } from "./store";

/**
 * BRAIN plugin — the operator-facing surface of the memory system.
 *
 *  - `brain.save` tool: the assistant's DELIBERATE memory writes, gated in
 *    code by red lines + dedupe (see store.ts).
 *  - `brain …` typed command: status / save / recall / forget / reindex /
 *    extract — all pure code, works with no model.
 *  - `session …` typed command: working-memory threads (list/new/resume).
 *  - `brain.extract` hidden intent: the end-of-session extractor, enqueued
 *    automatically when a session rotates and swept at boot.
 *
 * Forgetting is HUMAN-ONLY: no tool deletes memories; only the typed
 * `brain forget <file> confirm` does.
 */

export interface BrainPluginDeps {
  brain: BrainService;
  store: BrainStore;
  chat: ChatService;
  commandPrefixes: () => string[];
  enqueue: (intentKey: string, input: string | null) => void;
}

const doc = (
  title: string,
  bodyMd: string,
  wire: string[] = [],
  speak: string | null = null,
): IntentResult => ({
  document: { kind: "brain", title, bodyMd },
  speak,
  wire,
});

const USAGE = [
  "| COMMAND | WHAT |",
  "|---|---|",
  "| `brain` | Status: identity/knowledge paths, memory counts, extraction state |",
  "| `brain save <type> \\| <hook> \\| <body>` | Save a memory yourself (types: user, preference, project, reference) |",
  "| `brain recall <query>` | Search long-term memory |",
  "| `brain forget <file> confirm` | Delete one memory file (human-only) |",
  "| `brain reindex` | Rebuild the search index from the files |",
  "| `brain extract` | Run the end-of-session extractor on idle sessions now |",
  "| `session` | Current + recent conversations |",
  "| `session new` | Start a fresh conversation (finished one gets extracted) |",
  "| `session resume <id>` | Switch back into a recent conversation |",
].join("\n");

export function createBrainPlugin(deps: BrainPluginDeps): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.brain",
      name: "Brain",
      version: "0.1.0",
      description: "Identity, core knowledge, sessions and file-backed long-term memory.",
      capabilities: ["memory.read", "memory.write", "fs.documents", "llm.chat"],
    },
    scheduledJobs: [],
    commands: [
      {
        prefix: "brain",
        intentKey: INTENT.BRAIN_CMD,
        usage: "brain [save|recall|forget|reindex|extract]",
        description: "Memory system controls",
      },
      {
        prefix: "session",
        intentKey: INTENT.BRAIN_CMD,
        usage: "session [new|resume <id>]",
        description: "Conversation threads",
      },
    ],
    tools: [
      {
        name: "brain.save",
        description:
          "Save ONE durable long-term memory. Use only for things the operator taught you, corrections, preferences, or project decisions. Never transient state, never health/personal-life, never money amounts, never secrets.",
        capability: "memory.write",
        inputSchema: z.object({
          type: z.enum(MEMORY_TYPES),
          hook: z.string().min(8).max(120).describe("one-line searchable summary"),
          body: z.string().min(1).max(600).describe("why it matters and how to apply it"),
        }),
        async execute(input, _ctx) {
          const res = await deps.store.save(input.type, input.hook, input.body);
          return res.saved ? ok(`Memory saved (${res.file}).`) : ok(`Not saved — ${res.reason}.`);
        },
      },
    ],
    intents: [
      {
        key: INTENT.BRAIN_CMD,
        label: "BRAIN CMD",
        agent: AGENT.SYSTEM,
        description: "Typed brain/session commands — parsed by code, no AI.",
        scheduleCron: null,
        requiresIntegration: null,
        hidden: true,
        async handler(ctx) {
          try {
            const line = (ctx.input ?? "").trim();
            const tokens = line.split(/\s+/);
            const head = (tokens[0] ?? "").toLowerCase();
            if (head === "session") return ok(handleSession(deps, tokens.slice(1)));
            return ok(await handleBrain(deps, ctx, line, tokens.slice(1)));
          } catch (e) {
            return err("BRAIN_CMD", e instanceof Error ? e.message : String(e));
          }
        },
      },
      {
        key: INTENT.BRAIN_EXTRACT,
        label: "BRAIN EXTRACT",
        agent: AGENT.SYSTEM,
        description: "End-of-session memory extraction (automatic; also `brain extract`).",
        scheduleCron: null,
        requiresIntegration: null,
        hidden: true,
        async handler(ctx) {
          const target = (ctx.input ?? "pending").trim();
          const ids =
            target === "pending" || target === "" ? deps.chat.pendingExtraction() : [target];
          if (ids.length === 0) return ok({ document: null, speak: null, wire: [] });
          const wire: string[] = [];
          let savedTotal = 0;
          for (const id of ids) {
            const outcome = await extractSession(
              { chat: deps.chat, store: deps.store, commandPrefixes: deps.commandPrefixes },
              ctx,
              id,
            );
            savedTotal += outcome.saved.length;
            for (const hook of outcome.saved) wire.push(`BRAIN · remembered: ${hook.slice(0, 70)}`);
          }
          return ok({
            document:
              savedTotal > 0
                ? {
                    kind: "brain",
                    title: `Memory formed — ${savedTotal} new`,
                    bodyMd: wire
                      .map((w) => `- ${w.replace("BRAIN · remembered: ", "")}`)
                      .join("\n"),
                  }
                : null,
            speak: null,
            wire,
          });
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */

function handleSession(deps: BrainPluginDeps, args: string[]): IntentResult {
  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "new") {
    const { id, rotatedFrom } = deps.chat.startNew();
    if (rotatedFrom) deps.enqueue(INTENT.BRAIN_EXTRACT, rotatedFrom);
    return doc(
      "Fresh conversation",
      `New session \`${id.slice(0, 8)}\` started. The previous one goes to the memory extractor.`,
      ["BRAIN · session new"],
    );
  }

  if (sub === "resume") {
    const res = deps.chat.resume(args[1] ?? "");
    return res.ok
      ? doc(
          `Resumed: ${res.title}`,
          `Back in session \`${res.id?.slice(0, 8)}\` — context restored from its transcript.`,
          ["BRAIN · session resumed"],
        )
      : doc("Session — not found", "No session matches that id. See `session` for the list.");
  }

  const recent = deps.chat.listRecent(6);
  const lines = [
    "| ID | TITLE | TURNS | LAST ACTIVITY |",
    "|---|---|---|---|",
    ...recent.map(
      (s) =>
        `| \`${s.id.slice(0, 8)}\` | ${s.title} | ${s.turns} | ${s.updatedAt.slice(0, 16).replace("T", " ")} |`,
    ),
    "",
    "Resume one: `session resume <id>` · start fresh: `session new`",
  ];
  return doc(
    "Conversations",
    recent.length > 0 ? lines.join("\n") : "No conversations yet — just talk to me in the palette.",
  );
}

async function handleBrain(
  deps: BrainPluginDeps,
  ctx: Parameters<NexusPlugin["intents"][number]["handler"]>[0],
  line: string,
  args: string[],
): Promise<IntentResult> {
  const sub = (args[0] ?? "status").toLowerCase();

  if (sub === "status" || sub === "") {
    const mems = deps.store.list();
    const byType = new Map<string, number>();
    for (const m of mems) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
    const pending = deps.chat.pendingExtraction().length;
    return doc(
      "Brain status",
      [
        `**Identity:** \`${deps.brain.identityPath}\` — edit it and the very next reply follows.`,
        `**Knowledge:** \`${deps.brain.knowledgeDir}\` — curated facts, loaded every turn.`,
        `**Memories:** ${mems.length} file(s)${byType.size > 0 ? ` (${[...byType.entries()].map(([t, n]) => `${t}: ${n}`).join(", ")})` : ""} — index at \`memories/INDEX.md\`.`,
        `**Extraction:** ${pending} session(s) awaiting the extractor.`,
        "",
        USAGE,
      ].join("\n"),
    );
  }

  if (sub === "save") {
    const parts = line
      .replace(/^brain\s+save\s+/i, "")
      .split("|")
      .map((s) => s.trim());
    const type = (parts[0] ?? "").toLowerCase() as MemoryType;
    const hook = parts[1] ?? "";
    const body = parts.slice(2).join(" | ");
    if (!MEMORY_TYPES.includes(type) || !hook) {
      return doc(
        "Brain — bad save",
        `usage: \`brain save <${MEMORY_TYPES.join("|")}> | <hook> | <body>\``,
      );
    }
    const res = await deps.store.save(type, hook, body || hook, { human: true });
    return res.saved
      ? doc(`Remembered: ${hook.slice(0, 50)}`, `Saved to \`${res.file}\`.`, [
          `BRAIN · saved ${hook.slice(0, 60)}`,
        ])
      : doc("Not saved", res.reason);
  }

  if (sub === "recall") {
    const query = args.slice(1).join(" ");
    if (!query) return doc("Brain — bad recall", "usage: `brain recall <query>`");
    const hits = await ctx.memory.search(query, 6);
    if (hits.length === 0) return doc("Recall — nothing", `No memory matches "${query}".`);
    return doc(
      `Recall: ${query.slice(0, 40)}`,
      hits
        .map(
          (h) =>
            `- **[${h.kind}]** ${h.text}${h.source.startsWith("brain:") ? ` — \`${h.source.slice(6)}\`` : ""}`,
        )
        .join("\n"),
    );
  }

  if (sub === "forget") {
    const file = args[1] ?? "";
    if ((args[2] ?? "").toLowerCase() !== "confirm") {
      return doc(
        "Forget — confirmation required",
        `This deletes the file permanently. Re-run as:\n\n\`brain forget ${file || "<file>"} confirm\``,
      );
    }
    return deps.store.forget(file)
      ? doc(`Forgotten: ${file}`, "File deleted; index updated.", [`BRAIN · forgot ${file}`])
      : doc(
          "Forget — not found",
          `No memory file \`${file}\`. See \`brain\` for the index location.`,
        );
  }

  if (sub === "reindex") {
    const res = await deps.store.reindex();
    return doc(
      "Reindex complete",
      `${res.files} file(s) re-indexed${res.embedded ? " with embeddings" : " (keyword-only — embed model unavailable, will backfill)"}. The files were the source of truth; nothing was lost.`,
      ["BRAIN · reindex"],
    );
  }

  if (sub === "extract") {
    deps.enqueue(INTENT.BRAIN_EXTRACT, "pending");
    return doc(
      "Extractor queued",
      "Idle sessions are being processed — new memories will appear on the wire.",
      ["BRAIN · extract queued"],
    );
  }

  return doc("Brain — commands", USAGE);
}
