"""Easy-path email (IMAP) + calendar (iCal): storage, parsing, and tools.

No network or real account needed — message/ics parsing are pure functions.
"""

from __future__ import annotations

from datetime import datetime, timezone
from email.message import EmailMessage

from nexus.connectors import simple_accounts
import pytest

from nexus.connectors.ical_cal import CalendarError, parse_ics, upcoming_from_ics, validate_calendar_url
from nexus.connectors.imap_mail import summary_from_message
from nexus.tools.mail_tools import build_mail_tools


# --- storage ------------------------------------------------------------------

def test_email_account_storage_roundtrip():
    assert simple_accounts.list_email_accounts() == []
    simple_accounts.add_email_account("main.account@gmail.com", "abcd efgh ijkl mnop")
    simple_accounts.add_email_account("second.account@gmail.com", "1111222233334444")
    assert simple_accounts.list_email_accounts() == [
        "main.account@gmail.com", "second.account@gmail.com"]
    # spaces are stripped from the app password
    assert simple_accounts.get_email_password("main.account@gmail.com") == "abcdefghijklmnop"
    simple_accounts.remove_email_account("main.account@gmail.com")
    assert simple_accounts.list_email_accounts() == ["second.account@gmail.com"]


def test_calendar_storage_roundtrip():
    simple_accounts.add_calendar("main", "https://calendar.google.com/private/abc.ics")
    assert simple_accounts.list_calendars() == ["main"]
    assert simple_accounts.get_calendar_url("main").endswith("abc.ics")


# --- imap parsing -------------------------------------------------------------

def test_summary_from_message():
    m = EmailMessage()
    m["From"] = "Prof X <prof@uni.edu>"
    m["Subject"] = "Offer update"
    m["Message-ID"] = "<abc123@mail>"
    m.set_content("Hello, your application is being reviewed. Best regards.")
    s = summary_from_message(m, "me@gmail.com")
    assert "prof@uni.edu" in s.sender
    assert s.subject == "Offer update"
    assert s.id == "abc123@mail"
    assert "application" in s.snippet
    assert s.account == "me@gmail.com"


# --- ical parsing -------------------------------------------------------------

_ICS = """BEGIN:VCALENDAR
BEGIN:VEVENT
UID:e1
SUMMARY:Physics class
DTSTART:20260619T090000Z
DTEND:20260619T100000Z
LOCATION:Room 1
END:VEVENT
BEGIN:VEVENT
UID:e2
SUMMARY:Dentist
DTSTART:20260625T140000Z
END:VEVENT
END:VCALENDAR"""


def test_parse_ics_reads_all_events():
    events = parse_ics(_ICS, "main")
    assert [e.summary for e in events] == ["Physics class", "Dentist"]
    assert events[0].location == "Room 1"
    assert events[0].account == "main"


def test_upcoming_filters_by_window():
    now = datetime(2026, 6, 19, 8, 0, tzinfo=timezone.utc)
    soon = upcoming_from_ics(_ICS, "main", now=now, days=1)
    assert [e.summary for e in soon] == ["Physics class"]  # dentist is 6 days out


def test_parse_ics_handles_tzid_and_folding():
    ics = (
        "BEGIN:VEVENT\r\n"
        "UID:e3\r\n"
        "SUMMARY:Long meeting title that is fol\r\n ded across lines\r\n"
        "DTSTART;TZID=Europe/London:20260620T140000\r\n"
        "END:VEVENT\r\n"
    )
    events = parse_ics(ics)
    assert len(events) == 1
    assert events[0].summary == "Long meeting title that is folded across lines"


# --- SSRF hardening for calendar URLs -----------------------------------------

@pytest.mark.parametrize("bad_url", [
    "http://calendar.google.com/cal.ics",      # not https
    "https://calendar.google.com/notacal",     # not .ics path
    "https://127.0.0.1/basic.ics",             # loopback
    "https://10.0.0.5/basic.ics",              # private (RFC1918)
    "https://169.254.169.254/basic.ics",       # link-local (cloud metadata)
    "https://[::1]/basic.ics",                 # IPv6 loopback
])
def test_validate_calendar_url_rejects(bad_url):
    with pytest.raises(CalendarError):
        validate_calendar_url(bad_url)


def test_validate_calendar_url_allows_public_https_ics():
    # Public IP literal (no DNS needed) with an .ics path is allowed.
    validate_calendar_url("https://8.8.8.8/calendar/basic.ics")


# --- tools degrade gracefully -------------------------------------------------

def test_mail_tools_not_connected():
    tools = build_mail_tools(router=None)
    assert tools.get("email_summary").run().ok is False
    assert tools.get("calendar_upcoming").run().ok is False
    # calendar editing is intentionally read-only in easy mode
    assert tools.get("calendar_create").run().ok is False
    assert tools.get("email_send").run(to="x@y.com", subject="hi", body="hey").ok is False


def test_email_send_via_smtp(monkeypatch):
    from nexus.connectors import simple_accounts, smtp_mail

    simple_accounts.add_email_account("me@gmail.com", "app pass word")
    captured = {}

    class _FakeSMTP:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def login(self, user, pw):
            captured["auth"] = (user, pw)

        def send_message(self, msg):
            captured["msg"] = msg

    monkeypatch.setattr(smtp_mail.smtplib, "SMTP_SSL", lambda *a, **k: _FakeSMTP())
    out = smtp_mail.send_email("me@gmail.com", "you@example.com", "Hi", "Hello there")
    assert "you@example.com" in out
    assert captured["auth"] == ("me@gmail.com", "apppassword")   # spaces stripped on store
    assert captured["msg"]["To"] == "you@example.com"
    assert captured["msg"]["Subject"] == "Hi"
