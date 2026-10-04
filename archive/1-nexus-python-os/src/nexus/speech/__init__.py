"""Voice module for Nexus (see specs/voice.md).

Layered so the hardware-free logic (wake-word matching, command extraction, TTS
text prep, voice selection, the controller) is fully testable, while the heavy
audio bits (faster-whisper STT, SAPI/Piper TTS, mic capture, global hotkey) live
behind lazily-imported adapters that degrade gracefully when unavailable.
"""
