"""Proactive calendar reminders: pure due-filter + dedup persistence."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from nexus.app import NexusApp
from nexus.connectors.gcalendar import CalendarEvent
from nexus.scheduler.reminders import due_reminders, run_reminder_check


def _event(eid, summary, start_dt):
    return CalendarEvent(id=eid, summary=summary, start=start_dt.isoformat(), end="")


def test_due_reminders_window():
    now = datetime(2026, 6, 19, 9, 0, tzinfo=timezone.utc)
    soon = _event("1", "Physics class", now + timedelta(minutes=30))
    later = _event("2", "Dentist", now + timedelta(hours=5))
    past = _event("3", "Earlier", now - timedelta(minutes=10))
    due = due_reminders([soon, later, past], now, window_minutes=60)
    assert [d["event_id"] for d in due] == ["1"]
    assert due[0]["minutes_until"] == 30


def test_run_reminder_check_dedups():
    app = NexusApp(db_file=":memory:")
    now = datetime(2026, 6, 19, 9, 0, tzinfo=timezone.utc)
    events = [_event("1", "Physics class", now + timedelta(minutes=20))]

    first = run_reminder_check(app, events=events, now=now, window_minutes=60)
    assert len(first) == 1
    second = run_reminder_check(app, events=events, now=now, window_minutes=60)
    assert second == []  # same event not re-stored

    stored = app.memory.get(namespace="reminders")
    assert len(stored) == 1
    assert "Physics class" in stored[0].content
