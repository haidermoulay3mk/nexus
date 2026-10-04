"""SQLite connection + schema management.

SQLite is the system of record: structured, queryable, reportable, zero-install.
The schema is created idempotently. A ``schema_version`` row enables simple
forward migrations later without an ORM.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from nexus.kernel import paths

SCHEMA_VERSION = 1

# Generic memory table (notes / knowledge / long-term context) plus a
# key/value preferences table. Domain tables (study, etc.) are created by their
# own modules via ``ensure_table`` so the core stays small.
_CORE_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace  TEXT NOT NULL DEFAULT 'default',
    kind       TEXT NOT NULL DEFAULT 'note',
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    metadata   TEXT NOT NULL DEFAULT '{}',     -- JSON
    embedding  BLOB,                            -- float32 bytes, nullable
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_ns   ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

CREATE TABLE IF NOT EXISTS preferences (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(db_file: Path | str | None = None) -> sqlite3.Connection:
    """Open a connection with sensible pragmas and Row access by name."""
    target = Path(db_file) if db_file is not None else paths.db_path()
    # check_same_thread=False: the dashboard (threadpool) and scheduler (background
    # thread) share one connection. Safe here because this is a single-user app
    # with effectively no concurrent writers; WAL handles reader/writer overlap.
    conn = sqlite3.connect(target, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create core tables and stamp the schema version (idempotent)."""
    conn.executescript(_CORE_SCHEMA)
    cur = conn.execute("SELECT value FROM meta WHERE key='schema_version'")
    row = cur.fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    conn.commit()


def get_db(db_file: Path | str | None = None) -> sqlite3.Connection:
    """Connect + ensure schema in one call."""
    conn = connect(db_file)
    init_db(conn)
    return conn
