import { createAcademicsPlugin } from "@nexus/plugin-academics";
import { createAgencyPlugin } from "@nexus/plugin-agency";
import { createCalendarPlugin } from "@nexus/plugin-calendar";
import { createCoursesPlugin } from "@nexus/plugin-courses";
import { createEmailPlugin } from "@nexus/plugin-email";
import { createIntelPlugin } from "@nexus/plugin-intel";
import { createMetricsPlugin } from "@nexus/plugin-metrics";
import { createNotionPlugin } from "@nexus/plugin-notion";
import { createOpsPlugin } from "@nexus/plugin-ops";
import { createReportsPlugin } from "@nexus/plugin-reports";
import { createScholarshipsPlugin } from "@nexus/plugin-scholarships";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createServer } from "./server";

/**
 * NEXUS RUNNER — the always-on sidecar.
 * Owns the DB, the queue, the scheduler, the agents, and the WS bus.
 * Bound strictly to 127.0.0.1; authenticated by a shared token.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[runner] data dir: ${cfg.dataDir}`);

  const app = await buildApp(cfg, {
    nativePlugins: [
      // Life-tracking suite (v0.2) — deterministic, LLM-optional.
      () => createAcademicsPlugin(),
      () => createScholarshipsPlugin(),
      () => createCoursesPlugin(),
      () => createAgencyPlugin(),
      (deps) => createOpsPlugin({ introspect: deps.introspect }),
      // Original operations plugins.
      (deps) => createMetricsPlugin(deps),
      () => createReportsPlugin(),
      () => createIntelPlugin(),
      (deps) => createCalendarPlugin(deps),
      (deps) => createEmailPlugin(deps),
      (deps) => createNotionPlugin(deps),
    ],
  });

  const server = createServer(app);
  console.log(`[runner] ALIVE on http://${cfg.host}:${cfg.port} (loopback only)`);

  const stop = () => {
    console.log("[runner] shutting down…");
    server.stop(true);
    app.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error("[runner] fatal boot error:", e);
  process.exit(1);
});
