"""The ears — speech-to-text seam.

"Give me audio, get back text." The default backend is Whisper running locally via
faster-whisper: no key, no cost, fully offline after a one-time model download. Kept behind
this seam (like the model and the voice) so it can be swapped for Deepgram later by changing
`[voice] stt` in config — no other code changes.

Heavy libraries are imported lazily so the rest of Nexus never depends on them.
"""

from __future__ import annotations

_model = None
_model_key: tuple | None = None


def is_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _get_model(model_size: str):
    """Load (and cache) the Whisper model. First call downloads it (~tens of MB) and is slow."""
    global _model, _model_key
    key = (model_size,)
    if _model is None or _model_key != key:
        from faster_whisper import WhisperModel
        # int8 on CPU is the right tradeoff for a laptop without a discrete GPU.
        _model = WhisperModel(model_size, device="cpu", compute_type="int8")
        _model_key = key
    return _model


def preload(model_size: str = "base") -> None:
    """Warm the model before the first turn, so the first transcription isn't a long pause."""
    _get_model(model_size)


def transcribe(audio, *, model_size: str = "base") -> str:
    """Transcribe `audio` (a float32 numpy array at 16 kHz, or a path to an audio file)."""
    model = _get_model(model_size)
    segments, _info = model.transcribe(audio, beam_size=1)
    return " ".join(seg.text.strip() for seg in segments).strip()
