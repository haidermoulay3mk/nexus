r"""Tier 1 of the voice-smoothness work: measure where a turn's time actually goes.

Run with the project venv:

    .\.venv\Scripts\python.exe tests\bench_turn.py
    .\.venv\Scripts\python.exe tests\bench_turn.py --text "remind me to call the dentist tomorrow"

This does NOT change any behavior. It times each stage of one turn with realistic inputs,
then lays out the wait the user feels — from "you stopped speaking" to "first word back" —
under today's serialized pipeline vs. a streamed one. The point is a number, not a feeling.

Models are warmed before timing, so we measure the per-turn cost you feel on turn two, not
the one-time model load on turn one. The brain stage runs against whatever backend
config.toml selects; if it isn't reachable, that stage is skipped and the rest still report.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nexus import ears, llm, memory, mouth
from nexus.agent import Conversation
from nexus.config import load_config

# A representative spoken utterance: long enough to be a real turn, short enough to be typical.
SAMPLE_UTTERANCE = "Hey Nexus, what reminders do I have for tomorrow?"
# A probe that gets a short spoken-style reply without depending on tools or real state.
SAMPLE_PROBE = "In one short sentence, tell me you're ready to help."


def _fmt(seconds: float) -> str:
    return f"{seconds * 1000:6.0f} ms"


def _audio_seconds(wav: Path, samplerate: int) -> float:
    """Length of a 16-bit mono PCM WAV in seconds (header is 44 bytes)."""
    try:
        return max(0.0, (wav.stat().st_size - 44) / 2 / samplerate)
    except OSError:
        return 0.0


def measure_stt(cfg) -> dict | None:
    """Time transcription of a realistic clip. Returns the per-turn cost and a real-time factor.

    A real-time factor (transcribe time / audio length) > 1 means Whisper is slower than the
    speech itself — every second you talk costs more than a second to transcribe after you stop.
    """
    if not (mouth.is_available() and ears.is_available()):
        print("  SKIP  stt — voice libs not installed")
        return None

    wav = Path(tempfile.gettempdir()) / "nexus_bench_stt.wav"
    wav.unlink(missing_ok=True)
    try:
        mouth.save_to_wav(SAMPLE_UTTERANCE, wav, voice=cfg.voice_tts_voice)
        if not wav.exists() or wav.stat().st_size == 0:
            print("  SKIP  stt — TTS produced no WAV on this machine")
            return None
        ears.preload(cfg.voice_whisper_model)  # warm: don't time the one-time model load
        t0 = time.perf_counter()
        heard = ears.transcribe(str(wav), model_size=cfg.voice_whisper_model)
        dt = time.perf_counter() - t0
    except Exception as exc:  # noqa: BLE001
        print(f"  SKIP  stt — couldn't run ({exc})")
        return None
    finally:
        audio_s = _audio_seconds(wav, cfg.voice_samplerate)
        wav.unlink(missing_ok=True)

    rtf = (dt / audio_s) if audio_s else float("nan")
    print(f"  transcribe (whisper '{cfg.voice_whisper_model}'): {_fmt(dt)}"
          f"   [{audio_s:.1f}s of audio, {rtf:.2f}x real-time]   heard: {heard!r}")
    return {"transcribe": dt, "audio_s": audio_s, "rtf": rtf}


def measure_brain(cfg, probe: str) -> dict | None:
    """Time the model: first token (when speech *could* start) vs. full reply (when it does today)."""
    marks: dict = {}

    def on_text(_chunk: str) -> None:
        marks.setdefault("first_token", time.perf_counter())

    # Don't touch real memory: a throwaway facts store for this one turn.
    saved_store = memory._STORE
    memory._STORE = Path(tempfile.gettempdir()) / "nexus_bench_facts.md"
    memory._STORE.unlink(missing_ok=True)
    try:
        convo = Conversation.start(cfg)
        t0 = time.perf_counter()
        try:
            result = convo.respond(probe, on_text=on_text)
        except llm.LLMError as exc:
            print(f"  SKIP  brain — backend not reachable ({exc})")
            return None
        except Exception as exc:  # noqa: BLE001
            print(f"  SKIP  brain — {type(exc).__name__}: {exc}")
            return None
        total = time.perf_counter() - t0
    finally:
        memory._STORE.unlink(missing_ok=True)
        memory._STORE = saved_store

    ttft = marks.get("first_token", t0 + total) - t0
    reply = result.text.strip()
    print(f"  brain ({cfg.provider}/{cfg.model_name}): first token {_fmt(ttft)}"
          f"   full reply {_fmt(total)}   ({len(reply)} chars)")
    print(f"    reply: {reply[:120]!r}")
    return {"ttft": ttft, "total": total, "reply": reply}


def measure_mouth(cfg, reply: str | None) -> dict | None:
    """Time the mouth: engine spin-up + synth of the first sentence (the earliest a word can play)."""
    if not mouth.is_available():
        print("  SKIP  mouth — TTS not installed")
        return None

    text = reply or "Sure. You have two reminders for tomorrow: pay rent, and call the dentist."
    first_sentence = mouth.split_sentences(text)[0]

    out = Path(tempfile.gettempdir()) / "nexus_bench_tts.wav"
    out.unlink(missing_ok=True)
    try:
        # Engine spin-up cost — paid every turn today, because mouth.speak() inits a fresh engine.
        import pyttsx3
        t0 = time.perf_counter()
        engine = pyttsx3.init()
        engine.stop()
        init_dt = time.perf_counter() - t0

        t1 = time.perf_counter()
        mouth.save_to_wav(first_sentence, out, voice=cfg.voice_tts_voice)
        synth_first = time.perf_counter() - t1
    except Exception as exc:  # noqa: BLE001
        print(f"  SKIP  mouth — couldn't run ({exc})")
        return None
    finally:
        out.unlink(missing_ok=True)

    print(f"  mouth (windows): engine init {_fmt(init_dt)}   synth first sentence {_fmt(synth_first)}")
    print(f"    first sentence: {first_sentence[:80]!r}")
    return {"init": init_dt, "synth_first": synth_first}


def report(stt: dict | None, brain: dict | None, mouth_m: dict | None) -> None:
    print("\n" + "=" * 72)
    print("THE WAIT YOU FEEL — from 'you stopped speaking' to 'first word back'")
    print("=" * 72)
    if not (stt and brain and mouth_m):
        print("  (need stt + brain + mouth all measured to assemble the full timeline;")
        print("   re-run with the backend reachable and voice libs installed)")
        return

    # Today: capture is buffered, then transcribe, then the WHOLE reply generates, THEN the
    # mouth spins up and speaks. Every stage is serialized — nothing overlaps.
    today = stt["transcribe"] + brain["total"] + mouth_m["init"] + mouth_m["synth_first"]
    # Streamed (Tier 4): the mouth starts on the first sentence as soon as it's generated,
    # while the rest of the reply is still being written. First-token is our best proxy for
    # "first sentence ready" (a short lead sentence lands at roughly first-token time).
    streamed = stt["transcribe"] + brain["ttft"] + mouth_m["init"] + mouth_m["synth_first"]
    saved = today - streamed

    def bar(label: str, value: float, total: float) -> str:
        width = max(1, round(40 * value / total)) if total else 1
        return f"  {label:<26} {_fmt(value)}  {'#' * width}"

    print("\nTODAY (serialized — voice waits for the entire reply):")
    print(bar("transcribe", stt["transcribe"], today))
    print(bar("full reply generates", brain["total"], today))
    print(bar("engine init + 1st sentence", mouth_m["init"] + mouth_m["synth_first"], today))
    print(f"  {'-' * 38}")
    print(f"  {'first word heard at':<26} {_fmt(today)}")

    print("\nSTREAMED (Tier 4 — speak the first sentence as it lands):")
    print(bar("transcribe", stt["transcribe"], today))
    print(bar("first sentence generates", brain["ttft"], today))
    print(bar("engine init + 1st sentence", mouth_m["init"] + mouth_m["synth_first"], today))
    print(f"  {'-' * 38}")
    print(f"  {'first word heard at':<26} {_fmt(streamed)}")

    print(f"\n  ESTIMATED DEAD AIR REMOVED: {_fmt(saved)}"
          f"   ({100 * saved / today:.0f}% faster to first word)" if today else "")
    if stt["rtf"] >= 0.8:
        print(f"  NOTE: Whisper runs at {stt['rtf']:.2f}x real-time — a long question makes the")
        print("        transcribe bar grow with it. That's the next lever after streaming.")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass

    parser = argparse.ArgumentParser(description="Measure where a Nexus turn's time goes.")
    parser.add_argument("--text", default=SAMPLE_PROBE, help="the probe the brain answers")
    args = parser.parse_args()

    cfg = load_config()
    print(f"Nexus turn benchmark  (backend: {cfg.provider}/{cfg.model_name}, "
          f"whisper: {cfg.voice_whisper_model})\n")

    print("Stages (each measured with models warmed):")
    stt = measure_stt(cfg)
    brain = measure_brain(cfg, args.text)
    mouth_m = measure_mouth(cfg, brain["reply"] if brain else None)
    report(stt, brain, mouth_m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
