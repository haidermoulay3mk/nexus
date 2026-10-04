"""Gmail + Calendar connectors, exercised with fakes that mimic the Google
API call chain (service.users().messages().list().execute(), etc.)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from nexus.connectors.gcalendar import CalendarConnector
from nexus.connectors.gmail import GmailConnector


class _Exec:
    def __init__(self, value):
        self._value = value

    def execute(self):
        return self._value


# --- Gmail fake ---------------------------------------------------------------

class _FakeMessages:
    def __init__(self, store):
        self.store = store
        self.modified = []

    def list(self, userId, q, maxResults):
        return _Exec({"messages": [{"id": i} for i in self.store]})

    def get(self, userId, id, format, metadataHeaders):
        return _Exec(self.store[id])

    def modify(self, userId, id, body):
        self.modified.append((id, body))
        return _Exec({})


class _FakeLabels:
    def __init__(self):
        self.labels = []
        self._n = 0

    def list(self, userId):
        return _Exec({"labels": self.labels})

    def create(self, userId, body):
        self._n += 1
        lbl = {"id": f"L{self._n}", "name": body["name"]}
        self.labels.append(lbl)
        return _Exec(lbl)


class _FakeUsers:
    def __init__(self, store):
        self._messages = _FakeMessages(store)
        self._labels = _FakeLabels()

    def messages(self):
        return self._messages

    def labels(self):
        return self._labels


class FakeGmailService:
    def __init__(self, store):
        self._users = _FakeUsers(store)

    def users(self):
        return self._users


def _msg(mid, sender, subject, snippet, unread=True):
    return {
        "id": mid,
        "snippet": snippet,
        "labelIds": (["UNREAD"] if unread else []),
        "payload": {"headers": [
            {"name": "From", "value": sender},
            {"name": "Subject", "value": subject},
        ]},
    }


def test_gmail_list_recent_parses_summaries():
    store = {
        "1": _msg("1", "prof@uni.edu", "Offer update", "Your application..."),
        "2": _msg("2", "club@school.org", "Meeting", "Don't forget...", unread=False),
    }
    gmail = GmailConnector(FakeGmailService(store))
    summaries = gmail.list_recent(query="")
    assert len(summaries) == 2
    s1 = next(s for s in summaries if s.id == "1")
    assert s1.subject == "Offer update"
    assert s1.sender == "prof@uni.edu"
    assert s1.unread is True


def test_gmail_apply_label_creates_and_modifies():
    store = {"1": _msg("1", "a@b.c", "Hi", "snippet")}
    svc = FakeGmailService(store)
    gmail = GmailConnector(svc)
    gmail.apply_label("1", "University")
    # label was created and the message was modified with the new label id
    msgs = svc.users().messages()
    assert msgs.modified
    _, body = msgs.modified[0]
    assert body["addLabelIds"] == ["L1"]


# --- Calendar fake ------------------------------------------------------------

class _FakeEventsApi:
    def __init__(self, items):
        self.items = items
        self.inserted = []
        self.patched = []
        self.deleted = []

    def list(self, **kwargs):
        return _Exec({"items": self.items})

    def insert(self, calendarId, body):
        self.inserted.append(body)
        return _Exec({"id": "new1", **body})

    def patch(self, calendarId, eventId, body):
        self.patched.append((eventId, body))
        return _Exec({})

    def delete(self, calendarId, eventId):
        self.deleted.append(eventId)
        return _Exec({})


class FakeCalendarService:
    def __init__(self, items):
        self._events = _FakeEventsApi(items)

    def events(self):
        return self._events


def test_calendar_upcoming_parses_events():
    items = [{
        "id": "e1",
        "summary": "Physics class",
        "start": {"dateTime": "2026-06-19T09:00:00Z"},
        "end": {"dateTime": "2026-06-19T10:00:00Z"},
        "location": "Room 1",
    }]
    cal = CalendarConnector(FakeCalendarService(items))
    events = cal.upcoming(days=2)
    assert len(events) == 1
    assert events[0].summary == "Physics class"
    assert events[0].location == "Room 1"


def test_calendar_create_event_inserts():
    svc = FakeCalendarService([])
    cal = CalendarConnector(svc)
    start = datetime(2026, 6, 20, 14, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    ev = cal.create_event("Revision session", start, end, description="Mechanics")
    assert ev.id == "new1"
    assert svc.events().inserted[0]["summary"] == "Revision session"
