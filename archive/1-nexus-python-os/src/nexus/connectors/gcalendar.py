"""Google Calendar connector: read upcoming events and create/edit them.

The Google ``service`` object is injected for testability.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass
class CalendarEvent:
    id: str
    summary: str
    start: str
    end: str
    location: str = ""
    description: str = ""
    account: str = ""


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


class CalendarConnector:
    def __init__(self, service, calendar_id: str = "primary", account: str = "") -> None:
        self.service = service
        self.calendar_id = calendar_id
        self.account = account

    @classmethod
    def connect(cls, account: str, calendar_id: str = "primary") -> "CalendarConnector":
        from nexus.connectors.google_auth import get_service

        return cls(get_service("calendar", "v3", account), calendar_id=calendar_id, account=account)

    # --- read -----------------------------------------------------------------

    def list_events(self, time_min: datetime, time_max: datetime,
                    max_results: int = 25) -> list[CalendarEvent]:
        resp = (
            self.service.events()
            .list(
                calendarId=self.calendar_id,
                timeMin=_iso(time_min),
                timeMax=_iso(time_max),
                singleEvents=True,
                orderBy="startTime",
                maxResults=max_results,
            )
            .execute()
        )
        events: list[CalendarEvent] = []
        for e in resp.get("items", []):
            start = e.get("start", {})
            end = e.get("end", {})
            events.append(
                CalendarEvent(
                    id=e.get("id", ""),
                    summary=e.get("summary", "(no title)"),
                    start=start.get("dateTime", start.get("date", "")),
                    end=end.get("dateTime", end.get("date", "")),
                    location=e.get("location", ""),
                    description=e.get("description", ""),
                    account=self.account,
                )
            )
        return events

    def upcoming(self, days: int = 1, max_results: int = 25) -> list[CalendarEvent]:
        now = datetime.now(timezone.utc)
        return self.list_events(now, now + timedelta(days=days), max_results)

    def today(self) -> list[CalendarEvent]:
        return self.upcoming(days=1)

    # --- write ----------------------------------------------------------------

    def create_event(self, summary: str, start: datetime, end: datetime,
                     description: str = "", location: str = "") -> CalendarEvent:
        body = {
            "summary": summary,
            "description": description,
            "location": location,
            "start": {"dateTime": _iso(start)},
            "end": {"dateTime": _iso(end)},
        }
        created = self.service.events().insert(calendarId=self.calendar_id, body=body).execute()
        return CalendarEvent(
            id=created.get("id", ""), summary=summary, start=_iso(start), end=_iso(end),
            location=location, description=description, account=self.account,
        )

    def update_event(self, event_id: str, **fields) -> None:
        self.service.events().patch(
            calendarId=self.calendar_id, eventId=event_id, body=fields
        ).execute()

    def delete_event(self, event_id: str) -> None:
        self.service.events().delete(calendarId=self.calendar_id, eventId=event_id).execute()
