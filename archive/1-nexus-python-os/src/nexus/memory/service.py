"""The single memory API every agent uses.

Combines the SQLite store with vector recall. Dependencies (the embedder that
turns text into vectors, and the summarizer that condenses records) are injected
so the service stays testable without a running Ollama.

    store    -> persist a note/knowledge/context record (optionally embedded)
    search   -> hybrid: semantic when an embedder is present, else keyword
    get      -> structured fetch by namespace/kind
    summarize-> condense recent records (needs a summarizer)
    report   -> counts/rollups for dashboards
    prefs    -> simple key/value user preferences
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from nexus.kernel.types import MemoryRecord
from nexus.memory import db as dbmod
from nexus.memory import vector

Embedder = Callable[[str], list[float]]
Summarizer = Callable[[str], str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class MemoryService:
    def __init__(
        self,
        conn: sqlite3.Connection | None = None,
        *,
        db_file: Path | str | None = None,
        embedder: Embedder | None = None,
        summarizer: Summarizer | None = None,
    ) -> None:
        self.conn = conn or dbmod.get_db(db_file)
        self.embedder = embedder
        self.summarizer = summarizer

    # --- write ----------------------------------------------------------------

    def store(
        self,
        content: str,
        *,
        title: str = "",
        namespace: str = "default",
        kind: str = "note",
        metadata: dict | None = None,
        embed: bool = True,
    ) -> int:
        """Persist a record. Embeds it when an embedder is configured."""
        now = _now()
        blob = None
        if embed and self.embedder is not None:
            try:
                blob = vector.to_blob(self.embedder(f"{title}\n{content}".strip()))
            except Exception:  # noqa: BLE001 - embedding is best-effort
                blob = None
        cur = self.conn.execute(
            """INSERT INTO memories
               (namespace, kind, title, content, metadata, embedding, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (namespace, kind, title, content, json.dumps(metadata or {}), blob, now, now),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    # --- read -----------------------------------------------------------------

    def get(
        self,
        *,
        namespace: str | None = None,
        kind: str | None = None,
        limit: int = 50,
    ) -> list[MemoryRecord]:
        clauses, params = [], []
        if namespace is not None:
            clauses.append("namespace = ?")
            params.append(namespace)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM memories {where} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def search(
        self,
        query: str,
        *,
        namespace: str | None = None,
        k: int = 5,
    ) -> list[tuple[MemoryRecord, float]]:
        """Hybrid search.

        With an embedder: cosine over stored vectors. Without one (or if it
        fails): case-insensitive keyword match. Returns ``(record, score)``.
        """
        if self.embedder is not None:
            try:
                qvec = self.embedder(query)
                return self._semantic_search(qvec, namespace=namespace, k=k)
            except Exception:  # noqa: BLE001 - fall back to keyword
                pass
        return self._keyword_search(query, namespace=namespace, k=k)

    def _semantic_search(
        self, qvec: list[float], *, namespace: str | None, k: int
    ) -> list[tuple[MemoryRecord, float]]:
        where = "WHERE embedding IS NOT NULL"
        params: list = []
        if namespace is not None:
            where += " AND namespace = ?"
            params.append(namespace)
        rows = self.conn.execute(
            f"SELECT id, embedding FROM memories {where}", params
        ).fetchall()
        ranked = vector.cosine_search(qvec, [(r["id"], r["embedding"]) for r in rows], k=k)
        out: list[tuple[MemoryRecord, float]] = []
        for row_id, score in ranked:
            rec = self._fetch_one(row_id)
            if rec is not None:
                out.append((rec, score))
        return out

    def _keyword_search(
        self, query: str, *, namespace: str | None, k: int
    ) -> list[tuple[MemoryRecord, float]]:
        like = f"%{query}%"
        where = "WHERE (title LIKE ? OR content LIKE ?)"
        params: list = [like, like]
        if namespace is not None:
            where += " AND namespace = ?"
            params.append(namespace)
        rows = self.conn.execute(
            f"SELECT * FROM memories {where} ORDER BY created_at DESC LIMIT ?",
            (*params, k),
        ).fetchall()
        return [(self._row_to_record(r), 0.0) for r in rows]

    # --- summarize / report ---------------------------------------------------

    def summarize(self, *, namespace: str | None = None, limit: int = 20) -> str:
        """Condense the most recent records. Needs a summarizer; otherwise
        returns a plain concatenation so callers still get something useful."""
        records = self.get(namespace=namespace, limit=limit)
        if not records:
            return "Nothing stored yet."
        joined = "\n\n".join(f"- {r.title}: {r.content}" if r.title else f"- {r.content}"
                             for r in records)
        if self.summarizer is None:
            return joined
        return self.summarizer(joined)

    def report(self) -> dict:
        """Counts by namespace and kind — feeds the dashboard."""
        by_ns = {
            r["namespace"]: r["n"]
            for r in self.conn.execute(
                "SELECT namespace, COUNT(*) AS n FROM memories GROUP BY namespace"
            ).fetchall()
        }
        by_kind = {
            r["kind"]: r["n"]
            for r in self.conn.execute(
                "SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind"
            ).fetchall()
        }
        total = self.conn.execute("SELECT COUNT(*) AS n FROM memories").fetchone()["n"]
        return {"total": total, "by_namespace": by_ns, "by_kind": by_kind}

    # --- preferences ----------------------------------------------------------

    def set_pref(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO preferences(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    def get_pref(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute(
            "SELECT value FROM preferences WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default

    # --- helpers --------------------------------------------------------------

    def _fetch_one(self, row_id: int) -> MemoryRecord | None:
        row = self.conn.execute("SELECT * FROM memories WHERE id = ?", (row_id,)).fetchone()
        return self._row_to_record(row) if row else None

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> MemoryRecord:
        return MemoryRecord(
            id=row["id"],
            namespace=row["namespace"],
            kind=row["kind"],
            title=row["title"],
            content=row["content"],
            metadata=json.loads(row["metadata"] or "{}"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
