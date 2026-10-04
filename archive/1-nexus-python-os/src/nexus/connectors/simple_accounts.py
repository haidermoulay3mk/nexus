"""Storage for the "easy path" email + calendar connections.

No Google Cloud / OAuth. Email uses an app password over IMAP; calendar uses a
private iCal (.ics) URL. Secrets live in the OS keychain; small index files in
the credentials dir remember which accounts/calendars exist.
"""

from __future__ import annotations

import json

from nexus.kernel import credentials, paths


# --- email accounts (IMAP app passwords) --------------------------------------

def _email_index():
    return paths.credentials_dir() / "email_accounts.json"


def _email_key(address: str) -> str:
    return f"imap_password::{address}"


def list_email_accounts() -> list[str]:
    f = _email_index()
    if f.exists():
        try:
            return list(json.loads(f.read_text(encoding="utf-8")).get("accounts", []))
        except (OSError, json.JSONDecodeError):
            return []
    return []


def add_email_account(address: str, app_password: str) -> None:
    address = address.strip()
    # Gmail app passwords are shown with spaces; they work with or without them.
    credentials.set_secret(_email_key(address), app_password.replace(" ", ""))
    accts = list_email_accounts()
    if address not in accts:
        accts.append(address)
    _email_index().write_text(json.dumps({"accounts": accts}), encoding="utf-8")


def get_email_password(address: str) -> str | None:
    return credentials.get_secret(_email_key(address))


def remove_email_account(address: str) -> None:
    credentials.delete_secret(_email_key(address))
    accts = [a for a in list_email_accounts() if a != address]
    _email_index().write_text(json.dumps({"accounts": accts}), encoding="utf-8")


# --- calendars (private iCal URLs) --------------------------------------------

def _cal_index():
    return paths.credentials_dir() / "calendars.json"


def _cal_key(name: str) -> str:
    return f"ical_url::{name}"


def list_calendars() -> list[str]:
    f = _cal_index()
    if f.exists():
        try:
            return list(json.loads(f.read_text(encoding="utf-8")).get("calendars", []))
        except (OSError, json.JSONDecodeError):
            return []
    return []


def add_calendar(name: str, ical_url: str) -> None:
    name = name.strip()
    credentials.set_secret(_cal_key(name), ical_url.strip())
    names = list_calendars()
    if name not in names:
        names.append(name)
    _cal_index().write_text(json.dumps({"calendars": names}), encoding="utf-8")


def get_calendar_url(name: str) -> str | None:
    return credentials.get_secret(_cal_key(name))


def remove_calendar(name: str) -> None:
    credentials.delete_secret(_cal_key(name))
    names = [n for n in list_calendars() if n != name]
    _cal_index().write_text(json.dumps({"calendars": names}), encoding="utf-8")
