"""Gmail connector: read recent mail and organize it with labels.

The Google ``service`` object is injected, so this class is fully unit-testable
with a fake that mimics the Gmail API's call chain.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class EmailSummary:
    id: str
    sender: str
    subject: str
    snippet: str
    unread: bool
    account: str = ""


class GmailConnector:
    def __init__(self, service, account: str = "") -> None:
        self.service = service
        self.account = account

    @classmethod
    def connect(cls, account: str) -> "GmailConnector":
        from nexus.connectors.google_auth import get_service

        return cls(get_service("gmail", "v1", account), account=account)

    def list_recent(self, max_results: int = 10, query: str = "is:unread") -> list[EmailSummary]:
        """Return lightweight summaries of recent messages matching ``query``."""
        resp = (
            self.service.users()
            .messages()
            .list(userId="me", q=query, maxResults=max_results)
            .execute()
        )
        out: list[EmailSummary] = []
        for ref in resp.get("messages", []):
            msg = (
                self.service.users()
                .messages()
                .get(userId="me", id=ref["id"], format="metadata",
                     metadataHeaders=["From", "Subject"])
                .execute()
            )
            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            labels = msg.get("labelIds", [])
            out.append(
                EmailSummary(
                    id=msg.get("id", ref["id"]),
                    sender=headers.get("From", "(unknown)"),
                    subject=headers.get("Subject", "(no subject)"),
                    snippet=msg.get("snippet", ""),
                    unread="UNREAD" in labels,
                    account=self.account,
                )
            )
        return out

    def ensure_label(self, name: str) -> str:
        """Return the label id for ``name``, creating it if needed."""
        existing = self.service.users().labels().list(userId="me").execute()
        for lbl in existing.get("labels", []):
            if lbl["name"].lower() == name.lower():
                return lbl["id"]
        created = (
            self.service.users()
            .labels()
            .create(userId="me", body={"name": name})
            .execute()
        )
        return created["id"]

    def apply_label(self, message_id: str, label_name: str) -> None:
        label_id = self.ensure_label(label_name)
        self.service.users().messages().modify(
            userId="me", id=message_id, body={"addLabelIds": [label_id]}
        ).execute()

    def mark_read(self, message_id: str) -> None:
        self.service.users().messages().modify(
            userId="me", id=message_id, body={"removeLabelIds": ["UNREAD"]}
        ).execute()
