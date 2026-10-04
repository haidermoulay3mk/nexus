"""Shared fixtures. Points NEXUS_HOME at a temp dir so tests never touch real
user data, and provides an in-memory MemoryService with a deterministic
embedder (no Ollama required)."""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """Redirect all Nexus runtime paths into a temp directory."""
    monkeypatch.setenv("NEXUS_HOME", str(tmp_path / "nexus_home"))
    # paths.home() and config are cached with lru_cache; reload to clear.
    from nexus.kernel import paths, config
    importlib.reload(paths)
    importlib.reload(config)
    yield


@pytest.fixture(autouse=True)
def isolated_secrets(monkeypatch):
    """Use an in-memory secret store so tests never read or write the real OS
    keychain (no leakage of a real Gemini key / app passwords into tests, and no
    polluting the user's keychain from tests)."""
    store: dict[str, str] = {}
    monkeypatch.setattr("nexus.kernel.credentials.set_secret",
                        lambda k, v: (store.__setitem__(k, v), True)[1])
    monkeypatch.setattr("nexus.kernel.credentials.get_secret", lambda k: store.get(k))
    monkeypatch.setattr("nexus.kernel.credentials.delete_secret",
                        lambda k: store.pop(k, None))
    # Also clear any ambient Gemini env keys so provider selection is deterministic.
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("NEXUS_GEMINI_KEY", raising=False)
    yield


def fake_embedder(text: str) -> list[float]:
    """Tiny deterministic 'embedding': a 5-dim bag of character-class counts.

    Not semantically meaningful in general, but stable and good enough to prove
    that nearer text scores higher in the vector path.
    """
    t = text.lower()
    return [
        float(sum(c.isalpha() for c in t)),
        float(sum(c.isdigit() for c in t)),
        float(t.count("physics")),
        float(t.count("calendar")),
        float(t.count("german")),
    ]


@pytest.fixture
def memory():
    from nexus.memory.service import MemoryService

    # In-memory SQLite (":memory:") with the deterministic embedder.
    svc = MemoryService(db_file=":memory:", embedder=fake_embedder)
    return svc
