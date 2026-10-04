"""Proactive calendar reminders.

A scheduler job periodically checks the calendar and surfaces events starting
soon, storing each reminder once (deduplicated) in memory namespace ``reminders``
so the CLI/dashboard can show them. Fully offline-safe: with no Google connected,
the checker simply finds nothing.
"""

from __future__ import annotations

from datetime import datetime, timezone


def _parse_start(value: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def due_reminders(events, now: datetime, window_minutes: int = 60) -> list[dict]:
    """Pure: events whose start is within [now, now + window]."""
    out: list[dict] = []
    horizon = window_minutes
    for ev in events:
        start = _parse_start(getattr(ev, "start", ""))
        if start is None:
            continue
        minutes = (start - now).total_seconds() / 60.0
        if 0 <= minutes <= horizon:
            out.append({
                "event_id": getattr(ev, "id", ""),
                "summary": getattr(ev, "summary", "(event)"),
                "start": start.isoformat(timespec="minutes"),
                "minutes_until": int(round(minutes)),
            })
    return out


def _fetch_events(app):
    try:
        from nexus.connectors.gcalendar import CalendarConnector

        return CalendarConnector.connect().upcoming(days=1)
    except Exception:  # noqa: BLE001 - no Google / offline: nothing to remind
        return []


def run_reminder_check(app, *, events=None, now: datetime | None = None,
                       window_minutes: int = 60) -> list[dict]:
    """Find due reminders and persist newly-seen ones. Returns the new ones."""
    now = now or datetime.now(timezone.utc)
    events = _fetch_events(app) if events is None else events
    due = due_reminders(events, now, window_minutes)

    existing_keys = {
        r.metadata.get("key")
        for r in app.memory.get(namespace="reminders", limit=500)
    }
    new: list[dict] = []
    for d in due:
        key = f"{d['event_id']}:{d['start']}"
        if key in existing_keys:
            continue
        app.memory.store(
            f"Reminder: {d['summary']} at {d['start']} (in {d['minutes_until']} min)",
            title=d["summary"], namespace="reminders", kind="reminder",
            metadata={"key": key, **d}, embed=False,
        )
        new.append(d)
    return new
