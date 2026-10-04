"""Read Gmail over IMAP using an app password (no Google Cloud / OAuth).

The message-parsing logic is a pure function (``summary_from_message``) so it can
be unit-tested without a network or real account. The connector itself does the
IMAP fetch.
"""

from __future__ import annotations

import email
import imaplib
from email.header import decode_header, make_header
from email.message import Message

from nexus.connectors.gmail import EmailSummary

GMAIL_IMAP = "imap.gmail.com"


class MailError(RuntimeError):
    pass


def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:  # noqa: BLE001
        return value


def _snippet(msg: Message, limit: int = 160) -> str:
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.get_content_type() != "text/plain":
            continue
        if "attachment" in str(part.get("Content-Disposition", "")).lower():
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        text = payload.decode(part.get_content_charset() or "utf-8", "replace")
        return " ".join(text.split())[:limit]
    return ""


def summary_from_message(msg: Message, account: str, *, unread: bool = True) -> EmailSummary:
    return EmailSummary(
        id=(msg.get("Message-ID", "") or "").strip("<>"),
        sender=_decode(msg.get("From", "(unknown)")),
        subject=_decode(msg.get("Subject", "(no subject)")),
        snippet=_snippet(msg),
        unread=unread,
        account=account,
    )


class ImapMail:
    def __init__(self, address: str, password: str, host: str = GMAIL_IMAP) -> None:
        self.address = address
        self.password = password
        self.host = host

    @classmethod
    def connect(cls, address: str) -> "ImapMail":
        from nexus.connectors.simple_accounts import get_email_password

        pw = get_email_password(address)
        if not pw:
            raise MailError(f"No app password stored for {address}. Run: nexus email-add {address}")
        return cls(address, pw)

    def list_recent(self, max_results: int = 10, unread_only: bool = True) -> list[EmailSummary]:
        try:
            box = imaplib.IMAP4_SSL(self.host)
        except OSError as e:
            raise MailError(f"Could not reach {self.host}: {e}") from e
        try:
            box.login(self.address, self.password)
        except imaplib.IMAP4.error as e:
            raise MailError(
                f"Login failed for {self.address}. Check the app password "
                f"(and that IMAP is on in Gmail settings)."
            ) from e
        try:
            box.select("INBOX", readonly=True)
            criterion = "UNSEEN" if unread_only else "ALL"
            _typ, data = box.search(None, criterion)
            ids = data[0].split()
            ids = ids[-max_results:][::-1]  # newest first
            out: list[EmailSummary] = []
            for msg_id in ids:
                _typ, fetched = box.fetch(msg_id, "(RFC822)")
                raw = next((p[1] for p in fetched if isinstance(p, tuple)), None)
                if not raw:
                    continue
                out.append(summary_from_message(email.message_from_bytes(raw),
                                                self.address, unread=unread_only))
            return out
        finally:
            try:
                box.logout()
            except Exception:  # noqa: BLE001
                pass
