import { AGENT, INTENT, err, ok } from "@nexus/core";
import { type NexusPlugin, type OpsSnapshot, definePlugin } from "@nexus/plugin-sdk";
import { renderAudit } from "./audit";

/**
 * OPS plugin — SYSTEM AUDIT: the dead-simple, deterministic self-check that
 * lets a weaker model (or the operator) verify Nexus is healthy without any
 * taste or judgment. It reads a structured snapshot from the Runner and a
 * few record counts, then prints a PASS/WARN/FAIL card with exact remedies.
 *
 * This is the "verification step" of the whole system: run it after any
 * change, any restart, or any weird behavior.
 */

// Collections whose counts prove the life-tracking data is persisting.
const COUNT_COLLECTIONS = [
  "acad.papers",
  "acad.chapters",
  "schol.items",
  "courses.items",
  "agency.leads",
  "agency.clients",
  "agency.projects",
  "agency.payments",
];

export function createOpsPlugin(deps: { introspect: () => OpsSnapshot }): NexusPlugin {
  return definePlugin({
    manifest: {
      id: "nexus.ops",
      name: "Ops",
      version: "0.1.0",
      description:
        "SYSTEM AUDIT self-check — deterministic health verdict with remedies. Zero-LLM.",
      capabilities: ["records", "fs.documents", "metrics.read", "metrics.write"],
    },
    tools: [],
    scheduledJobs: [],
    commands: [
      {
        prefix: "audit",
        intentKey: INTENT.SYS_AUDIT,
        usage: "audit",
        description: "Run the system health self-check",
      },
    ],
    intents: [
      {
        key: INTENT.SYS_AUDIT,
        label: "SYSTEM AUDIT",
        agent: AGENT.SYSTEM,
        description:
          "Verify DB, plugins, schedules, model and data are all healthy. Prints PASS/FAIL with remedies.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          try {
            ctx.step("introspect", "runner health snapshot");
            const snap = deps.introspect();
            const counts: Record<string, number> = {};
            for (const col of COUNT_COLLECTIONS) {
              const n = await ctx.records.count(col);
              if (n > 0) counts[col] = n;
            }
            const today = new Date().toISOString().slice(0, 10);
            const { body, verdict } = renderAudit(snap, counts, today);
            await ctx.metrics.record(
              "ops.audit",
              "AUDIT",
              verdict === "pass" ? 100 : verdict === "warn" ? 50 : 0,
              "%",
            );
            return ok({
              document: {
                kind: "audit",
                title: `System Audit — ${today} (${verdict.toUpperCase()})`,
                bodyMd: body,
              },
              speak:
                verdict === "pass"
                  ? "System healthy."
                  : verdict === "warn"
                    ? "System OK, with warnings."
                    : "System needs attention.",
              wire: [`OPS · audit ${verdict.toUpperCase()}`],
            });
          } catch (e) {
            return err("SYS_AUDIT", e instanceof Error ? e.message : String(e));
          }
        },
      },
    ],
  });
}
