"""The inbox — the single place proactive notices land and wait for the user.

Notices are *held*, not fired-and-forgotten: if the heartbeat notices something while the
user's interface is closed, it stays here until they're back (catch-up-on-return). Every
notice is dismissible, so the inbox can always be emptied. Dedup by `key` means a recurring
condition surfaces once, not every tick. A `shown` flag lets the interface display a new
interrupt exactly once (when the user next interacts) without nagging on every turn.

Persisted to state/inbox.json so it survives a restart.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from .notice import Notice

_STORE = Path(__file__).resolve().parent.parent / "state" / "inbox.json"


def _load() -> list[dict]:
    if not _STORE.exists():
        return []
    try:
        return json.loads(_STORE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save(items: list[dict]) -> None:
    _STORE.parent.mkdir(parents=True, exist_ok=True)
    _STORE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def add(notice: Notice, level: str | None = None) -> bool:
    """Hold a notice. Returns False (and changes nothing) if one with the same key is
    already waiting — that's the dedup that stops a check piling up identical notices."""
    items = _load()
    if any(it["key"] == notice.key for it in items):
        return False
    items.append({
        "id": uuid.uuid4().hex[:8],
        "key": notice.key,
        "text": notice.text,
        "level": level or notice.level,
        "critical": notice.critical,
        "check": notice.check,
        "created": notice.created,
        "shown": False,
    })
    _save(items)
    return True


def pending(level: str | None = None) -> list[dict]:
    items = _load()
    return [it for it in items if level is None or it["level"] == level]


def new_unshown(level: str = "interrupt") -> list[dict]:
    """Interrupt-level notices that haven't been displayed yet — the catch-up set."""
    return [it for it in _load() if it["level"] == level and not it["shown"]]


def mark_shown(ids: list[str]) -> None:
    items = _load()
    idset = set(ids)
    for it in items:
        if it["id"] in idset:
            it["shown"] = True
    _save(items)


def dismiss(notice_id: str) -> bool:
    items = _load()
    kept = [it for it in items if it["id"] != notice_id]
    if len(kept) == len(items):
        return False
    _save(kept)
    return True


def dismiss_all() -> int:
    items = _load()
    _save([])
    return len(items)
