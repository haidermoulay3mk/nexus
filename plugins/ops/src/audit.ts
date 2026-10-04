import type { OpsSnapshot } from "@nexus/plugin-sdk";

/**
 * Pure audit logic — takes a health snapshot, returns a list of checks with
 * a verdict and a concrete remedy. No I/O, no LLM: unit-tested and identical
 * on every model. The remedies are the operator's runbook, inline.
 */

export type Level = "pass" | "warn" | "fail";

export interface Check {
  level: Level;
  name: string;
  detail: string;
  /** what to do about it — empty when passing */
  remedy: string;
}

/** Tables every healthy Nexus DB must have. Missing = migration didn't run. */
export const REQUIRED_TABLES = [
  "settings",
  "intents",
  "runs",
  "tasks",
  "documents",
  "memories",
  "metrics",
  "plugins",
  "audit",
  "plugin_records",
];

/** First-party plugins that must always be loaded and enabled. Optional modules
 *  (academics, scholarships, agency) are the operator's choice — never a failure. */
export const REQUIRED_PLUGINS = ["nexus.core", "nexus.courses", "nexus.ops"];

/** Scheduled jobs that must be registered (id substring) — only while their plugin is on. */
export const REQUIRED_SCHEDULES: Array<{ job: string; plugin: string }> = [
  { job: "scholarships.sweep", plugin: "nexus.scholarships" },
  { job: "courses.check", plugin: "nexus.courses" },
];

const glyph: Record<Level, string> = { pass: "✓", warn: "⚠", fail: "✗" };

export function runAudit(
  snap: OpsSnapshot,
  recordCounts: Record<string, number>,
): { checks: Check[]; verdict: Level } {
  const checks: Check[] = [];

  // 1. DB integrity
  const missingTables = REQUIRED_TABLES.filter((t) => !snap.dbTables.includes(t));
  checks.push(
    missingTables.length === 0
      ? {
          level: "pass",
          name: "DATABASE",
          detail: `${snap.dbTables.length} tables present`,
          remedy: "",
        }
      : {
          level: "fail",
          name: "DATABASE",
          detail: `missing tables: ${missingTables.join(", ")}`,
          remedy:
            "Restart the Runner — migrations run at boot. If it persists, see MAINTENANCE.md → 'Database looks wrong'.",
        },
  );

  // 2. Plugins loaded + enabled
  const byId = new Map(snap.plugins.map((p) => [p.id, p]));
  const missingPlugins = REQUIRED_PLUGINS.filter((id) => !byId.get(id)?.enabled);
  checks.push(
    missingPlugins.length === 0
      ? {
          level: "pass",
          name: "PLUGINS",
          detail: `${snap.plugins.filter((p) => p.enabled).length} enabled`,
          remedy: "",
        }
      : {
          level: "fail",
          name: "PLUGINS",
          detail: `not loaded/enabled: ${missingPlugins.join(", ")}`,
          remedy:
            "Turn them on with `modules on <name>`, then restart Nexus. See MAINTENANCE.md → 'A feature disappeared'.",
        },
  );

  // 3. Schedules registered
  const missingSchedules = REQUIRED_SCHEDULES.filter(
    (r) => byId.get(r.plugin)?.enabled && !snap.schedules.some((s) => s.id.includes(r.job)),
  ).map((r) => r.job);
  checks.push(
    missingSchedules.length === 0
      ? {
          level: "pass",
          name: "SCHEDULES",
          detail: `${snap.schedules.length} jobs armed`,
          remedy: "",
        }
      : {
          level: "fail",
          name: "SCHEDULES",
          detail: `not armed: ${missingSchedules.join(", ")}`,
          remedy: "Restart the Runner so the scheduler re-registers plugin jobs.",
        },
  );

  // 4. Ollama — informational. The whole system is designed to work without
  //    it, so a missing model is a WARN, never a FAIL.
  checks.push(
    snap.ollama.state === "ready"
      ? {
          level: "pass",
          name: "MODEL",
          detail: `Ollama ready (${snap.ollama.model ?? "unknown"})`,
          remedy: "",
        }
      : {
          level: "warn",
          name: "MODEL",
          detail: `Ollama ${snap.ollama.state} — typed commands still work; AI narration/drafts are paused`,
          remedy:
            "Start Ollama and pull a chat model (free). See MAINTENANCE.md → 'The AI stopped responding'.",
        },
  );

  // 5. Failed tasks in the last week
  checks.push(
    snap.failedTasks7d === 0
      ? { level: "pass", name: "RUNS", detail: "no failed tasks in 7 days", remedy: "" }
      : {
          level: snap.failedTasks7d >= 10 ? "fail" : "warn",
          name: "RUNS",
          detail: `${snap.failedTasks7d} failed task(s) in 7 days`,
          remedy:
            "Open the DOCUMENTS trail / audit log to see which intent failed. See MAINTENANCE.md → 'A command keeps failing'.",
        },
  );

  // 6. Voice (informational only — optional feature)
  checks.push({
    level: "pass",
    name: "VOICE",
    detail: `STT ${snap.voice.stt ? "on" : "off"}, TTS ${snap.voice.tts ? "on" : "off"} (optional)`,
    remedy: "",
  });

  // 7. Data footprint (informational — proves the tracking is persisting)
  const totalRecords = Object.values(recordCounts).reduce((a, b) => a + b, 0);
  checks.push({
    level: "pass",
    name: "DATA",
    detail: `${totalRecords} tracked records — ${
      Object.entries(recordCounts)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ") || "none yet"
    }`,
    remedy: "",
  });

  const verdict: Level = checks.some((c) => c.level === "fail")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";
  return { checks, verdict };
}

export function renderAudit(
  snap: OpsSnapshot,
  recordCounts: Record<string, number>,
  todayISO: string,
): { body: string; verdict: Level } {
  const { checks, verdict } = runAudit(snap, recordCounts);
  const banner =
    verdict === "pass"
      ? "✓ SYSTEM HEALTHY"
      : verdict === "warn"
        ? "⚠ SYSTEM OK — WITH WARNINGS"
        : "✗ SYSTEM NEEDS ATTENTION";
  const lines = [
    `# ${banner}`,
    `_audit ${todayISO} · data dir ${snap.dataDir}_`,
    "",
    "| | CHECK | RESULT |",
    "|---|---|---|",
    ...checks.map((c) => `| ${glyph[c.level]} | ${c.name} | ${c.detail} |`),
  ];
  const actions = checks.filter((c) => c.remedy);
  if (actions.length > 0) {
    lines.push("", "## WHAT TO DO");
    for (const c of actions) lines.push(`- **${c.name}**: ${c.remedy}`);
  } else {
    lines.push("", "_Nothing to do. Everything that must be running is running._");
  }
  return { body: lines.join("\n"), verdict };
}
