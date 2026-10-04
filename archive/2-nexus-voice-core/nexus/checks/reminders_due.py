"""Reminders check — a deliberately *quiet* example. If the user has reminders saved, it
drops a calm one-line summary into the log (level "log", never an interrupt). It's deduped
by count, so it surfaces once per distinct number rather than every tick — demonstrating
"quiet by default": useful to glance at, never nagging.
"""

from __future__ import annotations

from ..config import Config
from ..notice import Notice
from ..tools import reminders
from .base import Check


def build(config: Config) -> Check:
    def run() -> list[Notice]:
        items = reminders._load()
        n = len(items)
        if n == 0:
            return []
        plural = "s" if n != 1 else ""
        return [Notice(
            key=f"reminders_count:{n}",
            text=f"You have {n} reminder{plural} on your list.",
            level="log",
            check="reminders_due",
        )]

    return Check(
        name="reminders_due",
        interval_seconds=config.heartbeat_reminders_interval,
        run=run,
        enabled=config.heartbeat_reminders_enabled,
    )
