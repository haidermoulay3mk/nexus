"""The check registry. Each enabled check is one small module with a `build(config)`.
Adding a proactive behavior is one entry here; the heartbeat loop never changes.
"""

from __future__ import annotations

from ..config import Config
from .base import Check
from . import reminders_due, signal


def get_checks(config: Config) -> list[Check]:
    checks = [
        signal.build(config),
        reminders_due.build(config),
    ]
    return [c for c in checks if c.enabled]
