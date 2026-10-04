"""Tasks + Goals — the productivity domain (Nexus v2).

Deterministic, fully testable repository for to-dos and longer-term goals.
Owns its own tables, created idempotently, so it slots in without touching the
core schema.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    due_date   TEXT,                              -- ISO date/datetime, nullable
    priority   INTEGER NOT NULL DEFAULT 2,        -- 1 high, 2 normal, 3 low
    project    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open',      -- open | done
    created_at TEXT NOT NULL,
    done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_date TEXT,
    progress    INTEGER NOT NULL DEFAULT 0,       -- 0..100
    status      TEXT NOT NULL DEFAULT 'active',   -- active | done
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Task:
    id: int
    title: str
    due_date: str | None
    priority: int
    project: str
    status: str


class ProductivityRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    # --- tasks ----------------------------------------------------------------

    def add_task(self, title: str, *, due: str | None = None,
                 priority: int = 2, project: str = "") -> int:
        priority = max(1, min(3, int(priority)))
        cur = self.conn.execute(
            "INSERT INTO tasks(title, due_date, priority, project, status, created_at) "
            "VALUES (?,?,?,?, 'open', ?)",
            (title.strip(), due or None, priority, project, _now()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def list_tasks(self, status: str = "open", project: str | None = None) -> list[Task]:
        clauses, params = ["status = ?"], [status]
        if project:
            clauses.append("project = ?")
            params.append(project)
        rows = self.conn.execute(
            f"SELECT * FROM tasks WHERE {' AND '.join(clauses)} "
            "ORDER BY priority ASC, (due_date IS NULL), due_date ASC, id ASC",
            params,
        ).fetchall()
        return [self._task(r) for r in rows]

    def complete_task(self, task_id: int) -> bool:
        cur = self.conn.execute(
            "UPDATE tasks SET status='done', done_at=? WHERE id=? AND status='open'",
            (_now(), int(task_id)),
        )
        self.conn.commit()
        return cur.rowcount > 0

    # --- goals ----------------------------------------------------------------

    def add_goal(self, title: str, *, description: str = "",
                 target_date: str | None = None) -> int:
        now = _now()
        cur = self.conn.execute(
            "INSERT INTO goals(title, description, target_date, progress, status, created_at, updated_at) "
            "VALUES (?,?,?,0,'active',?,?)",
            (title.strip(), description, target_date or None, now, now),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def list_goals(self, status: str = "active") -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM goals WHERE status=? ORDER BY (target_date IS NULL), target_date ASC, id",
            (status,),
        ).fetchall()

    def update_goal_progress(self, goal_id: int, progress: int) -> int:
        progress = max(0, min(100, int(progress)))
        status = "done" if progress >= 100 else "active"
        self.conn.execute(
            "UPDATE goals SET progress=?, status=?, updated_at=? WHERE id=?",
            (progress, status, _now(), int(goal_id)),
        )
        self.conn.commit()
        return progress

    # --- summary --------------------------------------------------------------

    def summary(self) -> dict:
        open_tasks = self.list_tasks("open")
        active_goals = self.list_goals("active")
        next_due = next((t for t in open_tasks if t.due_date), None)
        return {
            "open_tasks": len(open_tasks),
            "next_due": (next_due.title if next_due else None),
            "active_goals": len(active_goals),
        }

    @staticmethod
    def _task(r: sqlite3.Row) -> Task:
        return Task(id=r["id"], title=r["title"], due_date=r["due_date"],
                    priority=r["priority"], project=r["project"], status=r["status"])
