import { AGENT, INTENT, ok } from "@nexus/core";
import { type NexusPlugin, type RunContext, definePlugin } from "@nexus/plugin-sdk";

/**
 * REPORTS plugin — the Scribe/Planner intents.
 * AM REPORT (scheduled daily 08:00), WK REVIEW, PLAN TODAY, PLAN TMRW.
 * All four are fully local: they read memory, directives, metrics and the
 * episodic log. Calendar context is used opportunistically when connected.
 */
export function createReportsPlugin(): NexusPlugin {
  const gatherLocalContext = async (ctx: RunContext): Promise<string> => {
    const [directives, metrics, episodes] = await Promise.all([
      ctx.directives.list(false),
      ctx.metrics.all(),
      ctx.memory.recent("note", 8),
    ]);
    return [
      "OPEN DIRECTIVES:",
      directives.length > 0
        ? directives.map((d) => `- [p${d.priority}] ${d.text}`).join("\n")
        : "- none",
      "",
      "VITALS:",
      metrics.length > 0
        ? metrics.map((m) => `- ${m.label}: ${m.value}${m.unit} (Δ ${m.delta ?? 0})`).join("\n")
        : "- none recorded",
      "",
      "RECENT EPISODES:",
      episodes.length > 0 ? episodes.map((e) => `- ${e.text}`).join("\n") : "- none",
    ].join("\n");
  };

  return definePlugin({
    manifest: {
      id: "nexus.reports",
      name: "Reports",
      version: "0.1.0",
      description: "Morning report, weekly review, and day planning.",
      capabilities: ["memory.read", "memory.write", "metrics.read", "fs.documents", "llm.chat"],
    },
    tools: [],
    scheduledJobs: [{ id: "am-report-daily", cron: "0 8 * * *", intentKey: INTENT.AM_REPORT }],
    intents: [
      {
        key: INTENT.AM_REPORT,
        label: "AM REPORT",
        agent: AGENT.SCRIBE,
        description: "Morning report: status, signals, priorities. Runs daily at 08:00.",
        scheduleCron: "0 8 * * *",
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("context", "gathering local state");
          const context = await gatherLocalContext(ctx);
          const agent = await ctx.runAgent({
            agent: AGENT.SCRIBE,
            brief: `Compose the MORNING REPORT for ${new Date().toDateString()}.\n\n${context}\n\nIf a calendar tool is available, check today's events first. Structure: STATUS → SIGNALS → PRIORITIES → NOTES.`,
            tools: [
              "memory.search",
              "metrics.all",
              "directives.list",
              "runs.recent",
              "calendar.today",
            ],
          });
          if (!agent.ok) return agent;
          return ok({
            document: {
              kind: "report",
              title: `Morning Report — ${new Date().toISOString().slice(0, 10)}`,
              bodyMd: agent.value.text,
            },
            speak: "Morning report ready.",
            wire: ["REPORT · morning report compiled"],
          });
        },
      },
      {
        key: INTENT.WK_REVIEW,
        label: "WK REVIEW",
        agent: AGENT.SCRIBE,
        description: "Weekly review over the last 7 days of runs, documents and metrics.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          ctx.step("context", "collecting the week");
          const docs = await ctx.documents.recent(20);
          const context = await gatherLocalContext(ctx);
          const agent = await ctx.runAgent({
            agent: AGENT.SCRIBE,
            brief: `Compose the WEEKLY REVIEW.\n\n${context}\n\nDOCUMENTS PRODUCED THIS WEEK:\n${
              docs.length > 0
                ? docs
                    .map((d) => `- [${d.kind}] ${d.title} (${d.createdAt.slice(0, 10)})`)
                    .join("\n")
                : "- none"
            }\n\nAssess momentum honestly: what moved, what stalled, one recommendation for next week.`,
            tools: ["memory.search", "metrics.all", "runs.recent"],
          });
          if (!agent.ok) return agent;
          return ok({
            document: {
              kind: "review",
              title: `Weekly Review — ${new Date().toISOString().slice(0, 10)}`,
              bodyMd: agent.value.text,
            },
            speak: "Weekly review complete.",
            wire: ["REVIEW · weekly review compiled"],
          });
        },
      },
      {
        key: INTENT.PLAN_TODAY,
        label: "PLAN TODAY",
        agent: AGENT.PLANNER,
        description:
          "Concrete prioritized plan for today from directives + memory (+ calendar when connected).",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          return planDay(ctx, "today");
        },
      },
      {
        key: INTENT.PLAN_TMRW,
        label: "PLAN TMRW",
        agent: AGENT.PLANNER,
        description: "Prioritized plan for tomorrow.",
        scheduleCron: null,
        requiresIntegration: null,
        async handler(ctx) {
          return planDay(ctx, "tomorrow");
        },
      },
    ],
  });

  async function planDay(ctx: RunContext, day: "today" | "tomorrow") {
    ctx.step("context", `planning ${day}`);
    const context = await gatherLocalContext(ctx);
    const agent = await ctx.runAgent({
      agent: AGENT.PLANNER,
      brief: `Build the plan for ${day} (${new Date().toDateString()}).\n\n${context}\n\nIf a calendar tool is available, honor scheduled events. 3–7 verb-first items, flag the single top priority with ★.`,
      tools: ["memory.search", "directives.list", "calendar.today"],
    });
    if (!agent.ok) return agent;
    const title = day === "today" ? "Plan Today" : "Plan Tomorrow";
    return ok({
      document: {
        kind: "plan",
        title: `${title} — ${new Date().toISOString().slice(0, 10)}`,
        bodyMd: agent.value.text,
      },
      speak: `${title} is ready.`,
      wire: [`PLAN · ${day} plan compiled`],
    });
  }
}
