"""Wake-phrase detection and command extraction (pure, testable).

Given a transcript and a list of wake phrases, decide whether the user "called"
Nexus and, if so, return the command that followed. Matching is case-insensitive,
ignores punctuation, and tolerates small transcription errors (e.g. "hey nexis").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

_NON_WORD = re.compile(r"[^a-z0-9'\s]")
_WS = re.compile(r"\s+")


def _normalize(text: str) -> str:
    text = text.lower()
    text = _NON_WORD.sub(" ", text)
    return _WS.sub(" ", text).strip()


@dataclass
class WakeResult:
    matched: bool
    command: str = ""
    phrase: str = ""


def match_wake(transcript: str, phrases: list[str], *, threshold: float = 0.8) -> WakeResult:
    """Detect any wake phrase at the start of the transcript.

    Returns the trailing command (text after the phrase). If a phrase matches but
    nothing follows, ``command`` is empty and ``matched`` is True (caller should
    prompt for a follow-up).
    """
    norm = _normalize(transcript)
    if not norm:
        return WakeResult(False)
    words = norm.split()

    for phrase in phrases:
        p = _normalize(phrase)
        if not p:
            continue
        p_words = p.split()
        n = len(p_words)

        # Exact prefix / containment first (fast path).
        if norm.startswith(p):
            return WakeResult(True, command=norm[len(p):].strip(), phrase=phrase)
        idx = norm.find(p)
        if idx != -1:
            return WakeResult(True, command=norm[idx + len(p):].strip(), phrase=phrase)

        # Fuzzy: compare the leading n words against the phrase.
        if len(words) >= n:
            lead = " ".join(words[:n])
            if SequenceMatcher(None, lead, p).ratio() >= threshold:
                return WakeResult(True, command=" ".join(words[n:]).strip(), phrase=phrase)

    return WakeResult(False)
