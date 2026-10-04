"""Tier 3 — the voice loop. Push-to-talk in, spoken reply out, wrapping the *same* brain.

This is an adapter on the edges of the agent, not a second copy of it: a spoken turn is
transcribed to text and fed into the exact `Conversation.respond` a typed turn uses, and the
reply is both printed and spoken. The transcript is shown next to the reply so, while you're
getting started, you can see whether a wrong answer came from the ears or the brain. The
typed interface stays alive — if any audio piece is missing or misbehaves, this falls back
to text rather than leaving you stuck.
"""

from __future__ import annotations

from . import audio, ears, heartbeat, mouth, safety
from .agent import (
    Conversation,
    _ensure_utf8_console,
    _show_new_interrupts,
    _streaming_printer,
    run_text_repl,
)
from .config import Config, load_config


def _missing_pieces() -> list[str]:
    missing = []
    if not audio.is_available():
        missing.append("microphone capture (sounddevice / pynput)")
    if not ears.is_available():
        missing.append("speech-to-text (faster-whisper)")
    if not mouth.is_available():
        missing.append("text-to-speech (pyttsx3)")
    return missing


def run_voice_repl(config: Config | None = None) -> None:
    config = config or load_config()

    missing = _missing_pieces()
    if missing:
        print("Voice needs a few extra libraries that aren't installed yet:")
        for m in missing:
            print(f"  - {m}")
        print('Install them with:  pip install -e ".[voice]"')
        print("Falling back to the text interface for now.\n")
        run_text_repl(config)
        return

    _ensure_utf8_console()
    convo = Conversation.start(config)
    # Consequential actions are still confirmed by TYPING y/N — a deliberate safety choice:
    # you physically approve a send/delete, you don't just say it.
    convo.confirmer = safety.interactive_confirmer()

    key = config.voice_ptt_key.upper()
    print(f"{config.name} — voice mode")
    print(f"Hold [{key}] to talk, release to send. Ctrl-C to quit.")
    print("(The typed interface still works any time — run without --voice.)")
    print("Loading the speech model (the first run downloads it)…")
    try:
        ears.preload(config.voice_whisper_model)
    except Exception as exc:  # noqa: BLE001
        print(f"Couldn't load the speech model ({exc}). Falling back to text.\n")
        run_text_repl(config)
        return

    hb_stop = None
    if config.heartbeat_enabled:
        _thread, hb_stop = heartbeat.start_background(config)
    _show_new_interrupts()

    ptt = audio.PushToTalk(key=config.voice_ptt_key, samplerate=config.voice_samplerate)
    try:
        while True:
            print(f"\n[hold {key} and speak]")
            clip = ptt.record_while_held()
            print("(transcribing…)")
            try:
                transcript = ears.transcribe(clip, model_size=config.voice_whisper_model)
            except Exception as exc:  # noqa: BLE001
                print(f"(couldn't transcribe — {exc})")
                continue
            if not transcript.strip():
                print("(heard nothing — try again)")
                continue
            print(f"you (heard): {transcript}")

            on_text, finish = _streaming_printer()
            try:
                result = convo.respond(transcript, on_text=on_text)
                finish()
            except Exception as exc:  # noqa: BLE001
                finish()
                print(f"Nexus: (trouble reaching the model — {exc})")
                continue

            # Speak the reply. Holding the talk key again barges in (stops speech to listen).
            mouth.speak(result.text, voice=config.voice_tts_voice, should_stop=ptt.is_held)
            _show_new_interrupts()
    except KeyboardInterrupt:
        print("\nGoodbye.")
    finally:
        ptt.close()
        if hb_stop is not None:
            hb_stop.set()
