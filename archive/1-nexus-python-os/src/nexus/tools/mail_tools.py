"""Email + Calendar tools for the "easy path" (IMAP app password + iCal URL).

Same tool names the Email/Calendar agents already use, so nothing else changes.
Email is full read + summarize across all connected accounts; calendar is
read-only (lists upcoming events). Creating/editing events needs the OAuth path,
which isn't set up here, so those tools return a clear read-only message.
"""

from __future__ import annotations

from nexus.kernel.registry import Registry
from nexus.kernel.types import ChatMessage, ModelTier, ToolResult
from nexus.tools.base import Tool, ToolParam

_NO_EMAIL = "No email account connected yet. Add one with `nexus email-add <your-email>`."
_NO_CAL = "No calendar connected yet. Add one with `nexus calendar-add <name> <link>`."
_READONLY = ("Calendar is read-only in easy mode, so I can't add or change events yet. "
             "I can tell you what's coming up. (Editing needs the Google sign-in setup.)")


def build_mail_tools(router) -> Registry:
    reg: Registry = Registry("tool")

    def _email_accounts():
        from nexus.connectors.simple_accounts import list_email_accounts
        return list_email_accounts()

    def _calendars():
        from nexus.connectors.simple_accounts import list_calendars
        return list_calendars()

    # --- email ---------------------------------------------------------------

    def _fetch_unread(max_results):
        from nexus.connectors.imap_mail import ImapMail

        blocks, errors = [], []
        for acct in _email_accounts():
            try:
                items = ImapMail.connect(acct).list_recent(max_results=int(max_results),
                                                            unread_only=True)
                blocks.append((acct, items))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{acct}: {e}")
        return blocks, errors

    def email_list_unread(max_results: int = 10):
        if not _email_accounts():
            return ToolResult.fail(_NO_EMAIL)
        blocks, errors = _fetch_unread(max_results)
        lines = [f"account={acct} id={s.id} | {s.sender} | {s.subject}"
                 for acct, items in blocks for s in items]
        if not lines and errors:
            return ToolResult.fail("; ".join(errors))
        return lines or ["No unread email in any account."]

    def email_summary(max_results: int = 10):
        if not _email_accounts():
            return ToolResult.fail(_NO_EMAIL)
        blocks, errors = _fetch_unread(max_results)
        text_blocks = []
        for acct, items in blocks:
            if items:
                lines = "\n".join(f"- From {s.sender}: {s.subject} - {s.snippet}" for s in items)
                text_blocks.append(f"[{acct}]\n{lines}")
        if not text_blocks:
            if errors:
                return ToolResult.fail("; ".join(errors))
            return "No unread messages in any connected account."
        joined = "\n\n".join(text_blocks)
        try:
            return router.complete(
                [
                    ChatMessage(role="system", content=(
                        "Summarize these inboxes for the user in a few bullets, grouped by "
                        "account. Flag anything needing a reply or with a deadline.")),
                    ChatMessage(role="user", content=joined),
                ],
                tier=ModelTier.BALANCED,
            )
        except Exception:  # noqa: BLE001 - offline: return the grouped list
            return joined

    def email_label(account: str = "", message_id: str = "", label: str = ""):
        return ToolResult.fail("Labeling isn't available in easy mode yet; I can read, "
                               "summarize, and send mail, though.")

    def email_send(to: str, subject: str, body: str, account: str = ""):
        from nexus.connectors.simple_accounts import list_email_accounts
        from nexus.connectors.smtp_mail import MailSendError, send_email

        accounts = list_email_accounts()
        if not accounts:
            return ToolResult.fail(_NO_EMAIL)
        sender = account or accounts[0]      # default to the main (first) account
        try:
            return send_email(sender, to, subject, body)
        except MailSendError as e:
            return ToolResult.fail(str(e))

    # --- calendar (read-only) ------------------------------------------------

    def calendar_upcoming(days: int = 1):
        from nexus.connectors.ical_cal import IcalCalendar

        if not _calendars():
            return ToolResult.fail(_NO_CAL)
        lines, errors = [], []
        for name in _calendars():
            try:
                for e in IcalCalendar.connect(name).upcoming(days=int(days)):
                    loc = f" @ {e.location}" if e.location else ""
                    lines.append(f"calendar={e.account} | {e.start} | {e.summary}{loc}")
            except Exception as ex:  # noqa: BLE001
                errors.append(f"{name}: {ex}")
        if not lines and errors:
            return ToolResult.fail("; ".join(errors))
        return lines or ["Nothing scheduled."]

    def calendar_create(summary: str = "", start: str = "", end: str = "",
                        description: str = "", account: str = ""):
        return ToolResult.fail(_READONLY)

    def calendar_delete(account: str = "", event_id: str = ""):
        return ToolResult.fail(_READONLY)

    tools = [
        Tool("email_list_unread", "List unread emails across all accounts", email_list_unread,
             [ToolParam("max_results", "int", required=False)]),
        Tool("email_summary", "Summarize the unread inbox across all accounts", email_summary,
             [ToolParam("max_results", "int", required=False)]),
        Tool("email_label", "Apply a label to an email (not available in easy mode)", email_label,
             [ToolParam("account", required=False), ToolParam("message_id", required=False),
              ToolParam("label", required=False)]),
        Tool("email_send", "Send an email (compose or reply) from a connected account", email_send,
             [ToolParam("to"), ToolParam("subject"), ToolParam("body"),
              ToolParam("account", required=False)]),
        Tool("calendar_upcoming", "List upcoming events across all calendars", calendar_upcoming,
             [ToolParam("days", "int", required=False)]),
        Tool("calendar_create", "Create a calendar event (needs the Google sign-in setup)",
             calendar_create, [ToolParam("summary", required=False), ToolParam("start", required=False),
                               ToolParam("end", required=False), ToolParam("description", required=False),
                               ToolParam("account", required=False)]),
        Tool("calendar_delete", "Delete a calendar event (needs the Google sign-in setup)",
             calendar_delete, [ToolParam("account", required=False), ToolParam("event_id", required=False)]),
    ]
    for t in tools:
        reg.register(t.name, t)
    return reg
