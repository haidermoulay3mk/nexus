"""Maintenance utilities: consistent SQLite backups.

Uses SQLite's online backup API so a backup taken while the app is running is
still consistent (no half-written rows).
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from nexus.kernel import paths
from nexus.memory.db import connect


def backup_database(source: sqlite3.Connection | None = None) -> Path:
    """Copy the live database into <NEXUS_HOME>/backups/nexus-<timestamp>.db."""
    owns = source is None
    src = source or connect()
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = paths.backups_dir() / f"nexus-{ts}.db"
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        if owns:
            src.close()
    return dest


def prune_backups(keep: int = 10) -> int:
    """Keep only the newest ``keep`` backups. Returns the number removed."""
    backups = sorted(paths.backups_dir().glob("nexus-*.db"))
    remove = backups[:-keep] if len(backups) > keep else []
    for f in remove:
        f.unlink(missing_ok=True)
    return len(remove)
