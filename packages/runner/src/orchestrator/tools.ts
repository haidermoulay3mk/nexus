import { ok } from "@nexus/core";
import type { ToolSpec } from "@nexus/plugin-sdk";
import { z } from "zod";

/**
 * Core tools available to agents (subject to each plugin's capability
 * grants and the per-agent allowlist). Tools are the ONLY way agents
 * touch the world; every call is audited by the orchestrator.
 */
export const CORE_TOOLS: ToolSpec[] = [
  {
    name: "memory.search",
    description: "Semantic search over long-term memory. Returns the closest stored facts/notes.",
    capability: "memory.read",
    inputSchema: z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(12).default(6),
    }),
    async execute(input, ctx) {
      const hits = await ctx.memory.search(input.query, input.k);
      if (hits.length === 0) return ok("No memories found.");
      return ok(
        hits.map((h) => `- [${h.kind}] ${h.text} (src: ${h.source || "unknown"})`).join("\n"),
      );
    },
  },
  {
    name: "memory.write",
    description: "Store a durable fact, preference, entity, or note in long-term memory.",
    capability: "memory.write",
    inputSchema: z.object({
      kind: z.enum(["fact", "pref", "entity", "note"]),
      text: z.string().min(3),
    }),
    async execute(input, ctx) {
      const id = await ctx.memory.write(input.kind, input.text, `run:${ctx.intentKey}`);
      return ok(`Stored memory ${id}.`);
    },
  },
  {
    name: "fs.writeDocument",
    description: "Write a markdown document into the local vault (persisted + shown in the trail).",
    capability: "fs.documents",
    inputSchema: z.object({
      kind: z.string().default("note"),
      title: z.string().min(1),
      bodyMd: z.string().min(1),
    }),
    async execute(input, ctx) {
      const doc = await ctx.documents.write(input.kind, input.title, input.bodyMd);
      return ok(`Document written: ${doc.id}`);
    },
  },
  {
    name: "metrics.all",
    description: "Read all current system vitals/metrics with their recent series.",
    capability: "metrics.read",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const all = await ctx.metrics.all();
      if (all.length === 0) return ok("No metrics recorded yet.");
      return ok(
        all
          .map(
            (m) =>
              `${m.label}: ${m.value}${m.unit}${m.delta != null ? ` (Δ ${m.delta >= 0 ? "+" : ""}${m.delta})` : ""} series=[${m.series.slice(-8).join(",")}]`,
          )
          .join("\n"),
      );
    },
  },
  {
    name: "directives.list",
    description: "List the user's open directives (top priorities).",
    capability: "memory.read",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const list = await ctx.directives.list(false);
      if (list.length === 0) return ok("No open directives.");
      return ok(list.map((d) => `- [p${d.priority}] ${d.text}`).join("\n"));
    },
  },
  {
    name: "runs.recent",
    description: "List recent completed runs (episodic memory) — what Nexus has done lately.",
    capability: "memory.read",
    inputSchema: z.object({ limit: z.number().int().min(1).max(30).default(10) }),
    async execute(input, ctx) {
      const hits = await ctx.memory.recent("episode", input.limit);
      if (hits.length === 0) return ok("No recorded episodes yet.");
      return ok(hits.map((h) => `- ${h.text}`).join("\n"));
    },
  },
];
