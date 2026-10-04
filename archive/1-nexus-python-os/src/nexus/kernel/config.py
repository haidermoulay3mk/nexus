"""Global configuration.

Defaults are baked in so Nexus runs with zero setup. They can be overridden by
(in increasing precedence): ``config.toml`` in NEXUS_HOME, then environment
variables. Reading uses stdlib ``tomllib`` (Python 3.11+), so no extra deps.
"""

from __future__ import annotations

import os
import tomllib
from functools import lru_cache

from pydantic import BaseModel, Field

from nexus.kernel import paths
from nexus.kernel.types import ModelTier


class ModelsConfig(BaseModel):
    ollama_host: str = "http://localhost:11434"
    # Tier -> Ollama model tag. See the model strategy in the project README.
    tiers: dict[str, str] = Field(
        default_factory=lambda: {
            ModelTier.FAST.value: "llama3.2:1b",
            ModelTier.BALANCED.value: "qwen2.5:3b-instruct",
            ModelTier.REASONING.value: "qwen2.5:7b-instruct",
        }
    )
    embed_model: str = "nomic-embed-text"
    request_timeout_s: float = 120.0
    # Cloud option (free tier). When a key is present and provider is "auto" or
    # "gemini", Gemini is used instead of local Ollama. Empty key -> local Ollama.
    provider: str = "auto"  # auto | ollama | gemini
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"

    def model_for(self, tier: ModelTier | str) -> str:
        key = tier.value if isinstance(tier, ModelTier) else str(tier)
        return self.tiers.get(key, self.tiers[ModelTier.BALANCED.value])


class VoiceConfig(BaseModel):
    """Settings for the optional voice module (see specs/voice.md)."""

    enabled: bool = True
    # Wake-word listening is off by default (privacy first); the hotkey works
    # regardless. The hotkey path does not require a wake phrase.
    wake_enabled: bool = False
    require_wake: bool = False
    wake_phrases: list[str] = Field(default_factory=lambda: ["hey nexus", "daddy's home"])
    hotkey: str = "ctrl+space"
    # Empty voice_name => auto-select a calm British male voice if available.
    voice_name: str = ""
    rate_wpm: int = 175
    stt_model: str = "base"  # faster-whisper size: tiny|base|small
    persona: bool = True
    persona_preamble: str = (
        "Answer as Nexus, a calm, concise British butler in the style of Jarvis: "
        "polished, composed, lightly witty, never verbose."
    )


class NexusConfig(BaseModel):
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    timezone: str = "Europe/London"  # used by scheduler + calendar reminders
    user_name: str = ""  # your name

    def apply_env_overrides(self) -> "NexusConfig":
        host = os.environ.get("OLLAMA_HOST")
        if host:
            self.models.ollama_host = host
        for tier in (ModelTier.FAST, ModelTier.BALANCED, ModelTier.REASONING):
            env_key = f"NEXUS_MODEL_{tier.value.upper()}"
            val = os.environ.get(env_key)
            if val:
                self.models.tiers[tier.value] = val
        embed = os.environ.get("NEXUS_MODEL_EMBED")
        if embed:
            self.models.embed_model = embed
        return self


def _load_toml() -> dict:
    cfg_file = paths.config_dir() / "config.toml"
    if cfg_file.exists():
        with cfg_file.open("rb") as f:
            return tomllib.load(f)
    return {}


@lru_cache(maxsize=1)
def get_config() -> NexusConfig:
    """Load and cache the effective configuration."""
    data = _load_toml()
    cfg = NexusConfig.model_validate(data) if data else NexusConfig()
    return cfg.apply_env_overrides()


def reload_config() -> NexusConfig:
    """Clear the cache and reload (used by tests and the setup wizard)."""
    get_config.cache_clear()
    return get_config()
