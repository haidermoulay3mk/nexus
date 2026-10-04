"""Pick the best TTS voice for the calm British butler persona.

Pure scoring over a provided list of VoiceInfo, so it's testable without a TTS
engine. Preference: British English > other English; male > unknown > female;
known butler-ish British voice names get a small bonus.
"""

from __future__ import annotations

from nexus.speech.interfaces import VoiceInfo

# Common British male SAPI/Windows voices and Piper en_GB voice hints.
_BRITISH_MALE_HINTS = ("george", "ryan", "uk english male", "en-gb", "british", "alfred", "daniel")


def _lang_score(langs: list[str]) -> int:
    joined = " ".join(langs).lower()
    if "en-gb" in joined or "en_gb" in joined or "british" in joined:
        return 4
    if joined.startswith("en") or " en" in joined or "english" in joined:
        return 1
    return 0


def score_voice(v: VoiceInfo, prefer_gender: str = "male") -> int:
    score = _lang_score(v.languages)
    g = (v.gender or "").lower()
    if g == prefer_gender:
        score += 2
    elif g == "":
        score += 1  # unknown gender beats the opposite gender
    name = v.name.lower()
    if any(h in name for h in _BRITISH_MALE_HINTS):
        score += 2
    return score


def select_voice(
    voices: list[VoiceInfo],
    *,
    prefer_gender: str = "male",
    requested_name: str = "",
) -> VoiceInfo | None:
    """Return the best voice, or None if the list is empty.

    An exact ``requested_name`` (case-insensitive substring) always wins.
    """
    if not voices:
        return None
    if requested_name:
        for v in voices:
            if requested_name.lower() in v.name.lower():
                return v
    return max(voices, key=lambda v: score_voice(v, prefer_gender))
