import type { Database } from "bun:sqlite";

/**
 * Idempotent, hand-audited DDL. Runs at every boot; safe on existing DBs.
 * Keep in lockstep with schema.ts.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_tier TEXT NOT NULL,
  visual_tier TEXT NOT NULL,
  ram_mb INTEGER NOT NULL,
  vram_mb INTEGER,
  cpu_cores INTEGER NOT NULL DEFAULT 4,
  probed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS intents (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  agent TEXT NOT NULL,
  plugin_id TEXT,
  schedule_cron TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  requires_integration TEXT,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  intent_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT 'null',
  started_at TEXT,
  ended_at TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  io_json TEXT NOT NULL DEFAULT '{}',
  ms REAL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  intent_key TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  scheduled_for TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL DEFAULT 0.5,
  y REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directives (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wire_items (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wire_created ON wire_items(created_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  dims INTEGER NOT NULL DEFAULT 768
);

CREATE TABLE IF NOT EXISTS integrations (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disconnected',
  account_label TEXT,
  last_sync TEXT,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS net_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  value_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_net_cache_provider ON net_cache(provider);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_provider ON sync_outbox(provider);

CREATE TABLE IF NOT EXISTS metrics (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  delta REAL,
  delta_unit TEXT,
  series_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  grants_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS plugin_records (
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, record_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_records_collection ON plugin_records(collection);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
`;

/**
 * Additive column migrations for DBs created before the column existed.
 * SQLite has no ADD COLUMN IF NOT EXISTS — a duplicate-column error means
 * the migration already ran, which is fine.
 */
const ALTERS = [
  "ALTER TABLE intents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;",
  "ALTER TABLE sessions ADD COLUMN extracted_at TEXT;",
];

export function migrate(sqlite: Database): void {
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec(DDL);
  for (const alter of ALTERS) {
    try {
      sqlite.exec(alter);
    } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }
  }
}
