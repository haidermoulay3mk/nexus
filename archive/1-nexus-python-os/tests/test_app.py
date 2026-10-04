"""Composition root + CLI integration (offline; no Ollama required)."""

from __future__ import annotations

from nexus.app import NexusApp
from nexus.interface.cli.main import main


def test_app_loads_agents_and_tools():
    app = NexusApp(db_file=":memory:")
    assert "study" in app.agents.names()
    assert "assistant" in app.agents.names()
    assert "productivity" in app.agents.names()
    # Combined tool registry exposes study + productivity + memory tools.
    assert "study_log_paper" in app.tools.names()
    assert "task_add" in app.tools.names()
    assert "mem_recall" in app.tools.names()


def test_app_loads_email_and_calendar_agents():
    app = NexusApp(db_file=":memory:")
    for name in ("email", "calendar"):
        assert name in app.agents.names()
    assert "email_summary" in app.tools.names()
    assert "calendar_upcoming" in app.tools.names()


def test_google_tools_fail_gracefully_without_setup():
    # No OAuth / no google libs installed -> tool returns ok=False with guidance,
    # never raises. This is what keeps Nexus usable before Google is connected.
    app = NexusApp(db_file=":memory:")
    result = app.tools.get("email_summary").run()
    assert result.ok is False
    assert "connect" in result.error.lower()


def test_app_doctor_snapshot():
    app = NexusApp(db_file=":memory:")
    h = app.doctor()
    for key in ("ollama_available", "host", "tiers", "agents", "db_path", "home"):
        assert key in h
    assert h["tiers"]["balanced"]["model"] == "qwen2.5:3b-instruct"


def test_app_study_roundtrip():
    app = NexusApp(db_file=":memory:")
    app.study.seed_default_subjects()
    r = app.study.log_paper("Physics", 30, 50)
    assert r.percentage == 60.0


def test_cli_offline_commands_exit_zero():
    # setup seeds subjects; study paper logs a result; both should return 0.
    assert main(["setup"]) == 0
    assert main(["study", "paper", "Physics", "10", "20"]) == 0
    assert main(["study", "progress"]) == 0
    assert main(["remember", "Mock exam Friday", "--title", "exam"]) == 0
    assert main(["recall", "exam"]) == 0
