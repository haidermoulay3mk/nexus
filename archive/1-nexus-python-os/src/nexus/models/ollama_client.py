"""Thin synchronous client for the Ollama HTTP API.

Sync (not async) on purpose: the CLI and scheduler are simpler for it, and a
single-user assistant has no concurrency pressure. Uses httpx.

Endpoints used: /api/chat, /api/embeddings, /api/tags, /api/show.
"""

from __future__ import annotations

from collections.abc import Iterable

import httpx

from nexus.kernel.types import ChatMessage


class OllamaError(RuntimeError):
    """Raised when Ollama is unreachable or returns an error."""


class OllamaClient:
    def __init__(self, host: str = "http://localhost:11434", timeout_s: float = 120.0) -> None:
        self.host = host.rstrip("/")
        self._timeout = timeout_s

    # --- health ---------------------------------------------------------------

    def is_available(self) -> bool:
        """True if the Ollama server responds (does not validate any model)."""
        try:
            r = httpx.get(f"{self.host}/api/tags", timeout=5.0)
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    def list_models(self) -> list[str]:
        try:
            r = httpx.get(f"{self.host}/api/tags", timeout=10.0)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise OllamaError(f"could not list models: {e}") from e
        data = r.json()
        return [m["name"] for m in data.get("models", [])]

    def has_model(self, name: str) -> bool:
        try:
            installed = self.list_models()
        except OllamaError:
            return False
        # Require an exact tag match (also accept the ":latest" shorthand), so a
        # 3B model is never mistaken for a not-installed 7B of the same family.
        return name in installed or f"{name}:latest" in installed

    # --- generation -----------------------------------------------------------

    def chat(
        self,
        model: str,
        messages: Iterable[ChatMessage] | list[dict],
        *,
        temperature: float = 0.7,
        options: dict | None = None,
    ) -> str:
        """Non-streaming chat completion. Returns the assistant message text."""
        payload_messages = [
            m.model_dump(exclude_none=True) if isinstance(m, ChatMessage) else m
            for m in messages
        ]
        body = {
            "model": model,
            "messages": payload_messages,
            "stream": False,
            "options": {"temperature": temperature, **(options or {})},
        }
        try:
            r = httpx.post(f"{self.host}/api/chat", json=body, timeout=self._timeout)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise OllamaError(f"chat request failed: {e}") from e
        data = r.json()
        return data.get("message", {}).get("content", "")

    # --- embeddings -----------------------------------------------------------

    def embed(self, model: str, text: str) -> list[float]:
        body = {"model": model, "prompt": text}
        try:
            r = httpx.post(f"{self.host}/api/embeddings", json=body, timeout=self._timeout)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise OllamaError(f"embedding request failed: {e}") from e
        return r.json().get("embedding", [])
