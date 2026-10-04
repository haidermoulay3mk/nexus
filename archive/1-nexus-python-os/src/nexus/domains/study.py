"""A-Level study tracking — the primary Nexus capability.

Tracks subjects, topics (with confidence + status), and past-paper results, and
derives weak/strong topics, progress summaries, and study recommendations.

All logic here is deterministic and fully testable without a model. The Study
*agent* layers natural-language phrasing on top via tools; the numbers come from
this repository.

Confidence scale (per topic): 0 unknown · 1–2 weak · 3 okay · 4–5 strong.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

DEFAULT_SUBJECTS = [
    ("Physics", "A-Level"),
    ("Mathematics", "A-Level"),
    ("Computer Science", "A-Level"),
]

_SCHEMA = """
CREATE TABLE IF NOT EXISTS subjects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    board      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    chapter     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'not_started',  -- not_started|in_progress|done
    confidence  INTEGER NOT NULL DEFAULT 0,           -- 0..5
    updated_at  TEXT NOT NULL,
    UNIQUE(subject_id, name)
);
CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id);

CREATE TABLE IF NOT EXISTS past_papers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    paper       TEXT NOT NULL DEFAULT '',
    year        INTEGER,
    season      TEXT NOT NULL DEFAULT '',
    score       REAL NOT NULL DEFAULT 0,
    max_score   REAL NOT NULL DEFAULT 100,
    notes       TEXT NOT NULL DEFAULT '',
    taken_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_papers_subject ON past_papers(subject_id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class PaperResult:
    subject: str
    paper: str
    score: float
    max_score: float
    percentage: float
    year: int | None
    season: str


class StudyRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    # --- subjects -------------------------------------------------------------

    def add_subject(self, name: str, board: str = "A-Level") -> int:
        cur = self.conn.execute(
            "INSERT INTO subjects(name, board, created_at) VALUES (?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET board=excluded.board",
            (name.strip(), board, _now()),
        )
        self.conn.commit()
        if cur.lastrowid:
            return int(cur.lastrowid)
        return self._subject_id(name)

    def seed_default_subjects(self) -> list[str]:
        for name, board in DEFAULT_SUBJECTS:
            self.add_subject(name, board)
        return [s["name"] for s in self.list_subjects()]

    def list_subjects(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM subjects ORDER BY name").fetchall()

    def _subject_id(self, name: str) -> int:
        row = self.conn.execute(
            "SELECT id FROM subjects WHERE name = ? COLLATE NOCASE", (name.strip(),)
        ).fetchone()
        if row is None:
            raise KeyError(f"unknown subject: {name!r} (add it first)")
        return int(row["id"])

    # --- topics ---------------------------------------------------------------

    def add_topic(
        self,
        subject: str,
        name: str,
        *,
        chapter: str = "",
        status: str = "not_started",
        confidence: int = 0,
    ) -> int:
        sid = self._subject_id(subject)
        confidence = max(0, min(5, int(confidence)))
        cur = self.conn.execute(
            """INSERT INTO topics(subject_id, name, chapter, status, confidence, updated_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(subject_id, name) DO UPDATE SET
                   chapter=excluded.chapter, status=excluded.status,
                   confidence=excluded.confidence, updated_at=excluded.updated_at""",
            (sid, name.strip(), chapter, status, confidence, _now()),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def set_confidence(self, subject: str, topic: str, confidence: int,
                       status: str | None = None) -> None:
        sid = self._subject_id(subject)
        confidence = max(0, min(5, int(confidence)))
        if status is None:
            status = "done" if confidence >= 4 else "in_progress"
        self.conn.execute(
            "UPDATE topics SET confidence=?, status=?, updated_at=? "
            "WHERE subject_id=? AND name=? COLLATE NOCASE",
            (confidence, status, _now(), sid, topic.strip()),
        )
        self.conn.commit()

    def list_topics(self, subject: str | None = None) -> list[sqlite3.Row]:
        if subject:
            sid = self._subject_id(subject)
            return self.conn.execute(
                "SELECT t.*, s.name AS subject FROM topics t JOIN subjects s ON s.id=t.subject_id "
                "WHERE subject_id=? ORDER BY confidence ASC, t.name", (sid,)
            ).fetchall()
        return self.conn.execute(
            "SELECT t.*, s.name AS subject FROM topics t JOIN subjects s ON s.id=t.subject_id "
            "ORDER BY s.name, confidence ASC, t.name"
        ).fetchall()

    def weak_topics(self, threshold: int = 2) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT t.*, s.name AS subject FROM topics t JOIN subjects s ON s.id=t.subject_id "
            "WHERE confidence <= ? ORDER BY confidence ASC, s.name, t.name", (threshold,)
        ).fetchall()

    def strong_topics(self, threshold: int = 4) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT t.*, s.name AS subject FROM topics t JOIN subjects s ON s.id=t.subject_id "
            "WHERE confidence >= ? ORDER BY confidence DESC, s.name, t.name", (threshold,)
        ).fetchall()

    # --- past papers ----------------------------------------------------------

    def log_paper(
        self,
        subject: str,
        score: float,
        max_score: float = 100,
        *,
        paper: str = "",
        year: int | None = None,
        season: str = "",
        notes: str = "",
    ) -> PaperResult:
        sid = self._subject_id(subject)
        score = float(score)
        max_score = float(max_score) or 100.0
        self.conn.execute(
            """INSERT INTO past_papers(subject_id, paper, year, season, score, max_score, notes, taken_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (sid, paper, year, season, score, max_score, notes, _now()),
        )
        self.conn.commit()
        pct = round(score / max_score * 100, 1)
        return PaperResult(subject, paper, score, max_score, pct, year, season)

    def list_papers(self, subject: str | None = None) -> list[sqlite3.Row]:
        if subject:
            sid = self._subject_id(subject)
            return self.conn.execute(
                "SELECT p.*, s.name AS subject FROM past_papers p JOIN subjects s ON s.id=p.subject_id "
                "WHERE subject_id=? ORDER BY taken_at DESC", (sid,)
            ).fetchall()
        return self.conn.execute(
            "SELECT p.*, s.name AS subject FROM past_papers p JOIN subjects s ON s.id=p.subject_id "
            "ORDER BY taken_at DESC"
        ).fetchall()

    # --- analytics ------------------------------------------------------------

    def progress(self, subject: str | None = None) -> dict:
        """Roll-up used by reports and the dashboard."""
        subjects = [subject] if subject else [s["name"] for s in self.list_subjects()]
        out = {}
        for name in subjects:
            try:
                sid = self._subject_id(name)
            except KeyError:
                continue
            topics = self.conn.execute(
                "SELECT status, confidence FROM topics WHERE subject_id=?", (sid,)
            ).fetchall()
            papers = self.conn.execute(
                "SELECT score, max_score FROM past_papers WHERE subject_id=?", (sid,)
            ).fetchall()
            n_topics = len(topics)
            done = sum(1 for t in topics if t["status"] == "done")
            avg_conf = round(sum(t["confidence"] for t in topics) / n_topics, 2) if n_topics else 0.0
            paper_pcts = [
                (p["score"] / p["max_score"] * 100) for p in papers if p["max_score"]
            ]
            avg_paper = round(sum(paper_pcts) / len(paper_pcts), 1) if paper_pcts else None
            out[name] = {
                "topics_total": n_topics,
                "topics_done": done,
                "completion_pct": round(done / n_topics * 100, 1) if n_topics else 0.0,
                "avg_confidence": avg_conf,
                "papers_logged": len(papers),
                "avg_paper_pct": avg_paper,
            }
        return out

    def recommendations(self, limit: int = 5) -> list[str]:
        """Deterministic study advice from the data (no model required)."""
        recs: list[str] = []
        weak = self.weak_topics(threshold=2)
        for t in weak[:limit]:
            recs.append(
                f"Revise {t['subject']} -> '{t['name']}' (confidence {t['confidence']}/5)."
            )
        prog = self.progress()
        for name, p in prog.items():
            if p["avg_paper_pct"] is not None and p["avg_paper_pct"] < 60:
                recs.append(
                    f"{name}: past-paper average is {p['avg_paper_pct']}% — do timed papers."
                )
            if p["topics_total"] and p["completion_pct"] < 50:
                recs.append(
                    f"{name}: only {p['completion_pct']}% of topics complete — keep moving."
                )
        if not recs:
            recs.append("No weak spots logged yet. Add topics and past-paper scores to get advice.")
        return recs[:limit]
