"""Read a Google Calendar via its private iCal (.ics) URL — no OAuth.

Read-only: lists upcoming events. Parsing is a pure function so it can be tested
without the network. Creating/editing events needs the OAuth path (not this one).
"""

from __future__ import annotations

import ipaddress
import re
import socket
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from nexus.connectors.gcalendar import CalendarEvent


class CalendarError(RuntimeError):
    pass


def validate_calendar_url(url: str) -> None:
    """Reject anything that isn't a public HTTPS .ics link (SSRF hardening).

    The URL is fetched server-side, so a crafted link could otherwise target
    loopback/private/link-local addresses (e.g. cloud metadata at 169.254.169.254
    or a local service). We require https, an .ics path, and that every resolved
    IP is a public address.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise CalendarError("Calendar link must start with https://")
    if not parsed.path.lower().endswith(".ics"):
        raise CalendarError("That doesn't look like an iCal (.ics) link.")
    host = parsed.hostname
    if not host:
        raise CalendarError("Invalid calendar link.")
    port = parsed.port or 443
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise CalendarError(f"Could not resolve the calendar host '{host}'.") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise CalendarError("That link points to a non-public address; refusing to fetch it.")


def _unfold(text: str) -> str:
    # RFC 5545 line folding: a CRLF followed by space/tab continues the line.
    return re.sub(r"\r?\n[ \t]", "", text)


def _parse_dt(value: str) -> datetime | None:
    value = value.strip()
    try:
        if value.endswith("Z"):
            dt = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        elif "T" in value:
            dt = datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        elif len(value) == 8:
            dt = datetime.strptime(value, "%Y%m%d").replace(tzinfo=timezone.utc)
        else:
            return None
    except ValueError:
        return None
    return dt


def _field(block: str, name: str) -> str:
    # Match "NAME" or "NAME;params" up to the first colon, then the value.
    m = re.search(rf"^{name}(?:;[^:\r\n]*)?:(.*)$", block, re.MULTILINE)
    return m.group(1).strip() if m else ""


def parse_ics(text: str, account: str = "") -> list[CalendarEvent]:
    """Parse all VEVENTs into CalendarEvents (start as ISO 8601 UTC)."""
    text = _unfold(text)
    events: list[CalendarEvent] = []
    for block in re.findall(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.DOTALL):
        start = _parse_dt(_field(block, "DTSTART"))
        if start is None:
            continue
        end = _parse_dt(_field(block, "DTEND"))
        events.append(CalendarEvent(
            id=_field(block, "UID"),
            summary=_field(block, "SUMMARY") or "(no title)",
            start=start.isoformat(),
            end=(end.isoformat() if end else ""),
            location=_field(block, "LOCATION"),
            description=_field(block, "DESCRIPTION"),
            account=account,
        ))
    return events


def upcoming_from_ics(text: str, account: str, *, now: datetime | None = None,
                      days: int = 1) -> list[CalendarEvent]:
    now = now or datetime.now(timezone.utc)
    horizon = now + timedelta(days=days)
    out = []
    for ev in parse_ics(text, account):
        start = datetime.fromisoformat(ev.start)
        if now <= start <= horizon:
            out.append(ev)
    out.sort(key=lambda e: e.start)
    return out


class IcalCalendar:
    def __init__(self, name: str, url: str) -> None:
        self.name = name
        self.url = url

    @classmethod
    def connect(cls, name: str) -> "IcalCalendar":
        from nexus.connectors.simple_accounts import get_calendar_url

        url = get_calendar_url(name)
        if not url:
            raise CalendarError(f"No calendar URL stored for '{name}'. Run: nexus calendar-add")
        return cls(name, url)

    def upcoming(self, days: int = 1) -> list[CalendarEvent]:
        validate_calendar_url(self.url)
        try:
            # Redirects are NOT followed: a redirect could bounce to a private
            # address that bypasses the up-front validation.
            resp = httpx.get(self.url, timeout=20.0, follow_redirects=False)
        except httpx.HTTPError as e:
            raise CalendarError(f"Could not reach the calendar host ({type(e).__name__}).") from e
        if resp.is_redirect:
            raise CalendarError("The calendar link redirected; refusing to follow it.")
        if resp.status_code != 200:
            raise CalendarError(f"The calendar link returned status {resp.status_code}.")
        body = resp.text
        if "BEGIN:VCALENDAR" not in body[:512].upper():
            raise CalendarError("That link did not return a calendar.")
        return upcoming_from_ics(body, self.name, days=days)
