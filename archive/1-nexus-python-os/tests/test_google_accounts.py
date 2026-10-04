"""Multi-account bookkeeping + not-connected tool behavior (no Google needed).

Uses the isolated NEXUS_HOME from conftest so the account index writes to a temp
dir, never the real one.
"""

from __future__ import annotations

from nexus.connectors import google_auth
from nexus.tools.google_tools import build_google_tools


def test_account_index_roundtrip():
    assert google_auth.list_accounts() == []
    assert google_auth.main_account() is None

    google_auth._remember_account("main.account@gmail.com")
    google_auth._remember_account("second.account@gmail.com")
    assert google_auth.list_accounts() == [
        "main.account@gmail.com",
        "second.account@gmail.com",
    ]
    # First connected is "main".
    assert google_auth.main_account() == "main.account@gmail.com"


def test_account_index_no_duplicates_and_forget():
    google_auth._remember_account("a@x.com")
    google_auth._remember_account("b@y.com")
    google_auth._remember_account("a@x.com")  # dup ignored
    assert google_auth.list_accounts() == ["a@x.com", "b@y.com"]

    google_auth.forget_account("a@x.com")
    assert google_auth.list_accounts() == ["b@y.com"]
    assert google_auth.main_account() == "b@y.com"


def test_email_tools_report_not_connected_when_empty():
    tools = build_google_tools(router=None)
    res = tools.get("email_summary").run()
    assert res.ok is False
    assert "connect" in res.error.lower()

    res2 = tools.get("calendar_upcoming").run()
    assert res2.ok is False
    assert "connect" in res2.error.lower()
