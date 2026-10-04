"""VoiceController: turns a transcript into an answer that is spoken and returned.

Depends only on the STT/TTS interfaces and an object with ``ask(text)`` (the
NexusApp), so it is fully unit-testable with fakes — no audio hardware required.
"""

from __future__ import annotations

import logging

from nexus.kernel.config import VoiceConfig
from nexus.speech.interfaces import TTS
from nexus.speech.tts_text import prepare_for_speech
from nexus.speech.wake import match_wake

_log = logging.getLogger("nexus.speech")


class VoiceController:
    def __init__(self, app, tts: TTS | None, config: VoiceConfig) -> None:
        self.app = app
        self.tts = tts
        self.config = config

    def speak(self, text: str) -> None:
        if self.tts is None:
            return
        try:
            self.tts.speak(text)
        except Exception:  # noqa: BLE001 - speech must never crash the flow
            _log.exception("TTS speak failed")

    def stop_speaking(self) -> None:
        if self.tts is not None:
            try:
                self.tts.stop()
            except Exception:  # noqa: BLE001
                pass

    def process_transcript(self, transcript: str, *, require_wake: bool | None = None) -> dict:
        """Handle one utterance. Returns a result dict describing what happened.

        Keys: handled(bool), reply(str), spoken(str), agent(str|None), and one of
        reason in {"no_wake","empty","unintelligible"} when not actioned.
        """
        require_wake = self.config.require_wake if require_wake is None else require_wake
        text = (transcript or "").strip()

        if not text:
            return {"handled": False, "reason": "unintelligible", "reply": "", "agent": None}

        if require_wake:
            res = match_wake(text, self.config.wake_phrases)
            if not res.matched:
                return {"handled": False, "reason": "no_wake", "reply": "", "agent": None}
            text = res.command.strip()
            if not text:
                reply = "Yes? How may I help?"
                self.speak(reply)
                return {"handled": True, "reason": "empty", "reply": reply,
                        "spoken": reply, "agent": None}

        agent, answer = self.app.ask(text)
        spoken = prepare_for_speech(answer)
        self.speak(spoken)
        return {"handled": True, "reply": answer, "spoken": spoken, "agent": agent}
