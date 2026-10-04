"""Gemini backend + provider selection in the router (mocked HTTP)."""

from __future__ import annotations

import httpx

from nexus.kernel.config import NexusConfig
from nexus.kernel.types import ChatMessage, ModelTier
from nexus.models.gemini_client import GeminiClient, GeminiError, _to_gemini
from nexus.models.router import ModelRouter


class _Resp:
    def __init__(self, data, status=200):
        self._d = data
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=self)

    def json(self):
        return self._d


_OK = {"candidates": [{"content": {"parts": [{"text": "Very good, sir."}]}}]}


def test_to_gemini_splits_system_and_roles():
    system, contents = _to_gemini([
        ChatMessage(role="system", content="be brief"),
        ChatMessage(role="user", content="hi"),
        ChatMessage(role="assistant", content="hello"),
    ])
    assert system == "be brief"
    assert contents[0]["role"] == "user"
    assert contents[1]["role"] == "model"


def test_gemini_chat(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(_OK))
    client = GeminiClient("key", "gemini-2.0-flash")
    assert client.is_available() is True
    assert client.chat([ChatMessage(role="user", content="hi")]) == "Very good, sir."


def test_gemini_blocked_response_is_empty(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp({"candidates": []}))
    assert GeminiClient("key").chat([ChatMessage(role="user", content="x")]) == ""


def test_router_prefers_gemini_when_key_set(monkeypatch):
    cfg = NexusConfig()
    cfg.models.gemini_api_key = "testkey"
    router = ModelRouter(cfg)
    assert router.provider == "gemini"
    assert router.is_ready() is True
    assert router.model_name(ModelTier.BALANCED) == "gemini-2.0-flash"

    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp(_OK))
    assert router.complete([ChatMessage(role="user", content="x")]) == "Very good, sir."


def test_gemini_transcribe(monkeypatch):
    monkeypatch.setattr(httpx, "post",
                        lambda *a, **k: _Resp({"candidates": [{"content": {"parts": [{"text": "hey nexus"}]}}]}))
    assert GeminiClient("key").transcribe(b"RIFFfake") == "hey nexus"


def test_router_falls_back_to_ollama_when_gemini_errors(monkeypatch):
    cfg = NexusConfig()
    cfg.models.gemini_api_key = "testkey"
    router = ModelRouter(cfg)
    assert router.provider == "gemini"
    # Gemini rate-limited; Ollama is up -> use the local model instead of crashing.
    monkeypatch.setattr(router.gemini, "chat",
                        lambda *a, **k: (_ for _ in ()).throw(GeminiError("Gemini API error (429).")))
    monkeypatch.setattr(router.ollama, "is_available", lambda: True)
    monkeypatch.setattr(router.ollama, "has_model", lambda m: True)
    monkeypatch.setattr(router.ollama, "chat", lambda model, messages, **k: "local answer")
    assert router.complete([ChatMessage(role="user", content="hi")]) == "local answer"


def test_router_defaults_to_ollama_without_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("NEXUS_GEMINI_KEY", raising=False)
    monkeypatch.setattr("nexus.models.router.credentials.get_secret", lambda k: None)
    router = ModelRouter(NexusConfig())
    assert router.provider == "ollama"
