"""The unified interface — one window where you type OR talk, interchangeably.

A single loop reads from two inputs at once: typed lines (a background reader thread) and
the push-to-talk key (a key listener). Whichever you use, the turn flows through the same
`Conversation.respond` — and the reply is both printed and (unless muted) spoken aloud. The
talk key defaults to Right-Ctrl so SPACE stays free for typing.

If the voice libraries or a microphone aren't available, this degrades to a plain typed
interface automatically — the typed path always works.
"""

from __future__ import annotations

import queue
import sys
import threading
import unicodedata

from . import audio, audit, ears, endings, heartbeat, inbox, killswitch, listen, mouth, safety
from .vad import VADConfig
from .agent import (
    Conversation,
    _dismiss,
    _ensure_utf8_console,
    _show_inbox,
    _show_new_interrupts,
    _streaming_printer,
)
from .config import Config, load_config

_EOF = object()

_HELP = """\
Commands:
  /help            show this
  /inbox           proactive notices Nexus is holding
  /dismiss <n>     clear inbox item n  (/dismiss all clears everything)
  /mute /speak     stop / resume speaking replies aloud
  /pause /resume   kill switch: pause / resume all proactive behavior
  /usage           running token tally
  /exit, /quit     leave
Type a line and press Enter, or hold the talk key and speak."""


def _clean(text: str) -> str:
    """Strip invisible format chars (e.g. a stray BOM from piped input) and surrounding space."""
    return "".join(c for c in (text or "") if unicodedata.category(c) != "Cf").strip()


def _assistant_text(message: dict) -> str:
    """Pull the plain text out of an assistant history turn (string for ollama, blocks for
    anthropic), so we can tell whether the last reply ended on a question."""
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _last_reply_was_a_question(history: list[dict]) -> bool:
    for message in reversed(history):
        if message.get("role") == "assistant":
            return _assistant_text(message).rstrip().endswith("?")
    return False


def _stdin_reader(line_q: "queue.Queue") -> None:
    """Feed typed lines into the queue so the main loop can watch typing and the talk key together."""
    try:
        for line in sys.stdin:
            line_q.put(line.rstrip("\r\n"))
    except Exception:  # noqa: BLE001
        pass
    line_q.put(_EOF)


def _queue_confirmer(line_q: "queue.Queue"):
    """The safety gate asks here. The answer is TYPED (you physically approve a send/delete),
    read from the same input queue; it times out to 'no' so it never blocks forever."""
    def confirm(desc: str) -> bool:
        sys.stdout.write(f"\n  Nexus wants to: {desc}\n  Allow this? [y/N] ")
        sys.stdout.flush()
        try:
            answer = line_q.get(timeout=120)
        except queue.Empty:
            return False
        if answer is _EOF:
            return False
        # Spoken input never approves a consequential action — you physically TYPE y/N.
        if isinstance(answer, tuple):
            return False
        return _clean(answer).lower() in ("y", "yes")
    return confirm


def run_mic_test(config: Config | None = None) -> None:
    """Validate hands-free hearing on its own: no brain, no speaking, no feedback loop.

    Calibrates to the room, then prints each utterance it hears (with how long it was and how
    loud, vs. the noise floor). The fastest way to tune `endpoint_ms` and confirm the mic,
    VAD, and Whisper all work before trusting the full loop. Ctrl-C to stop.
    """
    config = config or load_config()
    _ensure_utf8_console()
    if not (audio.is_available() and ears.is_available()):
        print('Voice libs not installed. Run: pip install -e ".[voice]"')
        return

    print(f"{config.name} — mic test. Warming Whisper and calibrating (stay quiet a sec)…")
    ears.preload(config.voice_whisper_model)
    count = {"n": 0}

    def on_utterance(clip) -> None:
        import numpy as np
        secs = len(clip) / config.voice_samplerate
        level = float(np.sqrt(np.mean(np.square(clip)))) if len(clip) else 0.0
        try:
            text = ears.transcribe(clip, model_size=config.voice_whisper_model)
        except Exception as exc:  # noqa: BLE001
            print(f"  (transcribe failed: {exc})")
            return
        count["n"] += 1
        print(f"  [{count['n']:>2}] {secs:4.1f}s  level={level:.3f}  heard: {text.strip()!r}")

    import time

    vcfg = VADConfig(samplerate=config.voice_samplerate, endpoint_ms=config.voice_endpoint_ms)
    listener = listen.HandsFreeListener(on_utterance=on_utterance, vad_cfg=vcfg)
    listener.start()
    print(f"Listening (endpoint_ms={config.voice_endpoint_ms}). Speak a few times. Ctrl-C to stop.\n")
    try:
        time.sleep(1.0)  # let calibration finish, then show the threshold it settled on
        floor = listener.noise_rms
        threshold = max(vcfg.min_threshold, floor * vcfg.energy_multiplier)
        print(f"  (noise floor ≈ {floor:.4f}; speech threshold ≈ {threshold:.4f})\n")
        while True:
            time.sleep(0.3)
    except KeyboardInterrupt:
        print("\nDone.")
    finally:
        listener.stop()


def run(config: Config | None = None) -> None:
    config = config or load_config()
    _ensure_utf8_console()

    voice_in = audio.is_available() and ears.is_available()
    voice_out = mouth.is_available()
    mode = config.voice_mode if voice_in else "off"   # "hands_free" | "push_to_talk" | "off"

    convo = Conversation.start(config)
    line_q: "queue.Queue" = queue.Queue()
    convo.confirmer = _queue_confirmer(line_q)

    def enqueue_utterance(clip) -> None:
        """Transcribe a captured utterance and drop it in the queue as a voice line."""
        try:
            text = _clean(ears.transcribe(clip, model_size=config.voice_whisper_model))
        except Exception:  # noqa: BLE001 — a bad clip must never kill the listener
            return
        if text:
            line_q.put(("voice", text))

    ptt = None
    listener = None
    key = config.voice_ptt_key.upper()
    if mode == "push_to_talk":
        try:
            ptt = audio.PushToTalk(key=config.voice_ptt_key, samplerate=config.voice_samplerate)
        except Exception as exc:  # noqa: BLE001
            print(f"(voice input unavailable: {exc})")
            mode = "off"
    elif mode == "hands_free":
        try:
            print("Warming the speech model and calibrating to the room (stay quiet a sec)…")
            ears.preload(config.voice_whisper_model)
            vcfg = VADConfig(samplerate=config.voice_samplerate, endpoint_ms=config.voice_endpoint_ms)
            listener = listen.HandsFreeListener(on_utterance=enqueue_utterance, vad_cfg=vcfg)
            listener.start()
        except Exception as exc:  # noqa: BLE001
            print(f"(hands-free unavailable: {exc}) — falling back to typing.")
            mode = "off"

    print(f"{config.name} — {config.tagline}")
    if mode == "hands_free":
        print("Listening — just talk, or type a line. /help for commands, /exit to quit.")
    elif mode == "push_to_talk":
        print(f"Type a line, or hold [{key}] to talk. /help for commands, /exit to quit.")
    else:
        print("Type a line. /help for commands, /exit to quit.")
        if not voice_in:
            print('(Voice off — install voice libs to talk: pip install -e ".[voice]")')

    threading.Thread(target=_stdin_reader, args=(line_q,), daemon=True).start()

    muted = {"on": False}
    model_loaded = {"done": False}
    # One reused speech engine that speaks sentences as the reply streams in (Tier 4).
    player = mouth.SpeechPlayer(voice=config.voice_tts_voice) if voice_out else None

    hb_stop = None
    if config.heartbeat_enabled:
        _thread, hb_stop = heartbeat.start_background(config)
    if killswitch.is_paused():
        print("(proactive behavior is paused — /resume to re-enable)")
    _show_new_interrupts()

    try:
        while True:
            sys.stdout.write("\nyou: ")
            sys.stdout.flush()

            user = None
            via_voice = False
            while user is None:
                if mode == "push_to_talk" and ptt is not None and ptt.is_held():
                    sys.stdout.write("\n(listening… release to send)\n")
                    sys.stdout.flush()
                    clip = ptt.record_while_held()
                    if not model_loaded["done"]:
                        sys.stdout.write("(loading speech model, one moment…)\n")
                        sys.stdout.flush()
                        model_loaded["done"] = True
                    else:
                        sys.stdout.write("(transcribing…)\n")
                        sys.stdout.flush()
                    try:
                        user = ears.transcribe(clip, model_size=config.voice_whisper_model)
                    except Exception as exc:  # noqa: BLE001
                        print(f"(couldn't transcribe: {exc})")
                        user = ""
                    via_voice = True
                    break
                try:
                    item = line_q.get(timeout=0.1)
                except queue.Empty:
                    continue
                if item is _EOF:
                    user = "/exit"
                elif isinstance(item, tuple) and item and item[0] == "voice":
                    user, via_voice = item[1], True   # a hands-free utterance, already transcribed
                else:
                    user = item                       # a typed line
                break

            user = _clean(user)
            if not user:
                if via_voice:
                    print("(heard nothing — hold the key and try again)")
                continue
            if via_voice:
                print(f"you (heard): {user}")

            low = user.lower()
            if low in ("/exit", "/quit"):
                print("Goodbye.")
                return
            if low == "/help":
                print(_HELP)
                continue
            if low == "/inbox":
                _show_inbox()
                continue
            if low.startswith("/dismiss"):
                _dismiss(user[len("/dismiss"):])
                continue
            if low == "/pause":
                killswitch.pause()
                print("Proactive behavior paused. You can still talk to me.")
                continue
            if low == "/resume":
                killswitch.resume()
                print("Proactive behavior resumed.")
                continue
            if low == "/mute":
                muted["on"] = True
                print("Muted — I won't speak replies aloud.")
                continue
            if low == "/speak":
                muted["on"] = False
                print("Unmuted — I'll speak replies aloud.")
                continue
            if low == "/usage":
                t = audit.totals()
                print(f"  {t.get('turns', 0)} turns — {t.get('input_tokens', 0)} in / "
                      f"{t.get('output_tokens', 0)} out tokens (local: $0.00)")
                continue

            # Know when to stop: if this turn is just a sign-off, let the conversation end —
            # no model call, no spoken reply. Conservative by design (see endings.py).
            if config.end_on_signoff:
                answered_before = any(m.get("role") == "assistant" for m in convo.history)
                asked = _last_reply_was_a_question(convo.history)
                if endings.is_sign_off(user, is_first_turn=not answered_before,
                                       assistant_asked=asked):
                    print("Nexus: (…)")  # a quiet, unspoken nod — Nexus doesn't take the last word
                    continue

            # Speak the reply as it streams. When muted or voice is off, the player is a
            # no-op and the reply is still printed. Barge-in by holding the talk key works in
            # push-to-talk mode; hands-free is half-duplex (mic pauses while Nexus speaks)
            # unless barge_in is enabled (headphones).
            speaking = player is not None and not muted["on"]
            barge = (lambda: ptt.is_held()) if (mode == "push_to_talk" and ptt is not None) else None

            # Half-duplex: stop hearing while Nexus speaks, so it doesn't transcribe itself.
            half_duplex = listener is not None and not config.voice_barge_in
            if half_duplex and speaking:
                listener.pause()

            if player is not None:
                player.start_turn(should_stop=barge, enabled=speaking)

            print_chunk, finish = _streaming_printer()

            def on_text(chunk: str) -> None:
                print_chunk(chunk)
                if player is not None:
                    player.feed(chunk)

            try:
                convo.respond(user, on_text=on_text)
                finish()
            except Exception as exc:  # noqa: BLE001
                finish()
                if player is not None:
                    player.end_turn()
                    player.wait()  # drain cleanly so the next turn starts fresh
                if half_duplex and speaking:
                    listener.resume()
                print(f"Nexus: (trouble reaching the model — {exc})")
                continue

            if player is not None:
                player.end_turn()
                player.wait()  # let the spoken reply finish (or be cut short by barge-in)

            if half_duplex and speaking:
                listener.resume()  # start hearing again now that Nexus has finished

            _show_new_interrupts()
    except KeyboardInterrupt:
        print("\nGoodbye.")
    finally:
        if player is not None:
            player.close()
        if listener is not None:
            listener.stop()
        if ptt is not None:
            ptt.close()
        if hb_stop is not None:
            hb_stop.set()
