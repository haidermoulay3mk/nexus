"""Reminders & tasks — the first of the three jobs from the interview.

Two tools: one read-only (`list_reminders`), one that captures a new reminder
(`add_reminder`). Both are low-risk and reversible, so neither is gated — adding a local
note isn't on the never-without-asking list. They persist to a small JSON file under
state/ so they survive restarts (and so Tier 5's heartbeat can read them later).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .base import Tool

# state/ holds durable runtime data; created on first write.
_STORE = Path(__file__).resolve().parent.parent.parent / "state" / "reminders.json"


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


def list_reminders(args: dict) -> str:
    items = _load()
    if not items:
        return "No reminders saved."
    lines = []
    for i, item in enumerate(items, 1):
        when = f" (due {item['due']})" if item.get("due") else ""
        lines.append(f"{i}. {item['text']}{when}")
    return "\n".join(lines)


def add_reminder(args: dict) -> str:
    text = (args.get("text") or "").strip()
    if not text:
        return "A reminder needs some text — nothing was saved."
    due = (args.get("due") or "").strip() or None

    items = _load()
    items.append({"text": text, "due": due, "created": datetime.now().isoformat(timespec="seconds")})
    _save(items)

    return f"Saved: \"{text}\"" + (f" (due {due})." if due else ".")


def get_tools() -> list[Tool]:
    return [
        Tool(
            name="list_reminders",
            description=(
                "Use this to show the user their saved reminders and tasks — whenever they "
                "ask what's on their list, what they have to do, or what's coming up."
            ),
            parameters={"type": "object", "properties": {}, "required": []},
            handler=list_reminders,
        ),
        Tool(
            name="add_reminder",
            description=(
                "Use this to save a new reminder or task for the user — whenever they ask to "
                "be reminded of something, to add a to-do, or to note a task. Capture the task "
                "itself in `text`, and a due date or time in `due` if they mention one."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The reminder or task itself."},
                    "due": {
                        "type": "string",
                        "description": "Optional due date/time in plain words, e.g. 'tomorrow 9am'.",
                    },
                },
                "required": ["text"],
            },
            handler=add_reminder,
        ),
    ]
