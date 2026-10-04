import { AGENT, INTENT, err, ok } from "@nexus/core";
import { type NexusPlugin, definePlugin } from "@nexus/plugin-sdk";
import { CHECKPOINT_DEPTH, type ChatService } from "../brain/chat";
import type { CommandRouter } from "../commands";

export interface CorePluginDeps {
  router: CommandRouter;
  /** enqueue an intent for execution (durable queue) */
  enqueue: (intentKey: string, input: string | null) => void;
  /** conversational working memory (sessions/threads) */
  chat: ChatService;
  /** first-run setup: the operator's own name and goals (brain/knowledge files) */
  setup: {
    state(): { name: string | null; goals: string[] };
    setName(name: string): void;
    addGoal(goal: string): number;
    dataDir: string;
  };
  /** module on/off — registration is boot-time, so changes apply on the next start */
  modules: {
    list(): Array<{
      id: string;
      name: string;
      description: string;
      enabled: boolean;
      optional: boolean;
    }>;
    setEnabled(id: string, enabled: boolean): void;
  };
}

type Reply = { title: string; bodyMd: string; wire: string };
const ALWAYS_ON = new Set(["nexus.core", "nexus.brain"]);
const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{0,39}$/u;
const shortName = (id: string): string => id.replace(/^nexus\./, "");

/** `setup`, `setup name …`, `setup goal …` — pure code, works with no model. */
function setupCommand(deps: CorePluginDeps, args: string): Reply {
  const [sub = "", ...rest] = args.split(/\s+/);
  const value = rest.join(" ").trim();
  if (sub.toLowerCase() === "name") {
    if (!NAME_RE.test(value))
      return {
        title: "Setup",
        bodyMd: "usage: `setup name <first name>` — letters only, up to 40 characters.",
        wire: "SETUP · bad name",
      };
    deps.setup.setName(value);
    return {
      title: "Setup",
      bodyMd: `Name set to **${value}**. Nexus will use it from the next reply. Type \`setup\` to see what's left.`,
      wire: "SETUP · name set",
    };
  }
  if (sub.toLowerCase() === "goal") {
    if (value.length < 3 || value.length > 200)
      return {
        title: "Setup",
        bodyMd:
          "usage: `setup goal <one line, 3–200 characters>` — e.g. `setup goal Ship my first app by June`",
        wire: "SETUP · bad goal",
      };
    const n = deps.setup.addGoal(value);
    return {
      title: "Setup",
      bodyMd: `Goal **${n}** added: ${value}\n\nAll goals live in \`brain/knowledge/mission.md\` — edit that file to reorder or remove them.`,
      wire: `SETUP · goal ${n}`,
    };
  }
  if (sub) {
    return {
      title: "Setup",
      bodyMd: "usage: `setup` · `setup name <first name>` · `setup goal <one line>`",
      wire: "SETUP · usage",
    };
  }
  const s = deps.setup.state();
  const optional = deps.modules.list().filter((m) => m.optional);
  const tick = (done: boolean) => (done ? "[x]" : "[ ]");
  return {
    title: "First-time setup",
    bodyMd: [
      "Nexus starts knowing nothing about you. Everything you add stays on this computer.",
      "",
      `${tick(!!s.name)} **Your name** — ${s.name ? `**${s.name}**` : "`setup name <first name>`"}`,
      `${tick(s.goals.length > 0)} **Your goals** — ${
        s.goals.length > 0
          ? `${s.goals.length} set`
          : "`setup goal <one line>` (add as many as you like)"
      }`,
      "[ ] **Health check** — `audit` (is the AI model installed? is everything wired?)",
      "",
      "**Optional modules** (off until you turn them on):",
      ...optional.map(
        (m) =>
          `- \`${shortName(m.id)}\` — ${m.enabled ? "**on**" : "off"} · ${m.description} → \`modules ${m.enabled ? "off" : "on"} ${shortName(m.id)}\``,
      ),
      "",
      `Your data folder: \`${deps.setup.dataDir}\` — database, documents and Nexus's memory. It never leaves this PC.`,
    ].join("\n"),
    wire: "SETUP · checklist",
  };
}

/** `modules`, `modules on <name>`, `modules off <name>` — pure code. */
function modulesCommand(deps: CorePluginDeps, args: string): Reply {
  const [verb = "", target = ""] = args.split(/\s+/).map((t) => t.toLowerCase());
  const all = deps.modules.list().sort((a, b) => a.id.localeCompare(b.id));
  if (verb === "on" || verb === "off") {
    const m = all.find(
      (x) => x.id.toLowerCase() === target || shortName(x.id).toLowerCase() === target,
    );
    if (!m)
      return {
        title: "Modules",
        bodyMd: `No module called \`${target || "?"}\`. Type \`modules\` for the list.`,
        wire: "MODULES · unknown",
      };
    if (ALWAYS_ON.has(m.id))
      return {
        title: "Modules",
        bodyMd: `\`${shortName(m.id)}\` is part of Nexus itself and can't be turned off.`,
        wire: "MODULES · core",
      };
    deps.modules.setEnabled(m.id, verb === "on");
    return {
      title: "Modules",
      bodyMd: `\`${shortName(m.id)}\` will be **${verb.toUpperCase()}** after Nexus restarts — close the black Nexus window and open \`Start Nexus.cmd\` again.`,
      wire: `MODULES · ${shortName(m.id)} ${verb}`,
    };
  }
  if (verb)
    return {
      title: "Modules",
      bodyMd: "usage: `modules` · `modules on <name>` · `modules off <name>`",
      wire: "MODULES · usage",
    };
  return {
    title: "Modules",
    bodyMd: [
      "| MODULE | STATE | WHAT IT DOES |",
      "|---|---|---|",
      ...all.map(
        (m) =>
          `| \`${shortName(m.id)}\`${m.optional ? " (optional)" : ""} | ${m.enabled ? "**on**" : "off"} | ${m.description} |`,
      ),
      "",
      "Turn one on or off with `modules on <name>` / `modules off <name>`; it applies after Nexus restarts.",
    ].join("\n"),
    wire: "MODULES · list",
  };
}

/**
 * Built-in core plugin: the free-form command intent used by voice and the
 * ⌘K palette.
 *
 * Routing order (durability by design):
 *  1. `help` → list every typed command (pure code).
 *  2. First word matches a registered command prefix → re-enqueue to the
 *     owning intent. Deterministic; works with NO model at all.
 *  3. Otherwise → a CONVERSATION with Nexus: session-persistent, memory-
 *     aware, in the identity's voice (needs Ollama).
 */
export function createCorePlugin(deps: CorePluginDeps): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.core",
      name: "Nexus Core",
      version: "0.3.0",
      description: "Typed command routing + the conversational Nexus voice.",
      capabilities: [
        "memory.read",
        "memory.write",
        "fs.documents",
        "llm.chat",
        "metrics.read",
        "calendar",
        "email",
      ],
    },
    tools: [],
    scheduledJobs: [],
    intents: [
      {
        key: INTENT.COMMAND,
        label: "COMMAND",
        agent: AGENT.NEXUS,
        description: "Free-form command from voice or the palette.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          const input = ctx.input?.trim();
          if (!input) return err("EMPTY_COMMAND", "no command text received");

          if (input.toLowerCase() === "help" || input.toLowerCase() === "commands") {
            const lines = deps.router
              .list()
              .map((c) => `| \`${c.prefix}\` | \`${c.usage}\` | ${c.description} |`);
            return ok({
              document: {
                kind: "help",
                title: "Typed Commands",
                bodyMd: [
                  "All commands below are parsed by **code, not AI** — they work even with the model offline.",
                  "",
                  "| PREFIX | USAGE | WHAT IT DOES |",
                  "|---|---|---|",
                  "| `setup` | `setup` · `setup name <first name>` · `setup goal <one line>` | First-time setup: tell Nexus who you are and what you're working toward. |",
                  "| `modules` | `modules` · `modules on <name>` · `modules off <name>` | List modules and turn optional ones on/off (applies after restart). |",
                  ...lines,
                  "",
                  "Anything else is a conversation with Nexus (needs Ollama).",
                ].join("\n"),
              },
              speak: null,
              wire: ["CMD · help"],
            });
          }

          const [first = "", ...restWords] = input.split(/\s+/);
          const head = first.toLowerCase();
          if (head === "setup" || head === "modules" || head === "module") {
            const r =
              head === "setup"
                ? setupCommand(deps, restWords.join(" "))
                : modulesCommand(deps, restWords.join(" "));
            return ok({
              document: { kind: "help", title: r.title, bodyMd: r.bodyMd },
              speak: null,
              wire: [r.wire],
            });
          }

          const hit = deps.router.route(input);
          if (hit) {
            ctx.step("route", `${hit.prefix} → ${hit.intentKey}`);
            deps.enqueue(hit.intentKey, input);
            return ok({
              document: null,
              speak: null,
              wire: [`CMD → ${hit.intentKey.toUpperCase()} · ${input.slice(0, 60)}`],
            });
          }

          /* ---------------- conversation with Nexus ---------------- */

          // Session bookkeeping: reuse within the idle window, rotate after
          // it — and hand a finished session to the memory extractor.
          const { id: sessionId, rotatedFrom } = deps.chat.current(input);
          if (rotatedFrom) deps.enqueue(INTENT.BRAIN_EXTRACT, rotatedFrom);
          deps.chat.append(sessionId, "user", input);

          // Long-term memory, injected only when actually relevant.
          ctx.step("recall", input.slice(0, 60));
          const hits = await ctx.memory.search(input, 4);
          const memLines = hits
            .filter((h) => h.distance <= 0.7)
            .slice(0, 3)
            .map((h) => `- [${h.kind}] ${h.text}`);

          // Bounded transcript (the just-appended user turn rides separately).
          const turns = deps.chat.window(sessionId).slice(0, -1);
          const depth = deps.chat.depth(sessionId);

          const brief = [
            turns.length > 0
              ? `CONVERSATION SO FAR:\n${turns
                  .map((t) => `${t.role === "user" ? "USER" : "NEXUS"}: ${t.content}`)
                  .join("\n")}`
              : "",
            memLines.length > 0
              ? `RELEVANT MEMORY (point-in-time — verify before acting on it):\n${memLines.join("\n")}`
              : "",
            `USER: ${input}`,
            "Reply as NEXUS, directly to the operator.",
          ]
            .filter(Boolean)
            .join("\n\n");

          const agent = await ctx.runAgent({
            agent: AGENT.NEXUS,
            brief,
            checkpoint: depth >= CHECKPOINT_DEPTH,
          });
          if (!agent.ok) return agent;

          deps.chat.append(sessionId, "assistant", agent.value.text);
          return ok({
            document: {
              kind: "chat",
              title: input.length > 48 ? `${input.slice(0, 48)}…` : input,
              bodyMd: agent.value.text,
            },
            speak: null,
            wire: [`CHAT · ${input.slice(0, 70)}`],
          });
        },
      },
    ],
  });
}
