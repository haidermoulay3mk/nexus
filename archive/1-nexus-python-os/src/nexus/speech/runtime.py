"""Wire the voice module to real hardware and run the listen loop.

This is the only part that needs a microphone, speakers, and the voice extra.
It is intentionally thin and defensive: every external dependency is imported
lazily and surfaced as ``VoiceUnavailable`` with guidance, so the rest of Nexus
never depends on audio being present. (Hardware paths can't be unit-tested in CI;
the testable logic lives in controller.py / wake.py / tts_text.py / voices.py.)
"""

from __future__ import annotations

import tempfile
import wave
from pathlib import Path

from nexus.kernel.config import NexusConfig, get_config
from nexus.speech.adapters import SapiTTS, WhisperSTT
from nexus.speech.controller import VoiceController
from nexus.speech.interfaces import VoiceUnavailable

SAMPLE_RATE = 16000


def build_controller(app, config: NexusConfig | None = None) -> VoiceController:
    """Build a controller with a real TTS engine (no mic needed to construct)."""
    config = config or get_config()
    tts = SapiTTS(config.voice)
    return VoiceController(app, tts, config.voice)


def _record_until_silence(seconds_max: float = 8.0, silence_rms: float = 500.0) -> Path:
    """Record from the default mic to a temp WAV until a pause or the time cap."""
    try:
        import numpy as np  # noqa: PLC0415
        import sounddevice as sd  # noqa: PLC0415
    except ImportError as e:
        raise VoiceUnavailable("sounddevice not installed. Run: pip install -e .[voice]") from e

    chunk = int(SAMPLE_RATE * 0.25)
    frames: list[bytes] = []
    silent_chunks = 0
    spoke = False
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16") as stream:
        for _ in range(int(seconds_max / 0.25)):
            data, _ = stream.read(chunk)
            frames.append(data.tobytes())
            rms = float(np.sqrt(np.mean(np.square(data.astype("float32")))))
            if rms > silence_rms:
                spoke = True
                silent_chunks = 0
            elif spoke:
                silent_chunks += 1
                if silent_chunks >= 3:  # ~0.75s of trailing silence
                    break

    tmp = Path(tempfile.gettempdir()) / "nexus_capture.wav"
    with wave.open(str(tmp), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(frames))
    return tmp


def record_segment(seconds_max: float = 8.0, silence_rms: float = 500.0) -> Path | None:
    """Record one utterance; return the WAV path, or None if no speech was heard.

    Skipping silent windows means we never send empty audio to the (rate-limited)
    transcriber, so an always-on listener is cheap when the room is quiet.
    """
    try:
        import numpy as np  # noqa: PLC0415
        import sounddevice as sd  # noqa: PLC0415
    except ImportError as e:
        raise VoiceUnavailable("sounddevice not installed. Run: pip install -e .[voice]") from e

    chunk = int(SAMPLE_RATE * 0.25)
    frames: list[bytes] = []
    silent_chunks = 0
    spoke = False
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16") as stream:
        for _ in range(int(seconds_max / 0.25)):
            data, _ = stream.read(chunk)
            rms = float(np.sqrt(np.mean(np.square(data.astype("float32")))))
            if rms > silence_rms:
                spoke = True
                silent_chunks = 0
                frames.append(data.tobytes())
            elif spoke:
                frames.append(data.tobytes())
                silent_chunks += 1
                if silent_chunks >= 3:  # ~0.75s trailing silence ends the turn
                    break
            # else: leading silence — don't buffer, keep waiting
    if not spoke or not frames:
        return None
    tmp = Path(tempfile.gettempdir()) / "nexus_segment.wav"
    with wave.open(str(tmp), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(frames))
    return tmp


def transcribe_wav(nexus, wav_path) -> str:
    """Transcribe a WAV. Tries the free Google recognizer first (the standard for
    DIY Jarvis — no API key, no quota), then Gemini, then local Whisper."""
    # 1) Free Google Web Speech recognizer via the SpeechRecognition library.
    try:
        import speech_recognition as sr  # noqa: PLC0415

        recognizer = sr.Recognizer()
        with sr.AudioFile(str(wav_path)) as source:
            audio = recognizer.record(source)
        text = recognizer.recognize_google(audio)
        if text:
            return text
    except Exception:  # noqa: BLE001 - no speech / API hiccup -> fall through
        pass
    # 2) Gemini (uses the configured key).
    router = nexus.router
    if getattr(router, "provider", "") == "gemini" and router.gemini is not None:
        try:
            with open(wav_path, "rb") as f:
                return router.gemini.transcribe(f.read())
        except Exception:  # noqa: BLE001
            pass
    # 3) Local Whisper, if bundled.
    try:
        from nexus.speech.adapters import WhisperSTT  # noqa: PLC0415
        return WhisperSTT(nexus.config.voice.stt_model).transcribe(str(wav_path))
    except Exception:  # noqa: BLE001
        return ""


def run(app, *, mode: str = "hotkey") -> None:
    """Run the voice loop. ``mode`` is 'hotkey' (push-to-talk) or 'wake'."""
    config = get_config()
    controller = build_controller(app, config)
    stt = WhisperSTT(config.voice.stt_model)

    def handle_once(require_wake: bool) -> None:
        wav = _record_until_silence()
        transcript = stt.transcribe(str(wav))
        result = controller.process_transcript(transcript, require_wake=require_wake)
        if not result.get("handled"):
            controller.speak("Sorry, I didn't catch that.")

    if mode == "wake":
        # Continuous: transcribe short windows and act when a wake phrase is heard.
        while True:
            handle_once(require_wake=True)
    else:
        # Push-to-talk via a global hotkey.
        try:
            import keyboard  # noqa: PLC0415
        except ImportError as e:
            raise VoiceUnavailable("keyboard not installed. Run: pip install -e .[voice]") from e
        hotkey = config.voice.hotkey
        keyboard.add_hotkey(hotkey, lambda: handle_once(require_wake=False))
        keyboard.wait()  # block forever; Ctrl+C to exit
