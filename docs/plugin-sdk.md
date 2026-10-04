# Nexus Plugin SDK

Every core feature of Nexus (metrics, reports, intel, calendar, email, notion) is itself a plugin — the SDK is dogfooded, not decorative.

## Anatomy

```ts
import { AGENT, INTENT, ok } from "@nexus/core";
import { definePlugin } from "@nexus/plugin-sdk";

export function createMyPlugin(): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "my.plugin",
      name: "My Plugin",
      version: "0.1.0",
      description: "…",
      capabilities: ["memory.read", "fs.documents", "llm.chat"], // requested grants
      secretKeys: ["myservice.token"],                            // vault keys it may touch
    },
    intents: [{
      key: "my.intent",
      label: "MY INTENT",              // COMMAND DECK button text
      agent: AGENT.SCRIBE,             // which agent profile runs it
      description: "…",
      scheduleCron: "0 9 * * 1",       // optional cron (croner syntax)
      requiresIntegration: null,       // or "email" | "calendar" | "notion"
      async handler(ctx) {
        const agent = await ctx.runAgent({
          agent: AGENT.SCRIBE,
          brief: "the task briefing…",
          tools: ["memory.search"],    // per-run tool allowlist
        });
        if (!agent.ok) return agent;
        return ok({
          document: { kind: "report", title: "…", bodyMd: agent.value.text },
          speak: "Done.",              // Piper TTS line (or null)
          wire: ["MY · one-line wire entry"],
        });
      },
    }],
    tools: [{
      name: "my.tool",                 // agent-callable, namespaced
      description: "…",
      capability: "net.fetch",         // gate
      inputSchema: z.object({ q: z.string() }),
      async execute(input, ctx) { return ok("result text for the model"); },
    }],
    scheduledJobs: [],                 // extra crons beyond intent-level ones
  });
}
```

## RunContext services (all capability-gated + audited)

| Service | Capability | What |
|---|---|---|
| `ctx.memory` | `memory.read/write` | semantic search, recents, durable writes |
| `ctx.documents` | `fs.documents` | write/read vault markdown (trail + cards) |
| `ctx.metrics` | `metrics.read/write` | vitals readouts + sparkline series |
| `ctx.llm.complete` | `llm.chat` | single completion on the tier model |
| `ctx.runAgent` | (agent's tools) | full multi-step tool loop, streamed to the HUD |
| `ctx.net.fetchCached` | `net.fetch` | cached fetch — live online, cache offline |
| `ctx.directives` | — | operator checklist |
| `ctx.secrets` | manifest `secretKeys` | vault-backed secrets (reads audited) |
| `ctx.step(name)` | — | trace line on the run timeline |
| `ctx.signal` | — | cooperative cancellation |

## Third-party plugins (Extism WASM)

Drop a folder into `<dataDir>/plugins/`:

```
myplugin/
├─ nexus-plugin.json   # { id, name, version, description, capabilities }
└─ plugin.wasm         # exports: describe() and run(json) → IntentResult json
```

WASM plugins are **disabled with zero grants** until the user enables them. They run sandboxed with no filesystem, no network, no host functions; their output is shape-sanitized before materialization. v1 ABI:

- `describe() → { intents: [{ key, label, description }] }`
- `run({ intentKey, input }) → { document|null, speak|null, wire[] }`
