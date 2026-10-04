import { AGENT, INTENT, ok } from "@nexus/core";
import { type NexusPlugin, definePlugin } from "@nexus/plugin-sdk";

interface MetricsDeps {
  maintenance: () => { prunedTasks: number; prunedRuns: number; prunedWire: number };
}

/**
 * METRICS plugin — SYSTEM VITALS + maintenance.
 * Intents: METRICS PULL (Analyst readout), VAULT CLEAN (local maintenance).
 * Fully local: works with zero integrations and zero network.
 */
export function createMetricsPlugin(deps: MetricsDeps): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.metrics",
      name: "Metrics",
      version: "0.1.0",
      description: "System vitals collection, analyst readouts, vault maintenance.",
      capabilities: [
        "metrics.read",
        "metrics.write",
        "memory.read",
        "memory.write",
        "fs.documents",
        "llm.chat",
      ],
    },
    tools: [],
    scheduledJobs: [],
    intents: [
      {
        key: INTENT.METRICS_PULL,
        label: "METRICS PULL",
        agent: AGENT.ANALYST,
        description: "Snapshot all system vitals and produce an analyst readout.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("collect", "sampling local vitals");
          // Local, always-available vitals — recorded before analysis so the
          // sparklines move even with zero integrations.
          const docs = await ctx.documents.recent(100);
          const episodes = await ctx.memory.recent("note", 100);
          await ctx.metrics.record("nexus.documents", "DOCUMENTS", docs.length, "");
          await ctx.metrics.record("nexus.memories", "MEMORY NODES", episodes.length, "");
          const all = await ctx.metrics.all();

          const agent = await ctx.runAgent({
            agent: AGENT.ANALYST,
            brief: `Produce a metrics readout. Current vitals:\n${all
              .map(
                (m) =>
                  `${m.label}: ${m.value}${m.unit} (Δ ${m.delta ?? 0}) series=[${m.series.slice(-8).join(",")}]`,
              )
              .join(
                "\n",
              )}\n\nCall out the biggest mover and any flatlines. Keep it under 180 words.`,
            tools: ["metrics.all", "memory.search"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: { kind: "metrics", title: "Metrics Pull", bodyMd: agent.value.text },
            speak: "Metrics pull complete.",
            wire: ["METRICS · vitals snapshot recorded"],
          });
        },
      },
      {
        key: INTENT.VAULT_CLEAN,
        label: "VAULT CLEAN",
        agent: AGENT.SYSTEM,
        description: "Prune old tasks, runs and wire items; vacuum the database.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("maintenance", "pruning + vacuum");
          const r = deps.maintenance();
          const body = [
            "## VAULT MAINTENANCE",
            "",
            `- pruned tasks: **${r.prunedTasks}**`,
            `- pruned runs: **${r.prunedRuns}**`,
            `- pruned wire items: **${r.prunedWire}**`,
            "- database vacuumed",
          ].join("\n");
          return ok({
            document: { kind: "maintenance", title: "Vault Clean", bodyMd: body },
            speak: "Vault clean complete.",
            wire: [`VAULT · cleaned ${r.prunedTasks + r.prunedRuns + r.prunedWire} stale records`],
          });
        },
      },
    ],
  });
}
