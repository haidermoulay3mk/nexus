"""Email + Calendar tools backed by the Google connectors, multi-account aware.

Everything aggregates across all connected Google accounts (each result is tagged
with the account it came from). Connections are resolved fresh on each call, so
newly connected accounts appear without restarting. When nothing is connected (or
the libraries/hardware are missing), tools return a friendly ToolResult.fail.
"""

from __future__ import annotations

from datetime import datetime

from nexus.kernel.registry import Registry
from nexus.kernel.types import ChatMessage, ModelTier, ToolResult
from nexus.tools.base import Tool, ToolParam

_NOT_CONNECTED = "No Google account connected yet. Run `nexus connect google` (you can run it once per account)."


def _accounts() -> list[str]:
    from nexus.connectors import google_auth

    return google_auth.list_accounts()


def _gmail(account: str):
    from nexus.connectors.gmail import GmailConnector

    return GmailConnector.connect(account)


def _calendar(account: str):
    from nexus.connectors.gcalendar import CalendarConnector

    return CalendarConnector.connect(account)


def build_google_tools(router) -> Registry:
    reg: Registry = Registry("tool")

    # --- email ---------------------------------------------------------------

    def email_list_unread(max_results: int = 10):
        accounts = _accounts()
        if not accounts:
            return ToolResult.fail(_NOT_CONNECTED)
        lines, errors = [], []
        for acct in accounts:
            try:
                for s in _gmail(acct).list_recent(max_results=int(max_results), query="is:unread"):
                    lines.append(f"account={s.account} id={s.id} | {s.sender} | {s.subject}")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{acct}: {type(e).__name__}")
        if not lines and errors:
            return ToolResult.fail("; ".join(errors) + " - try `nexus connect google`")
        return lines or ["No unread email in any account."]

    def email_summary(max_results: int = 10):
        accounts = _accounts()
        if not accounts:
            return ToolResult.fail(_NOT_CONNECTED)
        blocks, errors = [], []
        for acct in accounts:
            try:
                items = _gmail(acct).list_recent(max_results=int(max_results), query="is:unread")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{acct}: {type(e).__name__}")
                continue
            if items:
                lines = "\n".join(f"- From {s.sender}: {s.subject} - {s.snippet}" for s in items)
                blocks.append(f"[{acct}]\n{lines}")
        if not blocks:
            if errors:
                return ToolResult.fail("; ".join(errors) + " - try `nexus connect google`")
            return "No unread messages in any connected account."
        joined = "\n\n".join(blocks)
        try:
            return router.complete(
                [
                    ChatMessage(role="system", content=(
                        "Summarize these inboxes for the user in a few bullet points, grouped by "
                        "account. Note anything that needs a reply or has a deadline.")),
                    ChatMessage(role="user", content=joined),
                ],
                tier=ModelTier.BALANCED,
            )
        except Exception:  # noqa: BLE001 - offline: return the raw grouped list
            return joined

    def email_label(account: str, message_id: str, label: str):
        try:
            _gmail(account).apply_label(message_id, label)
        except Exception as e:  # noqa: BLE001
            return ToolResult.fail(f"Couldn't label ({type(e).__name__}). Check the account/id.")
        return f"Labeled message {message_id} in {account} as '{label}'."

    # --- calendar ------------------------------------------------------------

    def calendar_upcoming(days: int = 1):
        accounts = _accounts()
        if not accounts:
            return ToolResult.fail(_NOT_CONNECTED)
        lines, errors = [], []
        for acct in accounts:
            try:
                for e in _calendar(acct).upcoming(days=int(days)):
                    loc = f" @ {e.location}" if e.location else ""
                    lines.append(f"account={e.account} id={e.id} | {e.start} | {e.summary}{loc}")
            except Exception as ex:  # noqa: BLE001
                errors.append(f"{acct}: {type(ex).__name__}")
        if not lines and errors:
            return ToolResult.fail("; ".join(errors) + " - try `nexus connect google`")
        return lines or ["Nothing scheduled."]

    def calendar_create(summary: str, start: str, end: str, description: str = "", account: str = ""):
        from nexus.connectors import google_auth

        acct = account or google_auth.main_account()
        if not acct:
            return ToolResult.fail(_NOT_CONNECTED)
        try:
            start_dt = datetime.fromisoformat(start)
            end_dt = datetime.fromisoformat(end)
        except ValueError:
            return ToolResult.fail("start/end must be ISO 8601, e.g. 2026-06-20T14:00:00.")
        try:
            ev = _calendar(acct).create_event(summary, start_dt, end_dt, description=description)
        except Exception as e:  # noqa: BLE001
            return ToolResult.fail(f"Couldn't create the event ({type(e).__name__}).")
        return f"Created '{ev.summary}' in {acct} (id={ev.id})."

    def calendar_delete(account: str, event_id: str):
        try:
            _calendar(account).delete_event(event_id)
        except Exception as e:  # noqa: BLE001
            return ToolResult.fail(f"Couldn't delete ({type(e).__name__}). Check the account/id.")
        return f"Deleted event {event_id} from {account}."

    tools = [
        Tool("email_list_unread", "List unread emails across all accounts (account, id, sender, subject)",
             email_list_unread, [ToolParam("max_results", "int", required=False)]),
        Tool("email_summary", "Summarize the unread inbox across all accounts", email_summary,
             [ToolParam("max_results", "int", required=False)]),
        Tool("email_label", "Apply a label to an email (needs its account and id)", email_label,
             [ToolParam("account"), ToolParam("message_id"), ToolParam("label")]),
        Tool("calendar_upcoming", "List upcoming events across all calendars", calendar_upcoming,
             [ToolParam("days", "int", required=False)]),
        Tool("calendar_create", "Create a calendar event (ISO start/end; account optional, defaults to main)",
             calendar_create, [ToolParam("summary"), ToolParam("start"), ToolParam("end"),
                               ToolParam("description", required=False), ToolParam("account", required=False)]),
        Tool("calendar_delete", "Delete a calendar event (needs its account and id)", calendar_delete,
             [ToolParam("account"), ToolParam("event_id")]),
    ]
    for t in tools:
        reg.register(t.name, t)
    return reg
