"""Tiered model router with pluggable backend (local Ollama or cloud Gemini).

Agents ask for a *tier* (fast / balanced / reasoning); the router resolves the
backend + model and dispatches. The backend is Gemini when a free API key is
configured (provider auto/gemini), otherwise local Ollama — so adding the cloud
option needs no agent changes.
"""

from __future__ import annotations

import os
from collections.abc import Iterable

from nexus.kernel import credentials
from nexus.kernel.config import NexusConfig, get_config
from nexus.kernel.types import ChatMessage, ModelTier
from nexus.models.gemini_client import GeminiClient, GeminiError
from nexus.models.ollama_client import OllamaClient, OllamaError

_GEMINI_KEY = "gemini_api_key"


class ModelRouter:
    def __init__(self, config: NexusConfig | None = None, client: OllamaClient | None = None) -> None:
        self.config = config or get_config()
        self._forced_client = client
        self._configure()

    # --- backend selection ----------------------------------------------------

    def _resolve_gemini_key(self) -> str:
        return (
            self.config.models.gemini_api_key
            or os.environ.get("GEMINI_API_KEY", "")
            or os.environ.get("NEXUS_GEMINI_KEY", "")
            or (credentials.get_secret(_GEMINI_KEY) or "")
        )

    def _configure(self) -> None:
        m = self.config.models
        key = self._resolve_gemini_key()
        if self._forced_client is not None:
            self.provider = "ollama"
            self.ollama = self._forced_client
            self.gemini = None
        elif key and m.provider in ("auto", "gemini"):
            self.provider = "gemini"
            self.gemini = GeminiClient(key, m.gemini_model, m.request_timeout_s)
            self.ollama = OllamaClient(m.ollama_host, m.request_timeout_s)
        else:
            self.provider = "ollama"
            self.gemini = None
            self.ollama = OllamaClient(m.ollama_host, m.request_timeout_s)

    def set_gemini_key(self, key: str) -> None:
        """Persist a Gemini key and switch backend live (no restart)."""
        key = (key or "").strip()
        if key:
            credentials.set_secret(_GEMINI_KEY, key)
            self.config.models.provider = "auto"
        else:
            credentials.delete_secret(_GEMINI_KEY)
        self._configure()

    @property
    def client(self):
        """Backward-compatible: the active backend (has is_available())."""
        return self.gemini if self.provider == "gemini" else self.ollama

    def is_ready(self) -> bool:
        if self.provider == "gemini":
            return self.gemini.is_available()
        return self.ollama.is_available()

    def has_gemini_key(self) -> bool:
        return bool(self._resolve_gemini_key())

    # --- completion -----------------------------------------------------------

    def model_name(self, tier: ModelTier | str) -> str:
        if self.provider == "gemini":
            return self.config.models.gemini_model
        return self.config.models.model_for(tier)

    def complete(
        self,
        messages: Iterable[ChatMessage] | list[dict],
        *,
        tier: ModelTier = ModelTier.BALANCED,
        temperature: float = 0.7,
        options: dict | None = None,
    ) -> str:
        if self.provider == "gemini":
            try:
                return self.gemini.chat(messages, temperature=temperature)
            except GeminiError:
                # Gemini failed (e.g. rate-limited 429) — fall back to local Ollama
                # if it's running, so the assistant keeps working.
                if self.ollama.is_available():
                    model = self.config.models.model_for(tier)
                    if not self.ollama.has_model(model):
                        model = self._fallback_model(model)
                    return self.ollama.chat(model, messages, temperature=temperature, options=options)
                raise
        model = self.model_name(tier)
        if not self.ollama.has_model(model):
            model = self._fallback_model(model)
        return self.ollama.chat(model, messages, temperature=temperature, options=options)

    def _fallback_model(self, wanted: str) -> str:
        balanced = self.config.models.model_for(ModelTier.BALANCED)
        if self.ollama.has_model(balanced):
            return balanced
        try:
            installed = self.ollama.list_models()
        except OllamaError:
            installed = []
        if installed:
            return installed[0]
        return wanted

    # --- diagnostics ----------------------------------------------------------

    def health(self) -> dict:
        if self.provider == "gemini":
            return {
                "provider": "gemini",
                "ollama_available": self.gemini.is_available(),  # kept key for the CLI/dashboard
                "host": "Google Gemini (cloud)",
                "installed_models": [self.config.models.gemini_model],
                "tiers": {t.value: {"model": self.config.models.gemini_model, "installed": True}
                          for t in ModelTier},
                "embed_model": self.config.models.embed_model,
            }
        available = self.ollama.is_available()
        installed = self.ollama.list_models() if available else []
        return {
            "provider": "ollama",
            "ollama_available": available,
            "host": self.config.models.ollama_host,
            "installed_models": installed,
            "tiers": {t.value: {"model": self.model_name(t),
                                "installed": self.ollama.has_model(self.model_name(t))}
                      for t in ModelTier},
            "embed_model": self.config.models.embed_model,
        }
