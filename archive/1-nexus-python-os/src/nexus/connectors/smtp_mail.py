"""Send email via Gmail SMTP using the same App Password used for reading.

No OAuth needed: with an App Password, IMAP reads and SMTP sends both work, which
together give full control of the account (read + send/reply).
"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage

GMAIL_SMTP = "smtp.gmail.com"
GMAIL_SMTP_PORT = 465


class MailSendError(RuntimeError):
    pass


def send_email(account: str, to: str, subject: str, body: str,
               *, in_reply_to: str = "") -> str:
    """Send an email from a connected account. Returns a confirmation string."""
    from nexus.connectors.simple_accounts import get_email_password

    password = get_email_password(account)
    if not password:
        raise MailSendError(f"No app password stored for {account}. Connect it first.")
    if not to.strip():
        raise MailSendError("No recipient given.")

    msg = EmailMessage()
    msg["From"] = account
    msg["To"] = to
    msg["Subject"] = subject or "(no subject)"
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(body or "")

    try:
        with smtplib.SMTP_SSL(GMAIL_SMTP, GMAIL_SMTP_PORT,
                              context=ssl.create_default_context()) as server:
            server.login(account, password)
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError as e:
        raise MailSendError("Login failed — check the App Password and that IMAP/SMTP are on.") from e
    except (smtplib.SMTPException, OSError) as e:
        raise MailSendError(f"Could not send the email ({type(e).__name__}).") from e
    return f"Sent to {to}."
