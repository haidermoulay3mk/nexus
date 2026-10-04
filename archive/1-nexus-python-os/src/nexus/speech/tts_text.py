"""Prepare an answer for speech.

Agent replies may contain markdown, code, URLs, and symbols that sound wrong when
read aloud. This strips them into clean, speakable prose without changing meaning.
"""

from __future__ import annotations

import re

_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_URL = re.compile(r"https?://\S+")
_MD_EMPHASIS = re.compile(r"[*_#>]+")
_BULLET = re.compile(r"^\s*[-*]\s+", re.MULTILINE)
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_WS = re.compile(r"\s+")


def prepare_for_speech(text: str) -> str:
    if not text:
        return ""
    text = _CODE_BLOCK.sub(" ", text)
    text = _LINK.sub(r"\1", text)            # [label](url) -> label
    text = _URL.sub(" a link ", text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _BULLET.sub("", text)
    text = _MD_EMPHASIS.sub("", text)
    # Turn line breaks into sentence pauses so TTS doesn't run lines together.
    text = re.sub(r"\n+", ". ", text)
    text = _WS.sub(" ", text).strip()
    # Collapse duplicate sentence separators created above.
    text = re.sub(r"(\.\s*){2,}", ". ", text)
    return text.strip()
