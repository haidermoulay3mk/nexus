"""Voice-activity detection and end-of-turn for hands-free listening.

Push-to-talk had it easy: the key release said "I'm done." Hands-free has to *decide* when
you've stopped — and that decision is the most misfire-prone part of a voice assistant.
Whisper is a batch recognizer with no native "end of utterance" signal, so we detect it
ourselves from the audio: speech is energy above the room's noise floor; the turn ends after
a stretch of trailing silence.

The endpointer here is a pure state machine over fixed-size frames — no microphone, no
threads — so it can be tested deterministically with synthetic audio. The live mic loop in
`listen.py` feeds it real frames; this file just decides start/keep/stop.

Tuning lives in `VADConfig`. The two that matter most:
  - `endpoint_ms`  — how much silence ends a turn. Lower = snappier, but clips slow talkers
                     and mid-sentence pauses. This is the snappy-vs-rude dial.
  - `energy_multiplier` / `min_threshold` — how far above room noise counts as speech.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class VADConfig:
    samplerate: int = 16000
    frame_ms: int = 30          # 30 ms @ 16 kHz = 480 samples per frame
    onset_frames: int = 3       # consecutive voiced frames before we call it speech (~90 ms)
    endpoint_ms: int = 700      # trailing silence that ends a turn (the snappy-vs-rude dial)
    min_speech_ms: int = 300    # ignore anything shorter — a cough, a click, a door
    max_utterance_ms: int = 20000  # hard cap so a stuck stream can't record forever
    preroll_ms: int = 200       # keep this much audio from *before* onset, so we don't clip word 1
    energy_multiplier: float = 3.0   # speech threshold = noise_rms * this...
    min_threshold: float = 0.005     # ...but never below this, so true silence can't trigger

    @property
    def frame_len(self) -> int:
        return int(self.samplerate * self.frame_ms / 1000)


def rms(frame: np.ndarray) -> float:
    """Root-mean-square energy of a float32 frame. Cheap, and good enough to find speech."""
    if frame.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(frame, dtype=np.float64))))


def estimate_noise(frames: list[np.ndarray]) -> float:
    """Estimate the room's noise floor from (assumed quiet) calibration frames."""
    if not frames:
        return 0.0
    return float(np.median([rms(f) for f in frames]))


class Endpointer:
    """Feed it frames; it emits a finished utterance when you've stopped speaking.

    Usage:
        ep = Endpointer(cfg, noise_rms)
        for frame in frames:
            utterance = ep.push(frame)   # None, or a finished np.ndarray
            if utterance is not None:
                transcribe(utterance)
        tail = ep.flush()                # finish an utterance cut off at the end of the stream
    """

    def __init__(self, cfg: VADConfig | None = None, noise_rms: float = 0.0):
        self.cfg = cfg or VADConfig()
        self.threshold = max(self.cfg.min_threshold, noise_rms * self.cfg.energy_multiplier)
        self._frames_silence = max(1, round(self.cfg.endpoint_ms / self.cfg.frame_ms))
        self._frames_min_speech = max(1, round(self.cfg.min_speech_ms / self.cfg.frame_ms))
        self._frames_max = max(1, round(self.cfg.max_utterance_ms / self.cfg.frame_ms))
        self._frames_preroll = max(0, round(self.cfg.preroll_ms / self.cfg.frame_ms))

        self._in_speech = False
        self._voiced_run = 0          # consecutive voiced frames while still in silence
        self._silence_run = 0         # consecutive silent frames while in speech
        self._speech: list[np.ndarray] = []
        self._voiced_total = 0
        self._preroll: list[np.ndarray] = []

    def _is_voiced(self, frame: np.ndarray) -> bool:
        return rms(frame) >= self.threshold

    def push(self, frame: np.ndarray):
        """Take one frame. Returns a finished utterance (np.ndarray) or None."""
        voiced = self._is_voiced(frame)

        if not self._in_speech:
            # Keep a short rolling pre-roll so the first word isn't clipped.
            self._preroll.append(frame)
            if len(self._preroll) > self._frames_preroll:
                self._preroll.pop(0)

            if voiced:
                self._voiced_run += 1
                if self._voiced_run >= self.cfg.onset_frames:
                    self._in_speech = True
                    self._speech = list(self._preroll)        # include the pre-roll
                    self._voiced_total = self._voiced_run
                    self._silence_run = 0
                    self._preroll = []
            else:
                self._voiced_run = 0
            return None

        # In speech: accumulate, track trailing silence, watch the safety cap.
        self._speech.append(frame)
        if voiced:
            self._silence_run = 0
            self._voiced_total += 1
        else:
            self._silence_run += 1

        ended = self._silence_run >= self._frames_silence
        capped = len(self._speech) >= self._frames_max
        if ended or capped:
            return self._finish()
        return None

    def flush(self):
        """End-of-stream: finish any in-flight utterance (if it's long enough)."""
        if self._in_speech:
            return self._finish()
        return None

    def _finish(self):
        utterance = None
        if self._voiced_total >= self._frames_min_speech:
            # Drop the trailing silence we counted while waiting for the endpoint.
            keep = len(self._speech) - max(0, self._silence_run)
            utterance = np.concatenate(self._speech[:keep]) if keep > 0 else None
        # Reset for the next turn.
        self._in_speech = False
        self._voiced_run = 0
        self._silence_run = 0
        self._speech = []
        self._voiced_total = 0
        self._preroll = []
        return utterance
