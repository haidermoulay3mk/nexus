import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Tiers                                                               */
/* ------------------------------------------------------------------ */

export const ModelTier = z.enum(["lite", "balanced", "max"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const VisualTier = z.enum(["low", "medium", "high"]);
export type VisualTier = z.infer<typeof VisualTier>;

export const CapabilityProfile = z.object({
  modelTier: ModelTier,
  visualTier: VisualTier,
  ramMb: z.number().int().nonnegative(),
  vramMb: z.number().int().nonnegative().nullable(),
  cpuCores: z.number().int().positive(),
  probedAt: z.string(), // ISO timestamp
});
export type CapabilityProfile = z.infer<typeof CapabilityProfile>;

/* ------------------------------------------------------------------ */
/* Runs / tasks                                                        */
/* ------------------------------------------------------------------ */

export const RunStatus = z.enum(["queued", "active", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunStepKind = z.enum(["model", "tool", "note"]);
export type RunStepKind = z.infer<typeof RunStepKind>;

export const RunSummary = z.object({
  id: z.string(),
  intentKey: z.string(),
  agent: z.string(),
  status: RunStatus,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const QueueStatus = z.object({
  active: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  maxConcurrent: z.number().int().positive(),
});
export type QueueStatus = z.infer<typeof QueueStatus>;

/* ------------------------------------------------------------------ */
/* HUD data                                                            */
/* ------------------------------------------------------------------ */

export const MetricDto = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.string(), // e.g. "", "%", "/wk", "/day"
  delta: z.number().nullable(), // change vs previous period
  deltaUnit: z.string().nullable(), // e.g. "/wk"
  series: z.array(z.number()), // sparkline history, oldest → newest
  updatedAt: z.string(),
});
export type MetricDto = z.infer<typeof MetricDto>;

export const DocumentDto = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  kind: z.string(), // "report" | "plan" | "brief" | "note" | ...
  title: z.string(),
  path: z.string(), // on-disk markdown file
  createdAt: z.string(),
});
export type DocumentDto = z.infer<typeof DocumentDto>;

export const CardDto = z.object({
  id: z.string(),
  documentId: z.string().nullable(),
  title: z.string(),
  kind: z.string(),
  bodyMd: z.string(), // rendered preview content
  x: z.number(), // normalized 0..1 position on the stage
  y: z.number(),
  createdAt: z.string(),
});
export type CardDto = z.infer<typeof CardDto>;

export const DirectiveDto = z.object({
  id: z.string(),
  text: z.string(),
  priority: z.number().int(),
  done: z.boolean(),
  createdAt: z.string(),
});
export type DirectiveDto = z.infer<typeof DirectiveDto>;

export const WireItemDto = z.object({
  id: z.string(),
  channel: z.string(), // e.g. "morning.intel", "run", "system"
  text: z.string(),
  createdAt: z.string(),
});
export type WireItemDto = z.infer<typeof WireItemDto>;

export const IntentDto = z.object({
  key: z.string(),
  label: z.string(),
  agent: z.string(),
  pluginId: z.string().nullable(),
  scheduleCron: z.string().nullable(),
  enabled: z.boolean(),
  /** null = fully local; otherwise the integration provider it needs */
  requiresIntegration: z.string().nullable(),
  /** live availability, considering integration connection state */
  available: z.boolean(),
  description: z.string(),
  /** hidden intents run via typed commands only — no deck button */
  hidden: z.boolean().default(false),
});
export type IntentDto = z.infer<typeof IntentDto>;

export const IntegrationStatus = z.enum(["disconnected", "connected", "error", "syncing"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

export const IntegrationDto = z.object({
  provider: z.string(), // "notion" | "google-calendar" | "gmail" | "imap" | "caldav"
  status: IntegrationStatus,
  accountLabel: z.string().nullable(),
  lastSync: z.string().nullable(),
});
export type IntegrationDto = z.infer<typeof IntegrationDto>;

export const LinkState = z.enum(["online", "offline", "partial"]);
export type LinkState = z.infer<typeof LinkState>;

export const SystemStatus = z.object({
  core: z.enum(["idle", "active", "starting", "degraded"]),
  link: LinkState,
  runner: z.enum(["alive", "starting", "dead"]),
  ollama: z.enum(["ready", "missing", "starting", "error"]),
  model: z.string().nullable(), // active chat model id
  queue: QueueStatus,
  uptimeSec: z.number().nonnegative(),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

export const PrimaryDirectiveDto = z.object({
  label: z.string(), // e.g. "PRIMARY DIRECTIVE · LIVE DEPLOY"
  value: z.number(),
  unit: z.string(), // e.g. "VIEWS"
  sublines: z.array(z.string()), // e.g. ["velocity 2,778/day", "live 28h"]
});
export type PrimaryDirectiveDto = z.infer<typeof PrimaryDirectiveDto>;

/* ------------------------------------------------------------------ */
/* Voice                                                               */
/* ------------------------------------------------------------------ */

export const VoiceState = z.enum(["standby", "listening", "transcribing", "speaking", "error"]);
export type VoiceState = z.infer<typeof VoiceState>;

/* ------------------------------------------------------------------ */
/* Plugins                                                             */
/* ------------------------------------------------------------------ */

export const PluginKind = z.enum(["native", "wasm"]);
export type PluginKind = z.infer<typeof PluginKind>;

export const Capability = z.enum([
  "memory.read",
  "memory.write",
  "fs.documents",
  "llm.chat",
  "metrics.read",
  "metrics.write",
  "net.fetch",
  "notion",
  "calendar",
  "email",
  "records",
]);
export type Capability = z.infer<typeof Capability>;

export const PluginDto = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  kind: PluginKind,
  enabled: z.boolean(),
  grants: z.array(Capability),
  requested: z.array(Capability),
  description: z.string(),
});
export type PluginDto = z.infer<typeof PluginDto>;
