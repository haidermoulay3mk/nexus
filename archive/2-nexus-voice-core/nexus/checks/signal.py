"""Signal check — watches for a file the user (or another process) drops, and surfaces its
contents as an interrupt-level notice, then consumes the file so it surfaces exactly once.

This is the easy way to trigger a proactive notice on purpose: write a line into the signal
file and the next heartbeat tick picks it up. It also stands in for the general pattern —
"notice a condition in the world, decide it's worth surfacing."
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from ..config import ROOT, Config
from ..notice import Notice
from .base import Check


def _resolve(path_str: str) -> Path:
    p = Path(path_str)
    return p if p.is_absolute() else (ROOT / p)


def build(config: Config) -> Check:
    path = _resolve(config.heartbeat_signal_path)

    def run() -> list[Notice]:
        if not path.exists():
            return []
        try:
            content = path.read_text(encoding="utf-8-sig").strip()  # utf-8-sig drops a BOM
            path.unlink()  # consume — surface once, never on a loop
        except OSError:
            return []
        if not content:
            return []
        key = "signal:" + hashlib.sha1(content.encode("utf-8")).hexdigest()[:8]
        return [Notice(key=key, text=content, level="interrupt", check="signal")]

    return Check(
        name="signal",
        interval_seconds=config.heartbeat_signal_interval,
        run=run,
        enabled=config.heartbeat_signal_enabled,
    )
