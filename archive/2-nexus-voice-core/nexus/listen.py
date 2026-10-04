"""Hands-free listening: an always-on mic that hands back whole utterances.

This is the replacement for holding a key. A background thread reads the microphone
continuously, calibrates to the room's noise floor, and runs the `vad.Endpointer` to find
where each utterance starts and ends. When you stop talking, it calls `on_utterance` with
the captured audio — which the shell transcribes and treats exactly like a typed line.

Half-duplex by design: while Nexus is speaking, the listener is paused, so it never hears
and transcribes Nexus's own voice through the laptop speakers (the classic feedback loop).
Barge-in (interrupting Nexus mid-reply) needs the mic live during playback, which only works
cleanly with headphones — so it's opt-in (see `barge_in` in the shell), off by default.

Heavy libs (sounddevice, numpy) are imported lazily, like the rest of the audio layer.
"""

from __future__ import annotations

import queue
import threading
from typing import Callable

from .vad import Endpointer, VADConfig, estimate_noise


class HandsFreeListener:
    """Construct with a callback; call start() to begin listening, stop() at exit.

    `on_utterance(audio)` is called from the worker thread with a float32 numpy array each
    time a complete utterance is detected. Keep it reasonably quick — while it runs, incoming
    audio simply buffers and is processed right after.
    """

    def __init__(
        self,
        *,
        on_utterance: Callable[[object], None],
        vad_cfg: VADConfig | None = None,
        calibrate_seconds: float = 0.5,
    ):
        self.cfg = vad_cfg or VADConfig()
        self._on_utterance = on_utterance
        self._calibrate_frames = max(1, round(calibrate_seconds * 1000 / self.cfg.frame_ms))

        self._raw: "queue.Queue" = queue.Queue()
        self._paused = threading.Event()    # set => drop audio (Nexus is speaking)
        self._stop = threading.Event()
        self._stream = None
        self._worker: threading.Thread | None = None
        self.noise_rms: float = 0.0

    # ---- control (called from the main loop) ----

    def start(self) -> None:
        import sounddevice as sd

        def callback(indata, _frames, _time, _status):
            # Audio-thread: do the minimum — copy the frame and hand it off.
            self._raw.put(indata.copy().reshape(-1))

        self._stream = sd.InputStream(
            samplerate=self.cfg.samplerate,
            channels=1,
            dtype="float32",
            blocksize=self.cfg.frame_len,
            callback=callback,
        )
        self._stream.start()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def pause(self) -> None:
        """Stop hearing (used while Nexus speaks). Buffered audio is discarded on resume."""
        self._paused.set()

    def resume(self) -> None:
        # Drop whatever arrived while paused (likely Nexus's own voice) and start clean.
        try:
            while True:
                self._raw.get_nowait()
        except queue.Empty:
            pass
        self._paused.clear()

    def stop(self) -> None:
        self._stop.set()
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:  # noqa: BLE001
                pass
        if self._worker is not None:
            self._worker.join(timeout=2)

    # ---- worker thread ----

    def _run(self) -> None:
        # Calibrate the noise floor from the first stretch of (assumed quiet) audio.
        cal: list = []
        while len(cal) < self._calibrate_frames and not self._stop.is_set():
            try:
                cal.append(self._raw.get(timeout=0.5))
            except queue.Empty:
                continue
        self.noise_rms = estimate_noise(cal)
        endpointer = Endpointer(self.cfg, noise_rms=self.noise_rms)

        while not self._stop.is_set():
            try:
                frame = self._raw.get(timeout=0.2)
            except queue.Empty:
                continue
            if self._paused.is_set():
                continue
            utterance = endpointer.push(frame)
            if utterance is not None:
                try:
                    self._on_utterance(utterance)
                except Exception:  # noqa: BLE001 — a bad turn must never kill the listener
                    pass
