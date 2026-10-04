"""The shape of a scheduled check.

A check is its own small unit: a name, how often it should run, and a `run()` that looks at
something and returns zero or more Notices. Returning nothing (the common case) is how
"quiet by default" works — most checks surface nothing most of the time. Adding a new
proactive behavior is one check module registered in checks/__init__.py; the heartbeat loop
never changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..notice import Notice


@dataclass
class Check:
    name: str
    interval_seconds: int
    run: Callable[[], list[Notice]]   # looks at the world; returns notices worth surfacing
    enabled: bool = True
