"""The mouth — text-to-speech seam.

"Give me text, speak it aloud." The default backend is your operating system's built-in
voices via pyttsx3 (Windows SAPI): no key, no cost, no download, fully offline. Kept behind
this seam (like the model and the ears) so it can be swapped for ElevenLabs later by
changing `[voice] tts` in config — no other code changes.

Speaks sentence by sentence, checking `should_stop` between sentences, so the user can
barge in (start a new turn) without waiting for a long reply to finish. Heavy libraries are
imported lazily.
"""

from __future__ import annotations

import queue
import re
import threading
from typing import Callable

_SENTENCE_RE = re.compile(r"[^.!?\n]+[.!?]*")
_TERMINATOR_RE = re.compile(r"[.!?\n]")


def is_available() -> bool:
    try:
        import pyttsx3  # noqa: F401
        return True
    except Exception:
        return False


def split_sentences(text: str) -> list[str]:
    """Break a reply into sentences so speech can start sooner and be interrupted between them."""
    text = (text or "").strip()
    if not text:
        return []
    parts = [m.group(0).strip() for m in _SENTENCE_RE.finditer(text)]
    parts = [p for p in parts if p]
    return parts or [text]


def _select_voice(engine, name_part: str) -> None:
    if not name_part:
        return
    needle = name_part.lower()
    for v in engine.getProperty("voices"):
        if needle in (getattr(v, "name", "") or "").lower() or needle in (v.id or "").lower():
            engine.setProperty("voice", v.id)
            return


def speak(text: str, *, voice: str = "", should_stop: Callable[[], bool] | None = None) -> None:
    """Speak `text` aloud. Best-effort: if TTS is unavailable, return quietly (the reply text
    has already been shown on screen). `should_stop()` is checked between sentences for barge-in."""
    text = (text or "").strip()
    if not text:
        return
    try:
        import pyttsx3
        engine = pyttsx3.init()
    except Exception:
        return
    _select_voice(engine, voice)
    for sentence in split_sentences(text):
        if should_stop is not None and should_stop():
            break
        try:
            engine.say(sentence)
            engine.runAndWait()
        except Exception:
            break
    try:
        engine.stop()
    except Exception:
        pass


_CLOSE = object()      # tells the worker to shut down
_TURN_END = object()   # marks the end of one turn's speech, so wait() can return


class SpeechPlayer:
    """Speak a reply sentence by sentence *as it streams*, on a background thread.

    Two wins over calling `speak()` on the finished reply:

    1. The first sentence plays while the model is still writing the rest, so the gap
       between "you stopped talking" and "first word back" shrinks to roughly one sentence
       instead of the whole reply.
    2. One pyttsx3 engine is built once and reused across every turn, so we don't re-pay its
       (~1.7s) spin-up each time.

    Barge-in is checked between sentences — the same granularity as `speak()` — so holding
    the talk key still cuts the reply short to listen.

    `speaker` is injectable so the streaming/queueing logic can be tested without real audio;
    the default builds and reuses a pyttsx3 engine inside the worker thread (pyttsx3 engines
    are not safe to share across threads, so the engine is born and dies on that one thread).
    """

    def __init__(self, *, voice: str = "", speaker: Callable[[str], None] | None = None):
        self._voice = voice
        self._speaker = speaker          # None -> lazily build a pyttsx3 engine in the worker
        self._engine = None
        self._engine_failed = False
        self._queue: "queue.Queue" = queue.Queue()
        self._buf = ""
        self._enabled = False
        self._should_stop: Callable[[], bool] = lambda: False
        self._done = threading.Event()
        self._done.set()                 # no turn in flight yet
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # ---- per-turn API (called from the main loop) ----

    def start_turn(self, *, should_stop: Callable[[], bool] | None, enabled: bool) -> None:
        """Begin a new turn. `enabled` False makes feed/end a no-op (muted or voice off)."""
        self._buf = ""
        self._enabled = enabled
        self._should_stop = should_stop or (lambda: False)
        self._done.clear()

    def feed(self, chunk: str) -> None:
        """Take a streamed text chunk; queue any sentences it completes for speaking."""
        if not self._enabled or not chunk:
            return
        self._buf += chunk
        matches = list(_TERMINATOR_RE.finditer(self._buf))
        if not matches:
            return
        cut = matches[-1].end()                  # emit through the last finished sentence
        head, self._buf = self._buf[:cut], self._buf[cut:]
        for sentence in split_sentences(head):
            self._queue.put(sentence)

    def end_turn(self) -> None:
        """Flush the trailing partial sentence and mark the turn done."""
        if self._enabled:
            tail = self._buf.strip()
            self._buf = ""
            if tail:
                for sentence in split_sentences(tail):
                    self._queue.put(sentence)
        self._queue.put(_TURN_END)

    def wait(self) -> None:
        """Block until this turn's audio has finished (or was cut short by barge-in)."""
        self._done.wait()

    def close(self) -> None:
        """Stop the worker and dispose the engine at session end."""
        self._queue.put(_CLOSE)
        self._thread.join(timeout=5)

    # ---- worker thread ----

    def _say(self, sentence: str) -> None:
        if self._speaker is not None:
            self._speaker(sentence)
            return
        if self._engine_failed:
            return
        try:
            if self._engine is None:
                import pyttsx3
                self._engine = pyttsx3.init()
                _select_voice(self._engine, self._voice)
            self._engine.say(sentence)
            self._engine.runAndWait()
        except Exception:  # noqa: BLE001 — the reply is already on screen; never crash on audio
            self._engine_failed = True

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is _CLOSE:
                break
            if item is _TURN_END:
                self._done.set()
                continue
            # A sentence. Skip the rest of the turn the moment barge-in fires, but keep
            # draining so the _TURN_END still arrives and wait() returns.
            if self._should_stop():
                continue
            self._say(item)
        try:
            if self._engine is not None:
                self._engine.stop()
        except Exception:  # noqa: BLE001
            pass


def save_to_wav(text: str, path, *, voice: str = "") -> None:
    """Render speech to a WAV file (used by the offline self-test — no speakers needed)."""
    import pyttsx3
    engine = pyttsx3.init()
    _select_voice(engine, voice)
    engine.save_to_file(text, str(path))
    engine.runAndWait()
