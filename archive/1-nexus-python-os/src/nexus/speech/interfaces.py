"""Stable interfaces for the voice module.

The controller depends only on these Protocols, so tests inject fakes and the
real hardware adapters can be swapped without touching call sites.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


class VoiceUnavailable(RuntimeError):
    """Raised when voice can't run (missing deps, no mic, no voice installed)."""


@dataclass
class VoiceInfo:
    """A TTS voice as reported by the engine."""

    id: str
    name: str
    languages: list[str] = field(default_factory=list)  # e.g. ["en-GB"]
    gender: str = ""  # "male" | "female" | ""


@runtime_checkable
class STT(Protocol):
    def transcribe(self, audio) -> str:
        """Return text for the given audio (bytes/path/array). '' if nothing."""
        ...


@runtime_checkable
class TTS(Protocol):
    def speak(self, text: str) -> None:
        """Speak text aloud (blocking or queued)."""
        ...

    def stop(self) -> None:
        """Stop any current speech (barge-in)."""
        ...
