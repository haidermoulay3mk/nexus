import type { AgentName, Capability, MetricDto, Result } from "@nexus/core";
import type { z } from "zod";

/* ------------------------------------------------------------------ */
/* Services exposed to plugins (capability-gated by the Runner)        */
/* ------------------------------------------------------------------ */

export interface MemoryHit {
  id: string;
  kind: string;
  text: string;
  source: string;
  distance: number;
}

export interface MemoryApi {
  /** requires `memory.read` */
  search(query: string, k?: number): Promise<MemoryHit[]>;
  /** requires `memory.read` */
  recent(kind?: string, limit?: number): Promise<MemoryHit[]>;
  /** requires `memory.write` */
  write(kind: "fact" | "pref" | "entity" | "note", text: string, source: string): Promise<string>;
}

export interface DocumentsApi {
  /** requires `fs.documents` — writes markdown to the vault and records it */
  write(kind: string, title: string, bodyMd: string): Promise<{ id: string; path: string }>;
  /** requires `fs.documents` */
  recent(
    limit?: number,
  ): Promise<Array<{ id: string; title: string; kind: string; bodyMd: string; createdAt: string }>>;
}

export interface MetricsApi {
  /** requires `metrics.read` */
  all(): Promise<MetricDto[]>;
  /** requires `metrics.write` — appends to the sparkline series */
  record(key: string, label: string, value: number, unit?: string): Promise<void>;
}

export interface LlmApi {
  /** requires `llm.chat` — single completion (no tools) on the tier model */
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<Result<string>>;
}

export interface WireApi {
  append(channel: string, text: string): Promise<void>;
}

export interface NetApi {
  /**
   * requires `net.fetch` — cached fetch. Returns the live response when
   * online (and caches it), or the last cached value when offline.
   */
  fetchCached(
    key: string,
    url: string,
    ttlSec: number,
    init?: RequestInit,
  ): Promise<Result<{ body: string; fromCache: boolean }>>;
}

export interface DirectivesApi {
  list(
    includeDone?: boolean,
  ): Promise<Array<{ id: string; text: string; priority: number; done: boolean }>>;
  add(text: string, priority?: number): Promise<string>;
  setDone(id: string, done: boolean): Promise<void>;
}

/**
 * Structured, deterministic storage — the durable home of all tracking
 * data (papers, chapters, scholarships, courses, agency pipeline).
 *
 * DESIGN LAW: agents/LLMs never write records. Only deterministic plugin
 * code (command parsers, sweeps) does, after Zod-validating the data.
 * The LLM at most *narrates* what these tables say.
 */
export interface RecordRow {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordsApi {
  /** requires `records` — upsert (creates or fully replaces `data`). Accepts
   *  any JSON-serializable object; plugins Zod-validate on the way back out. */
  put(collection: string, id: string, data: object): Promise<void>;
  /** requires `records` */
  get(collection: string, id: string): Promise<RecordRow | null>;
  /** requires `records` — returns true if a row was deleted */
  remove(collection: string, id: string): Promise<boolean>;
  /** requires `records` — newest-updated first */
  list(collection: string, opts?: { limit?: number; offset?: number }): Promise<RecordRow[]>;
  /** requires `records` */
  count(collection: string): Promise<number>;
}

export interface SecretsApi {
  /** Secrets live in the Stronghold vault (via the Shell); plugins only get
   *  the specific keys their manifest requested. Never logged, never sent to UI. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/* ------------------------------------------------------------------ */
/* Agent bridge                                                        */
/* ------------------------------------------------------------------ */

export interface AgentRunRequest {
  agent: AgentName;
  /** the task briefing appended to the agent's system prompt */
  brief: string;
  /** tool names (from this plugin or core) the agent may call for this run */
  tools?: string[];
  maxSteps?: number;
  /** deep-conversation flag: injects the personality self-audit into the
   *  dynamic prompt block (anti-drift seatbelt for long chats) */
  checkpoint?: boolean;
}

export interface AgentRunResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  steps: number;
}

/* ------------------------------------------------------------------ */
/* Run context — what an intent handler receives                       */
/* ------------------------------------------------------------------ */

export interface IntentResult {
  /** Document + result card produced by this run (null = no artifact). */
  document: { kind: string; title: string; bodyMd: string } | null;
  /** Short sentence for Piper TTS (null = silent). */
  speak: string | null;
  /** Lines appended to the AI WIRE feed. */
  wire: string[];
}

export interface RunContext {
  runId: string;
  intentKey: string;
  input: string | null;
  offline: boolean;
  memory: MemoryApi;
  documents: DocumentsApi;
  metrics: MetricsApi;
  llm: LlmApi;
  wire: WireApi;
  net: NetApi;
  directives: DirectivesApi;
  secrets: SecretsApi;
  records: RecordsApi;
  log: PluginLogger;
  /** Run a multi-step agent loop (streams tokens to the HUD automatically). */
  runAgent(req: AgentRunRequest): Promise<Result<AgentRunResult>>;
  /** Record a named step on the run timeline (shows in run.step events). */
  step(name: string, detail?: string): void;
  /** Cooperative cancellation — handlers should check between steps. */
  signal: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Plugin surface                                                      */
/* ------------------------------------------------------------------ */

export interface IntentSpec {
  key: string;
  label: string; // COMMAND DECK button text, e.g. "METRICS PULL"
  agent: AgentName;
  description: string;
  /** cron expression (croner syntax) for scheduled execution, or null */
  scheduleCron: string | null;
  /** integration provider required, or null if fully local */
  requiresIntegration: string | null;
  /** hidden intents are reachable via typed commands only — no deck button */
  hidden?: boolean;
  handler(ctx: RunContext): Promise<Result<IntentResult>>;
}

/**
 * A typed command: the first word of a palette/voice command line.
 * `paper 9702 s23 22 48/60` → routed to `intentKey` with the FULL line as
 * input, parsed by deterministic plugin code — never by the LLM. Commands
 * keep working when Ollama is down or the model is weak.
 */
export interface CommandSpec {
  /** first token, lowercase, e.g. "paper" */
  prefix: string;
  /** intent that handles the full command line as its input */
  intentKey: string;
  /** one-line usage shown by `help`, e.g. "paper 9702 s23 22 48/60" */
  usage: string;
  description: string;
}

export interface ToolSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string; // namespaced, e.g. "notion.search"
  description: string;
  capability: Capability;
  inputSchema: S;
  execute(input: z.infer<S>, ctx: RunContext): Promise<Result<string>>;
}

export interface ScheduledJobSpec {
  id: string;
  cron: string;
  /** intent to enqueue when the cron fires */
  intentKey: string;
}

export interface NexusPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** capabilities this plugin needs; user must grant them */
  capabilities: Capability[];
  /** Stronghold secret keys this plugin may read/write */
  secretKeys?: string[];
  /** Niche module: OFF on a fresh install until the operator turns it on (`modules on <name>`). */
  optional?: boolean;
}

export interface NexusPlugin {
  manifest: NexusPluginManifest;
  intents: IntentSpec[];
  tools: ToolSpec[];
  scheduledJobs: ScheduledJobSpec[];
  /** typed command prefixes routed deterministically (no LLM) */
  commands?: CommandSpec[];
  /** optional HUD panel descriptor rendered by the UI (data-driven) */
  uiPanels?: Array<{ id: string; title: string; region: "left" | "right" }>;
  /** called once at load; do setup, report readiness */
  init?(services: { log: PluginLogger }): Promise<void>;
}

export function definePlugin(plugin: NexusPlugin): NexusPlugin {
  return plugin;
}

/* ------------------------------------------------------------------ */
/* Ops snapshot — a deterministic health readout for SYSTEM AUDIT.     */
/* Produced by the Runner, consumed by the ops plugin. No LLM.         */
/* ------------------------------------------------------------------ */

export interface OpsSnapshot {
  plugins: Array<{ id: string; name: string; version: string; enabled: boolean; kind: string }>;
  schedules: Array<{ id: string; next: string | null }>;
  ollama: { state: string; model: string | null };
  integrations: Array<{ provider: string; status: string }>;
  dbTables: string[];
  failedTasks7d: number;
  vaultDir: string;
  dataDir: string;
  voice: { stt: boolean; tts: boolean };
}
