"""Database backup + pruning (uses the isolated NEXUS_HOME from conftest)."""

from __future__ import annotations

import sqlite3

from nexus.maintenance import backup_database, prune_backups
from nexus.memory.db import get_db


def test_backup_creates_consistent_copy():
    conn = get_db(":memory:")
    conn.execute("INSERT INTO preferences(key, value) VALUES ('x', '1')")
    conn.commit()

    dest = backup_database(source=conn)
    assert dest.exists()

    # The backup is a real, readable database with our data.
    restored = sqlite3.connect(dest)
    val = restored.execute("SELECT value FROM preferences WHERE key='x'").fetchone()[0]
    restored.close()
    assert val == "1"


def test_prune_keeps_newest():
    from nexus.kernel import paths

    d = paths.backups_dir()
    for name in ("nexus-20260101-000000.db", "nexus-20260102-000000.db",
                 "nexus-20260103-000000.db"):
        (d / name).write_text("x", encoding="utf-8")
    removed = prune_backups(keep=2)
    assert removed == 1
    remaining = sorted(p.name for p in d.glob("nexus-*.db"))
    assert remaining == ["nexus-20260102-000000.db", "nexus-20260103-000000.db"]
