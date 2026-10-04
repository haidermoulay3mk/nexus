"""Push-to-talk audio capture.

Hold a key, speak, release — the most reliable way to talk to an assistant, because there's
never any doubt about when it's listening. A global key listener watches the push-to-talk
key; while it's held we capture from the microphone, and on release we hand back the audio.

`is_held()` lets the voice loop check whether the key is down right now — that's the barge-in
signal: if the user presses to talk while Nexus is still speaking, the mouth stops.

Heavy libraries (sounddevice, pynput) are imported lazily.
"""

from __future__ import annotations

import threading
import time


def is_available() -> bool:
    try:
        import sounddevice  # noqa: F401
        from pynput import keyboard  # noqa: F401
        return True
    except Exception:
        return False


def _resolve_key(name: str):
    from pynput import keyboard
    name = (name or "space").lower()
    special = getattr(keyboard.Key, name, None)
    if special is not None:
        return special
    return keyboard.KeyCode.from_char(name[:1])


class PushToTalk:
    """A held-key recorder. Construct once; call record_while_held() each turn; close() at exit."""

    def __init__(self, key: str = "space", samplerate: int = 16000):
        from pynput import keyboard

        self.samplerate = samplerate
        self._key = _resolve_key(key)
        self._held = threading.Event()
        self._listener = keyboard.Listener(on_press=self._on_press, on_release=self._on_release)
        self._listener.start()

    def _matches(self, key) -> bool:
        return key == self._key

    def _on_press(self, key) -> None:
        if self._matches(key):
            self._held.set()

    def _on_release(self, key) -> None:
        if self._matches(key):
            self._held.clear()

    def is_held(self) -> bool:
        return self._held.is_set()

    def record_while_held(self):
        """Block until the key is pressed, capture until it's released, return mono float32 audio."""
        import numpy as np
        import sounddevice as sd

        while not self._held.is_set():
            time.sleep(0.03)

        frames: list = []

        def callback(indata, _frames, _time, _status):
            frames.append(indata.copy())

        with sd.InputStream(samplerate=self.samplerate, channels=1, dtype="float32", callback=callback):
            while self._held.is_set():
                time.sleep(0.02)

        if not frames:
            return np.zeros(0, dtype="float32")
        return np.concatenate(frames, axis=0).flatten()

    def close(self) -> None:
        try:
            self._listener.stop()
        except Exception:
            pass
