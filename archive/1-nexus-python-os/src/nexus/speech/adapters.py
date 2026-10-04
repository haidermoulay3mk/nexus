"""Hardware/heavy adapters for STT and TTS.

Everything here imports its dependency lazily and raises ``VoiceUnavailable`` with
a clear message if it's missing, so importing this module never fails and the
rest of Nexus keeps working without the voice extra installed.
"""

from __future__ import annotations

from nexus.kernel.config import VoiceConfig
from nexus.speech.interfaces import TTS, VoiceInfo, VoiceUnavailable
from nexus.speech.voices import select_voice


def _gender_of(raw) -> str:
    g = (str(raw) or "").lower()
    if "male" in g and "female" not in g:
        return "male"
    if "female" in g:
        return "female"
    return ""


class SapiTTS(TTS):
    """Windows SAPI5 voices via pyttsx3 (no download required)."""

    def __init__(self, config: VoiceConfig) -> None:
        try:
            import pyttsx3  # noqa: PLC0415
        except ImportError as e:
            raise VoiceUnavailable(
                "pyttsx3 not installed. Run: pip install -e .[voice]"
            ) from e
        self._engine = pyttsx3.init()
        self._engine.setProperty("rate", config.rate_wpm)

        voices = []
        for v in self._engine.getProperty("voices"):
            langs = []
            for lang in getattr(v, "languages", []) or []:
                langs.append(lang.decode() if isinstance(lang, bytes) else str(lang))
            voices.append(VoiceInfo(id=v.id, name=v.name, languages=langs or [v.id],
                                    gender=_gender_of(getattr(v, "gender", ""))))
        chosen = select_voice(voices, requested_name=config.voice_name)
        if chosen is not None:
            self._engine.setProperty("voice", chosen.id)
        self.selected = chosen

    def speak(self, text: str) -> None:
        if not text:
            return
        self._engine.say(text)
        self._engine.runAndWait()

    def stop(self) -> None:
        try:
            self._engine.stop()
        except Exception:  # noqa: BLE001
            pass


class WhisperSTT:
    """Local speech-to-text via faster-whisper (CPU, int8)."""

    def __init__(self, model_size: str = "base") -> None:
        try:
            from faster_whisper import WhisperModel  # noqa: PLC0415
        except ImportError as e:
            raise VoiceUnavailable(
                "faster-whisper not installed. Run: pip install -e .[voice]"
            ) from e
        self._model = WhisperModel(model_size, device="cpu", compute_type="int8")

    def transcribe(self, audio) -> str:
        # ``audio`` is a path to a WAV file (or anything faster-whisper accepts).
        segments, _info = self._model.transcribe(audio, vad_filter=True)
        return " ".join(seg.text for seg in segments).strip()
