"""Google OAuth with multi-account support.

One Google Cloud OAuth client (one ``google_client_secret.json``) can authorize
several Google accounts. You run the consent flow once per account, signing in
with each; Nexus stores a separate token per account (keyed by email) in the OS
keychain, and remembers the list of connected accounts.

Setup (one-time, by the user):
1. Create a Google Cloud project; enable the Gmail API and Google Calendar API.
2. Create an OAuth client ID of type "Desktop app".
3. Download the client secret JSON to:
       <NEXUS_HOME>/credentials/google_client_secret.json
4. Run ``nexus connect google`` once per account (it opens a browser each time).
"""

from __future__ import annotations

import json

from nexus.kernel import credentials, paths

# gmail.modify allows reading + labeling (organizing) without full account access.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
]


class GoogleAuthError(RuntimeError):
    pass


def client_secret_path():
    return paths.credentials_dir() / "google_client_secret.json"


def is_configured() -> bool:
    """True if the user has added their OAuth client secret file."""
    return client_secret_path().exists()


def _accounts_index():
    return paths.credentials_dir() / "google_accounts.json"


def list_accounts() -> list[str]:
    """Connected account emails, in the order they were connected (main first)."""
    f = _accounts_index()
    if f.exists():
        try:
            return list(json.loads(f.read_text(encoding="utf-8")).get("accounts", []))
        except (OSError, json.JSONDecodeError):
            return []
    return []


def main_account() -> str | None:
    accts = list_accounts()
    return accts[0] if accts else None


def _remember_account(email: str) -> None:
    accts = list_accounts()
    if email not in accts:
        accts.append(email)
    _accounts_index().write_text(json.dumps({"accounts": accts}), encoding="utf-8")


def forget_account(email: str) -> None:
    credentials.delete_secret(_token_key(email))
    accts = [a for a in list_accounts() if a != email]
    _accounts_index().write_text(json.dumps({"accounts": accts}), encoding="utf-8")


def _token_key(email: str) -> str:
    return f"google_oauth_token::{email}"


def _require_libs():
    try:
        from google.oauth2.credentials import Credentials  # noqa: PLC0415
        from google_auth_oauthlib.flow import InstalledAppFlow  # noqa: PLC0415
        from google.auth.transport.requests import Request  # noqa: PLC0415
        from googleapiclient.discovery import build  # noqa: PLC0415

        return Credentials, InstalledAppFlow, Request, build
    except ImportError as e:
        raise GoogleAuthError(
            "Google libraries not installed. Run: pip install -e .[google]"
        ) from e


def _email_of(creds) -> str:
    """Read the signed-in account's email (works with the gmail scope)."""
    _, _, _, build = _require_libs()
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    profile = service.users().getProfile(userId="me").execute()
    return profile.get("emailAddress", "unknown")


def connect_account(scopes: list[str] | None = None) -> str:
    """Run the consent flow for one account; store its token; return its email.

    Shows the account chooser so a different Google account can be picked each
    time this is run.
    """
    Credentials, InstalledAppFlow, Request, _ = _require_libs()
    if not is_configured():
        raise GoogleAuthError(
            f"Missing OAuth client secret. Place it at: {client_secret_path()}"
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(client_secret_path()), scopes or SCOPES)
    creds = flow.run_local_server(port=0, prompt="select_account consent")
    email = _email_of(creds)
    credentials.set_secret(_token_key(email), creds.to_json())
    _remember_account(email)
    return email


def get_credentials(email: str, scopes: list[str] | None = None):
    """Return valid credentials for a connected account, refreshing if needed."""
    Credentials, _, Request, _ = _require_libs()
    stored = credentials.get_secret(_token_key(email))
    if not stored:
        raise GoogleAuthError(f"Account '{email}' is not connected. Run: nexus connect google")
    creds = Credentials.from_authorized_user_info(json.loads(stored), scopes or SCOPES)
    if creds.valid:
        return creds
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        credentials.set_secret(_token_key(email), creds.to_json())
        return creds
    raise GoogleAuthError(f"Account '{email}' needs reconnecting. Run: nexus connect google")


def get_service(api: str, version: str, email: str, scopes: list[str] | None = None):
    """Build an authorized Google API client for a specific account."""
    _, _, _, build = _require_libs()
    creds = get_credentials(email, scopes)
    return build(api, version, credentials=creds, cache_discovery=False)
