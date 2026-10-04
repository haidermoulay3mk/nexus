import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const capability = sqliteTable("capability", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  modelTier: text("model_tier").notNull(),
  visualTier: text("visual_tier").notNull(),
  ramMb: integer("ram_mb").notNull(),
  vramMb: integer("vram_mb"),
  cpuCores: integer("cpu_cores").notNull().default(4),
  probedAt: text("probed_at").notNull(),
});

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** set once the end-of-session memory extractor has processed it */
  extractedAt: text("extracted_at"),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // system | user | assistant | tool
    content: text("content").notNull(),
    tokens: integer("tokens").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_messages_session").on(t.sessionId)],
);

/* ------------------------------------------------------------------ */
/* Intents / runs / queue                                              */
/* ------------------------------------------------------------------ */

export const intents = sqliteTable("intents", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  agent: text("agent").notNull(),
  pluginId: text("plugin_id"),
  scheduleCron: text("schedule_cron"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  requiresIntegration: text("requires_integration"),
  description: text("description").notNull().default(""),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    intentKey: text("intent_key").notNull(),
    agent: text("agent").notNull(),
    status: text("status").notNull(), // queued|active|completed|failed|cancelled
    inputJson: text("input_json").notNull().default("null"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_runs_status").on(t.status), index("idx_runs_created").on(t.createdAt)],
);

export const runSteps = sqliteTable(
  "run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    kind: text("kind").notNull(), // model | tool | note
    name: text("name").notNull(),
    ioJson: text("io_json").notNull().default("{}"),
    ms: real("ms"),
  },
  (t) => [index("idx_run_steps_run").on(t.runId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    intentKey: text("intent_key").notNull(),
    payloadJson: text("payload_json").notNull().default("null"),
    status: text("status").notNull(), // queued|active|done|failed
    priority: integer("priority").notNull().default(0),
    scheduledFor: text("scheduled_for"),
    attempts: integer("attempts").notNull().default(0),
    runId: text("run_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_tasks_status").on(t.status, t.priority)],
);

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    path: text("path").notNull(),
    bodyMd: text("body_md").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_documents_created").on(t.createdAt)],
);

export const cards = sqliteTable("cards", {
  id: text("id").primaryKey(),
  documentId: text("document_id"),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  bodyMd: text("body_md").notNull().default(""),
  x: real("x").notNull().default(0.5),
  y: real("y").notNull().default(0.5),
  createdAt: text("created_at").notNull(),
});

export const directives = sqliteTable("directives", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  priority: integer("priority").notNull().default(0),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const wireItems = sqliteTable(
  "wire_items",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_wire_created").on(t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // fact | pref | entity | note
    text: text("text").notNull(),
    source: text("source").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_memories_kind").on(t.kind)],
);

/**
 * Embedding storage. When sqlite-vec is available a `vec0` virtual table
 * (`memory_vec_idx`) mirrors these rows for fast ANN search; this plain
 * table is the durable source of truth and the brute-force fallback.
 */
export const memoryVectors = sqliteTable("memory_vectors", {
  memoryId: text("memory_id").primaryKey(),
  // Float32Array(768) serialized as little-endian bytes
  embedding: text("embedding", { mode: "text" }).notNull(), // base64
  dims: integer("dims").notNull().default(768),
});

/* ------------------------------------------------------------------ */
/* Integrations / metrics / plugins / audit                            */
/* ------------------------------------------------------------------ */

export const integrations = sqliteTable("integrations", {
  provider: text("provider").primaryKey(),
  status: text("status").notNull().default("disconnected"),
  accountLabel: text("account_label"),
  lastSync: text("last_sync"),
  configJson: text("config_json").notNull().default("{}"), // non-secret config only
});

/** Offline cache of integration reads (calendar events, notion pages, email headers). */
export const netCache = sqliteTable(
  "net_cache",
  {
    key: text("key").primaryKey(), // e.g. "gcal:events:2026-07-02"
    provider: text("provider").notNull(),
    valueJson: text("value_json").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [index("idx_net_cache_provider").on(t.provider)],
);

/** Writes queued while offline; flushed on reconnect. */
export const syncOutbox = sqliteTable(
  "sync_outbox",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    action: text("action").notNull(),
    payloadJson: text("payload_json").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_outbox_provider").on(t.provider)],
);

export const metrics = sqliteTable("metrics", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  value: real("value").notNull().default(0),
  unit: text("unit").notNull().default(""),
  delta: real("delta"),
  deltaUnit: text("delta_unit"),
  seriesJson: text("series_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
});

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  kind: text("kind").notNull(), // native | wasm
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  manifestJson: text("manifest_json").notNull().default("{}"),
  grantsJson: text("grants_json").notNull().default("[]"),
});

/**
 * Structured records store for plugins — the durable home of all life
 * tracking (papers, chapters, scholarships, courses, agency pipeline).
 * Data is JSON validated by the OWNING PLUGIN's Zod schema on every
 * read/write; the LLM never writes here directly.
 */
export const pluginRecords = sqliteTable(
  "plugin_records",
  {
    collection: text("collection").notNull(),
    recordId: text("record_id").notNull(),
    dataJson: text("data_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.collection, t.recordId] }),
    index("idx_plugin_records_collection").on(t.collection),
  ],
);

export const audit = sqliteTable(
  "audit",
  {
    id: text("id").primaryKey(),
    actor: text("actor").notNull(), // agent/plugin id
    action: text("action").notNull(), // tool name or permission event
    target: text("target").notNull().default(""),
    metaJson: text("meta_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_audit_created").on(t.createdAt)],
);
