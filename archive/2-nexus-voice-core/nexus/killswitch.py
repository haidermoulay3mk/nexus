"""The kill switch — one obvious way to pause ALL proactive behavior at once, without
tearing anything down. While paused, the heartbeat holds: it runs no checks and surfaces
nothing. Conversation still works — you can always talk to Nexus.

It's a flag file in state/, so it's dead simple, survives restarts, and can be toggled from
the REPL (/pause, /resume), from another process, or by hand. You want this the first time
Nexus does something unexpected — not after.
"""

from __future__ import annotations

from pathlib import Path

_FLAG = Path(__file__).resolve().parent.parent / "state" / "PAUSED"


def is_paused() -> bool:
    return _FLAG.exists()


def pause() -> None:
    _FLAG.parent.mkdir(parents=True, exist_ok=True)
    _FLAG.write_text("paused", encoding="utf-8")


def resume() -> None:
    _FLAG.unlink(missing_ok=True)
