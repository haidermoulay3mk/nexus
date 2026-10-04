"""Dashboard endpoints, exercised with FastAPI's TestClient (offline).

Skipped automatically if the optional web extra isn't installed."""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402

from nexus.app import NexusApp  # noqa: E402
from nexus.interface.api.server import create_app  # noqa: E402


@pytest.fixture
def client():
    app = NexusApp(db_file=":memory:")
    app.study.seed_default_subjects()
    app.study.add_topic("Physics", "Projectile Motion", confidence=1)
    return TestClient(create_app(app))


def test_home_renders(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "NEXUS" in r.text
    assert 'id="askInput"' in r.text       # command input present
    assert '/favicon.svg' in r.text        # tab icon is linked


def test_favicon_served(client):
    r = client.get("/favicon.svg")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/svg+xml")
    assert "<svg" in r.text


def test_voice_mode_present(client):
    html = client.get("/").text
    assert 'id="reactor"' in html          # full-screen arc-reactor canvas
    assert 'id="voice"' in html
    assert 'id="voiceListen"' in html      # explicit listen control
    assert "/api/voice/status" in html     # voice readiness is shown in the UI
    for state in ("listening", "thinking", "speaking"):
        assert state in html               # voice states referenced in the script


def test_settings_modal_present(client):
    html = client.get("/").text
    assert 'id="settings"' in html         # settings modal
    assert 'id="emEmail"' in html          # email field
    assert 'id="calUrl"' in html           # calendar field
    assert 'id="gemKey"' in html           # gemini key field


def test_connections_endpoint_lists(client):
    r = client.get("/api/connections")
    assert r.status_code == 200
    body = r.json()
    assert body == {"emails": [], "calendars": []}


def test_add_email_validates_input(client):
    r = client.post("/api/connections/email", json={"email": "", "password": ""})
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_add_calendar_rejects_non_https(client):
    r = client.post("/api/connections/calendar", json={"name": "main", "url": "http://nope.com/x.ics"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "https" in body["error"].lower()


def test_add_calendar_rejects_private_address(client):
    # SSRF guard: a link resolving to a private/loopback host is refused, and
    # nothing is stored.
    r = client.post("/api/connections/calendar",
                    json={"name": "main", "url": "https://127.0.0.1/basic.ics"})
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert client.get("/api/connections").json()["calendars"] == []


def test_remove_email_and_calendar(client):
    from nexus.connectors.simple_accounts import add_calendar, add_email_account

    add_email_account("x@y.com", "pw")
    add_calendar("main", "https://calendar.google.com/x/basic.ics")
    listed = client.get("/api/connections").json()
    assert listed["emails"] == ["x@y.com"] and listed["calendars"] == ["main"]

    client.post("/api/connections/email/remove", json={"email": "x@y.com"})
    client.post("/api/connections/calendar/remove", json={"name": "main"})
    after = client.get("/api/connections").json()
    assert after["emails"] == [] and after["calendars"] == []


def test_ask_never_crashes_on_model_error(client, monkeypatch):
    # A model error (e.g. Gemini 429) must return a friendly JSON reply, not a 500.
    monkeypatch.setattr("nexus.models.router.ModelRouter.is_ready", lambda self: True)

    def _boom(self, text):
        raise RuntimeError("Gemini API error (429). Check your key.")

    monkeypatch.setattr("nexus.app.NexusApp.ask", _boom)
    r = client.post("/api/ask", json={"text": "hi"})
    assert r.status_code == 200
    assert "rate" in r.json()["answer"].lower()


def test_speak_empty_is_ok(client):
    r = client.post("/api/speak", json={"text": ""})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_speak_uses_windows_sapi(client, monkeypatch):
    pytest.importorskip("win32com.client")
    import win32com.client

    class _FakeVoices:
        Count = 1

        def Item(self, i):
            return type("V", (), {"GetDescription": lambda self: "English (United States)"})()

    class _FakeVoice:
        def __init__(self):
            self.spoken = []
            self.Voice = None

        def GetVoices(self):
            return _FakeVoices()

        def Speak(self, text):
            self.spoken.append(text)

    fake = _FakeVoice()
    monkeypatch.setattr(win32com.client, "Dispatch", lambda name: fake)
    r = client.post("/api/speak", json={"text": "Hello, sir."})
    assert r.json()["ok"] is True
    assert fake.spoken and "Hello" in fake.spoken[0]


def test_voice_transcribe_silence(client, monkeypatch):
    # record_segment returns None when no speech was heard -> spoke False.
    monkeypatch.setattr("nexus.speech.runtime.record_segment", lambda *a, **k: None)
    r = client.post("/api/voice/transcribe")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["spoke"] is False


def test_voice_transcribe_speech(client, monkeypatch):
    monkeypatch.setattr("nexus.speech.runtime.record_segment", lambda *a, **k: "seg.wav")
    monkeypatch.setattr("nexus.speech.runtime.transcribe_wav", lambda nx, p: "hey nexus")
    r = client.post("/api/voice/transcribe")
    body = r.json()
    assert body["ok"] is True and body["spoke"] is True
    assert body["transcript"] == "hey nexus"


def test_voice_listen_mic_unavailable(client, monkeypatch):
    # Any capture error -> ok False, never a 500.
    def _boom(*a, **k):
        raise RuntimeError("no input device")

    monkeypatch.setattr("nexus.speech.runtime.record_segment", _boom)
    r = client.post("/api/voice/listen")
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_voice_listen_routes_to_agent(client, monkeypatch):
    monkeypatch.setattr("nexus.speech.runtime.record_segment", lambda *a, **k: "seg.wav")
    monkeypatch.setattr("nexus.speech.runtime.transcribe_wav", lambda nx, p: "add a task to call mum")
    # Stub the model so no Ollama/Gemini is needed; agent returns immediately.
    monkeypatch.setattr("nexus.models.router.ModelRouter.is_ready", lambda self: True)
    monkeypatch.setattr("nexus.models.router.ModelRouter.complete",
                        lambda self, *a, **k: '{"action":"final","answer":"Done."}')
    r = client.post("/api/voice/listen")
    body = r.json()
    assert body["ok"] is True and body["handled"] is True
    assert body["agent"] == "productivity"      # routed by keywords
    assert body["reply"] == "Done."


def test_voice_status_endpoint(client):
    r = client.get("/api/voice/status")
    assert r.status_code == 200
    body = r.json()
    assert "ready" in body and "missing" in body
    assert body["wake_phrases"]


def test_health_endpoint(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert "study" in body["agents"]


def test_progress_endpoint(client):
    r = client.get("/api/study/progress")
    assert r.status_code == 200
    assert "Physics" in r.json()


def test_ask_offline_message():
    # Point at a guaranteed-dead Ollama host so this is deterministic whether or
    # not a real Ollama happens to be running on the test machine.
    from nexus.kernel.config import NexusConfig

    cfg = NexusConfig()
    cfg.models.ollama_host = "http://127.0.0.1:9"  # discard port: always refused
    app = NexusApp(db_file=":memory:", config=cfg)
    offline_client = TestClient(create_app(app))

    r = offline_client.post("/api/ask", json={"text": "hi"})
    assert r.status_code == 200
    assert "Ollama" in r.json()["answer"]
