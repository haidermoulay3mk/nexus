"""Load runtime configuration from config.toml and secrets from .env.

Everything tunable lives in config.toml so a behavior change is a one-line edit, not a
code edit. Secrets live in .env (git-ignored) and are loaded into the process
environment — never read into config objects, never logged. (The default backend, local
Ollama, needs no secret at all.)
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

# Project root = the directory that contains config.toml (one level up from this file).
ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.toml"
ENV_PATH = ROOT / ".env"


@dataclass(frozen=True)
class Config:
    """The subset of config.toml the code reads today. Grows with each tier."""

    # [identity]
    name: str
    tagline: str

    # [model]
    provider: str        # "ollama" (free, local, default) | "anthropic"
    model_name: str
    thinking: str        # "adaptive" | "off"  (anthropic backend only)
    effort: str          # low | medium | high | max  (anthropic backend only)
    max_tokens: int
    timeout_seconds: int

    # [ollama]
    ollama_host: str
    ollama_num_ctx: int
    ollama_temperature: float

    # [heartbeat] + [checks.*]  (Tier 5)
    heartbeat_enabled: bool
    heartbeat_tick_seconds: int
    quiet_hours_start: int
    quiet_hours_end: int
    heartbeat_signal_enabled: bool
    heartbeat_signal_interval: int
    heartbeat_signal_path: str
    heartbeat_reminders_enabled: bool
    heartbeat_reminders_interval: int

    # [safety]  (Tier 6)
    safety_gate_enabled: bool
    safety_confirm_tools: list

    # [conversation]
    end_on_signoff: bool   # let a sign-off ("okay, thanks") end the turn with no reply

    # [voice]  (Tier 3)
    voice_stt: str            # "whisper" (local) | "deepgram" (later)
    voice_whisper_model: str  # tiny | base | small
    voice_tts: str            # "windows" (local) | "elevenlabs" (later)
    voice_tts_voice: str      # optional: part of a voice name (Windows) or a voice id (ElevenLabs)
    voice_ptt_key: str        # push-to-talk key, e.g. "space"
    voice_samplerate: int
    voice_mode: str           # "hands_free" (always-on mic) | "push_to_talk" (hold a key)
    voice_barge_in: bool      # hands-free: let your voice interrupt Nexus mid-reply (needs headphones)
    voice_endpoint_ms: int    # hands-free: trailing silence (ms) that ends your turn


def load_dotenv(path: Path = ENV_PATH) -> None:
    """Minimal .env loader (no dependency). Lines like KEY=value; existing env wins."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_config(path: Path = CONFIG_PATH) -> Config:
    """Read config.toml into a Config. Also loads .env as a side effect."""
    load_dotenv()

    if not path.exists():
        raise FileNotFoundError(f"config.toml not found at {path}")

    with path.open("rb") as fh:
        data = tomllib.load(fh)

    identity = data.get("identity", {})
    model = data.get("model", {})
    ollama = data.get("ollama", {})
    hb = data.get("heartbeat", {})
    checks = data.get("checks", {})
    sig = checks.get("signal", {})
    rem = checks.get("reminders_due", {})
    saf = data.get("safety", {})
    conv = data.get("conversation", {})
    voice = data.get("voice", {})

    return Config(
        name=identity.get("name", "Nexus"),
        tagline=identity.get("tagline", ""),
        provider=model.get("provider", "ollama"),
        model_name=model.get("name", "qwen2.5:3b-instruct"),
        thinking=model.get("thinking", "adaptive"),
        effort=model.get("effort", "medium"),
        max_tokens=int(model.get("max_tokens", 2048)),
        timeout_seconds=int(model.get("timeout_seconds", 300)),
        ollama_host=ollama.get("host", "http://localhost:11434"),
        ollama_num_ctx=int(ollama.get("num_ctx", 4096)),
        ollama_temperature=float(ollama.get("temperature", 0.7)),
        heartbeat_enabled=bool(hb.get("enabled", True)),
        heartbeat_tick_seconds=int(hb.get("tick_seconds", 5)),
        quiet_hours_start=int(hb.get("quiet_hours_start", 22)),
        quiet_hours_end=int(hb.get("quiet_hours_end", 7)),
        heartbeat_signal_enabled=bool(sig.get("enabled", True)),
        heartbeat_signal_interval=int(sig.get("interval_seconds", 10)),
        heartbeat_signal_path=sig.get("path", "state/heartbeat-signal.txt"),
        heartbeat_reminders_enabled=bool(rem.get("enabled", True)),
        heartbeat_reminders_interval=int(rem.get("interval_seconds", 30)),
        safety_gate_enabled=bool(saf.get("gate_enabled", True)),
        safety_confirm_tools=list(saf.get("confirm", [])),
        end_on_signoff=bool(conv.get("end_on_signoff", True)),
        voice_stt=voice.get("stt", "whisper"),
        voice_whisper_model=voice.get("whisper_model", "base"),
        voice_tts=voice.get("tts", "windows"),
        voice_tts_voice=voice.get("tts_voice", ""),
        voice_ptt_key=voice.get("push_to_talk", "space"),
        voice_samplerate=int(voice.get("samplerate", 16000)),
        voice_mode=voice.get("mode", "hands_free"),
        voice_barge_in=bool(voice.get("barge_in", False)),
        voice_endpoint_ms=int(voice.get("endpoint_ms", 700)),
    )
