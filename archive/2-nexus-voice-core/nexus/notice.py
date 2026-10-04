"""A `Notice` — one thing the heartbeat decided is worth the user's attention.

Kept in its own neutral module so the inbox and the checks can both import it without
dragging in each other's packages.

`level` is the whole point of "quiet by default":
  - "log"       -> accumulates in a calm log the user can glance at when they choose
  - "interrupt" -> surfaced to the user the next time they're present

`critical` lets something truly urgent interrupt even during quiet hours; everything else
non-critical is downgraded to the log overnight.

`key` is a dedup key: a check that keeps noticing the same condition surfaces it once (until
dismissed), instead of piling up identical notices every tick.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Notice:
    key: str
    text: str
    level: str = "log"          # "log" | "interrupt"
    critical: bool = False      # may interrupt even during quiet hours
    check: str = ""             # which check produced it
    created: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
