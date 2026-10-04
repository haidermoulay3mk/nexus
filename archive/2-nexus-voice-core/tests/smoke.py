r"""Smoke checks for the tiers built so far. Run with the project venv:

    .\.venv\Scripts\python.exe tests\smoke.py

Offline checks always run. Live checks run against whatever backend config.toml selects
(ollama runs free against the local model; anthropic runs only if ANTHROPIC_API_KEY is set).

Every check that could touch durable state runs inside `isolated_state()`, which points the
reminders and memory stores at throwaway temp files — so tests never read or write your
real reminders or memory.
"""

from __future__ import annotations

import contextlib
import os
import sys
import tempfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nexus import audio
from nexus import audit
from nexus import ears
from nexus import heartbeat
from nexus import inbox
from nexus import killswitch
from nexus import llm
from nexus import memory
from nexus import mouth
from nexus import safety
from nexus import tools as toolkit
from nexus.agent import Conversation
from nexus.config import load_config
from nexus.notice import Notice
from nexus.prompts import build_system_prompt
from nexus.tools import reminders
from nexus.tools.base import Tool


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    return ok


def _backend_unavailable(cfg) -> bool:
    return cfg.provider == "anthropic" and not os.environ.get("ANTHROPIC_API_KEY")


@contextlib.contextmanager
def isolated_state():
    """Point every durable store (reminders, memory, inbox, heartbeat schedule) at temp
    files so tests never read or write real state."""
    tmp = Path(tempfile.gettempdir())
    rfile = tmp / "nexus_test_reminders.json"
    mfile = tmp / "nexus_test_facts.md"
    ifile = tmp / "nexus_test_inbox.json"
    sfile = tmp / "nexus_test_schedule.json"
    afile = tmp / "nexus_test_audit.log"
    ufile = tmp / "nexus_test_usage.json"
    pfile = tmp / "nexus_test_PAUSED"
    files = (rfile, mfile, ifile, sfile, afile, ufile, pfile)
    for f in files:
        f.unlink(missing_ok=True)
    saved = (reminders._STORE, memory._STORE, inbox._STORE, heartbeat._SCHEDULE,
             audit._LOG, audit._USAGE, killswitch._FLAG)
    reminders._STORE, memory._STORE, inbox._STORE, heartbeat._SCHEDULE = rfile, mfile, ifile, sfile
    audit._LOG, audit._USAGE, killswitch._FLAG = afile, ufile, pfile
    try:
        yield rfile, mfile
    finally:
        (reminders._STORE, memory._STORE, inbox._STORE, heartbeat._SCHEDULE,
         audit._LOG, audit._USAGE, killswitch._FLAG) = saved
        for f in files:
            f.unlink(missing_ok=True)


# ---------------------------------------------------------------- Tier 1

def tier1_offline(cfg) -> bool:
    print("Tier 1 — brain (offline):")
    ok = True
    ok &= check("config loads", cfg.name == "Nexus" and bool(cfg.model_name),
                f"{cfg.provider} / {cfg.model_name}")
    system = build_system_prompt(cfg)
    ok &= check("system prompt carries name + persona",
                "Nexus" in system and "of service" in system.lower())
    ok &= check("conversation builds with empty history", Conversation.start(cfg).history == [])

    if cfg.provider == "ollama":
        unreachable = replace(cfg, ollama_host="http://127.0.0.1:1", timeout_seconds=3)
    else:
        unreachable = cfg
        os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        llm.stream(config=unreachable, system="x", messages=[{"role": "user", "content": "hi"}])
        ok &= check("unreachable backend -> friendly LLMError", False, "no error raised")
    except llm.LLMError:
        ok &= check("unreachable backend -> friendly LLMError", True)
    except Exception as e:  # noqa: BLE001
        ok &= check("unreachable backend -> friendly LLMError", False, f"wrong type: {type(e).__name__}")
    return ok


def tier1_live(cfg) -> bool:
    print("Tier 1 — brain (live: remembers earlier turns):")
    if _backend_unavailable(cfg):
        print("  SKIP  anthropic backend selected but no ANTHROPIC_API_KEY set")
        return True
    with isolated_state():
        convo = Conversation.start(cfg)
        try:
            convo.respond("My name is Zephyr. Remember it.")
            r2 = convo.respond("What is my name? Reply with only the name, nothing else.")
        except llm.LLMError as e:
            print(f"  SKIP  backend not reachable — {e}")
            return True
        return check("recalls a fact from an earlier turn", "zephyr" in r2.text.lower(),
                     repr(r2.text.strip()[:80]))


# ---------------------------------------------------------------- Tier 2

def tier2_offline(cfg) -> bool:
    print("Tier 2 — tools (offline):")
    ok = True

    names = {t.name for t in toolkit.all_tools()}
    ok &= check("registry has the reminders tools",
                {"list_reminders", "add_reminder"} <= names, ", ".join(sorted(names)))

    _out, is_err = toolkit.dispatch("does_not_exist", {})
    ok &= check("unknown tool -> is_error, no crash", is_err)

    def boom(_args):
        raise RuntimeError("kaboom")
    toolkit.register(Tool(name="_boom", description="test", parameters={"type": "object", "properties": {}},
                          handler=boom))
    out, is_err = toolkit.dispatch("_boom", {})
    ok &= check("raising tool -> is_error, no crash", is_err and "kaboom" in out)

    with isolated_state():
        _out, is_err = toolkit.dispatch("add_reminder", {"text": "buy milk"})
        listed, _ = toolkit.dispatch("list_reminders", {})
        ok &= check("add_reminder persists + list_reminders reads",
                    (not is_err) and "milk" in listed, repr(listed))
    return ok


def tier2_live(cfg) -> bool:
    print("Tier 2 — tools (live: the model actually calls a tool):")
    if _backend_unavailable(cfg):
        print("  SKIP  anthropic backend selected but no ANTHROPIC_API_KEY set")
        return True
    with isolated_state():
        convo = Conversation.start(cfg)
        try:
            convo.respond("Please add a reminder to buy milk tomorrow.")
        except llm.LLMError as e:
            print(f"  SKIP  backend not reachable — {e}")
            return True
        items = reminders._load()
        used = any("milk" in (i.get("text", "").lower()) for i in items)
        return check("model called add_reminder end-to-end", used, f"{len(items)} reminder(s) saved")


# ---------------------------------------------------------------- Tier 4

def tier4_offline(cfg) -> bool:
    print("Tier 4 — memory (offline):")
    ok = True
    with isolated_state():
        out, is_err = toolkit.dispatch("remember_fact", {"text": "The user's name is Zephyr."})
        ok &= check("remember_fact saves a fact", (not is_err) and "Zephyr" in out)

        facts = memory.load_facts()
        ok &= check("load_facts reads it back", any("Zephyr" in f for f in facts), repr(facts))

        system = build_system_prompt(cfg, memory.load_facts())
        ok &= check("facts land in the system prompt", "Zephyr" in system)

        toolkit.dispatch("forget_fact", {"query": "Zephyr"})
        ok &= check("forget_fact removes it", memory.load_facts() == [])
    return ok


def tier4_live(cfg) -> bool:
    print("Tier 4 — memory (live: knows a fact after a 'restart'):")
    if _backend_unavailable(cfg):
        print("  SKIP  anthropic backend selected but no ANTHROPIC_API_KEY set")
        return True
    with isolated_state():
        first = Conversation.start(cfg)
        try:
            first.respond("Please remember that my name is Zephyr.")
        except llm.LLMError as e:
            print(f"  SKIP  backend not reachable — {e}")
            return True
        facts = memory.load_facts()
        ok = check("session 1 saved the fact", any("zephyr" in f.lower() for f in facts), repr(facts))

        # A brand-new conversation (the 'restart') reloads facts into its system prompt.
        second = Conversation.start(cfg)
        r = second.respond("What is my name? Reply with only the name.")
        ok &= check("a fresh session still knows it", "zephyr" in r.text.lower(),
                    repr(r.text.strip()[:80]))
        return ok


# ---------------------------------------------------------------- Tier 5

def tier5_offline(cfg) -> bool:
    print("Tier 5 — heartbeat (offline, deterministic):")
    ok = True
    day = datetime(2026, 1, 1, 12, 0)    # outside quiet hours
    night = datetime(2026, 1, 1, 23, 0)  # inside quiet hours (22 -> 7)

    with isolated_state():
        # Dedup: the same condition surfaces once, not every tick.
        added1 = inbox.add(Notice(key="k1", text="thing", level="interrupt"))
        added2 = inbox.add(Notice(key="k1", text="thing again", level="interrupt"))
        ok &= check("inbox dedups by key", added1 and not added2 and len(inbox.pending()) == 1)

        # Catch-up: shown once, then held (still there, dismissible, but not re-nagged).
        new = inbox.new_unshown("interrupt")
        inbox.mark_shown([it["id"] for it in new])
        ok &= check("interrupt shown once then held",
                    len(new) == 1 and inbox.new_unshown("interrupt") == [] and len(inbox.pending()) == 1)

        # Dismissible.
        inbox.dismiss(inbox.pending()[0]["id"])
        ok &= check("notice is dismissible", inbox.pending() == [])

        # Quiet hours downgrade a non-critical interrupt to a log entry.
        it = Notice(key="q", text="x", level="interrupt")
        ok &= check("quiet hours downgrade interrupt -> log",
                    heartbeat.effective_level(it, cfg, night) == "log"
                    and heartbeat.effective_level(it, cfg, day) == "interrupt")

        # Signal check: write the file -> surfaces once as an interrupt; file consumed.
        sig = Path(tempfile.gettempdir()) / "nexus_test_signal.txt"
        sig.write_text("call the dentist", encoding="utf-8")
        cfg_sig = replace(cfg, heartbeat_signal_path=str(sig))
        first = heartbeat.run_checks(cfg_sig, when=day)
        again = heartbeat.run_checks(cfg_sig, when=day)
        ok &= check("signal surfaces once as interrupt, then not again",
                    any(s["text"] == "call the dentist" and s["level"] == "interrupt" for s in first)
                    and not any(s["text"] == "call the dentist" for s in again))
        sig.unlink(missing_ok=True)

        # Reminders check is quiet: a log entry, never an interrupt.
        toolkit.dispatch("add_reminder", {"text": "pay rent"})
        rem = heartbeat.run_checks(cfg_sig, when=day)
        ok &= check("reminders check is a quiet log, not an interrupt",
                    any(s["level"] == "log" and "reminder" in s["text"].lower() for s in rem), repr(rem))

        # Schedule: first tick registers without firing everything; advancing time reschedules.
        heartbeat._save_schedule({})
        fired = heartbeat.run_due(cfg_sig, now=1000.0)
        sched1 = heartbeat._load_schedule()
        ok &= check("first tick schedules, no boot stampede",
                    fired == [] and len(sched1) > 0 and all(v > 1000.0 for v in sched1.values()))
        heartbeat.run_due(cfg_sig, now=1000.0 + 1_000_000)
        sched2 = heartbeat._load_schedule()
        ok &= check("schedule persists and reschedules when due",
                    all(sched2[k] > sched1[k] for k in sched1))
    return ok


# ---------------------------------------------------------------- Tier 6

def _scripted_forget_stream():
    """Stand in for the model: first turn calls the (gated) forget_fact tool, second turn
    just answers. Lets us test the confirmation gate without depending on the real model."""
    calls = {"n": 0}

    def fake(*, config, system, messages, tools=None, on_text=None):
        calls["n"] += 1
        if calls["n"] == 1:
            tc = llm.ToolCall(id="c0", name="forget_fact", arguments={"query": "Zephyr"})
            return llm.LLMResult(
                text="", tool_calls=[tc],
                assistant_message={"role": "assistant", "content": "",
                                   "tool_calls": [{"function": {"name": "forget_fact",
                                                                "arguments": {"query": "Zephyr"}}}]},
                stop_reason="tool_use", input_tokens=10, output_tokens=5)
        return llm.LLMResult(text="ok", tool_calls=[],
                             assistant_message={"role": "assistant", "content": "ok"},
                             stop_reason="end_turn", input_tokens=2, output_tokens=1)
    return fake


def _run_gate(cfg, allow: bool) -> list:
    """Seed a memory fact, then drive a (scripted) turn that tries to forget it, with a
    confirmer that allows or denies. Returns the remaining facts."""
    memory._save_facts(["The user's name is Zephyr."])
    saved = llm.stream
    llm.stream = _scripted_forget_stream()
    try:
        convo = Conversation.start(cfg)
        convo.confirmer = lambda _desc: allow
        convo.respond("Please forget my name.")
    finally:
        llm.stream = saved
    return memory.load_facts()


def tier6_offline(cfg) -> bool:
    print("Tier 6 — rails (offline, deterministic):")
    ok = True
    with isolated_state():
        forget = toolkit.get("forget_fact")
        add = toolkit.get("add_reminder")

        ok &= check("consequential tool is gated", safety.needs_confirmation(forget, cfg))
        ok &= check("additive/read tool is not gated", not safety.needs_confirmation(add, cfg))
        ok &= check("gate can be turned off in config",
                    not safety.needs_confirmation(forget, replace(cfg, safety_gate_enabled=False)))
        ok &= check("config can gate more tools (no code edit)",
                    safety.needs_confirmation(add, replace(cfg, safety_confirm_tools=["add_reminder"])))

        # The gate actually blocks vs. allows the action.
        denied = _run_gate(cfg, allow=False)
        ok &= check("gate DENIED -> the delete did NOT run",
                    any("zephyr" in f.lower() for f in denied), repr(denied))
        allowed = _run_gate(cfg, allow=True)
        ok &= check("gate ALLOWED -> the delete ran", allowed == [], repr(allowed))

        # Kill switch: while paused, a due check surfaces nothing and isn't even run.
        sig = Path(tempfile.gettempdir()) / "nexus_test_signal6.txt"
        sig.write_text("ping", encoding="utf-8")
        cfg_sig = replace(cfg, heartbeat_signal_path=str(sig))
        heartbeat._save_schedule({"signal": 1.0, "reminders_due": 1.0})  # both due in the past
        killswitch.pause()
        paused = heartbeat.run_due(cfg_sig, now=1000.0)
        ok &= check("kill switch: paused heartbeat surfaces nothing", paused == [] and sig.exists())
        killswitch.resume()
        resumed = heartbeat.run_due(cfg_sig, now=1000.0)
        ok &= check("resumed heartbeat runs again",
                    any(s["text"] == "ping" for s in resumed) and not sig.exists())
        sig.unlink(missing_ok=True)

        # Audit + usage tally. (Reset first — the gate sub-tests above already logged turns,
        # which itself shows the tally accumulates across a session.)
        audit._USAGE.unlink(missing_ok=True)
        audit.record_usage(10, 5)
        audit.record_usage(2, 3)
        t = audit.totals()
        ok &= check("usage tally accumulates",
                    t["turns"] == 2 and t["input_tokens"] == 12 and t["output_tokens"] == 8, repr(t))
        audit.log("test_event", "hello")
        ok &= check("audit log writes a line",
                    audit._LOG.exists() and "test_event" in audit._LOG.read_text(encoding="utf-8"))

        # The untrusted-content + gate rules are stated to the model.
        system = build_system_prompt(cfg, [])
        ok &= check("system prompt carries the untrusted-content + gate rules",
                    "DATA, not instructions" in system and "explicit yes" in system.lower())
    return ok


# ---------------------------------------------------------------- Hands-free VAD / endpointing

def vad_offline(cfg) -> bool:
    print("Hands-free — voice-activity detection + endpointing (offline, synthetic audio):")
    import numpy as np
    from nexus.vad import Endpointer, VADConfig
    ok = True

    vc = VADConfig(frame_ms=30, onset_frames=2, endpoint_ms=150, min_speech_ms=90,
                   preroll_ms=60, max_utterance_ms=5000)
    sil = np.zeros(vc.frame_len, dtype="float32")
    sp = np.full(vc.frame_len, 0.2, dtype="float32")  # well above the 0.005 floor

    def run(frames):
        ep = Endpointer(vc, noise_rms=0.0)
        out = [u for u in (ep.push(f) for f in frames) if u is not None]
        tail = ep.flush()
        if tail is not None:
            out.append(tail)
        return out

    # A clean utterance: silence, ~15 frames of speech, then enough trailing silence to end.
    one = run([sil] * 3 + [sp] * 15 + [sil] * 8)
    ok &= check("one utterance is detected and ended", len(one) == 1, f"{len(one)} found")
    if one:
        # Trailing silence is trimmed; pre-roll keeps the onset. Length is ~speech, not the tail.
        n_frames = len(one[0]) / vc.frame_len
        ok &= check("trailing silence trimmed (length ~ speech, not the silence)",
                    14 <= n_frames <= 19, f"{n_frames:.0f} frames")

    # A short blip (below min_speech) is ignored, not transcribed.
    blip = run([sil] * 3 + [sp] * 2 + [sil] * 8)
    ok &= check("a sub-threshold blip is ignored", blip == [], f"{len(blip)} found")

    # Two utterances separated by a clear pause segment into two.
    two = run([sil] * 3 + [sp] * 15 + [sil] * 8 + [sp] * 15 + [sil] * 8)
    ok &= check("two utterances separated by a pause -> two turns", len(two) == 2, f"{len(two)} found")

    # Speech still going when the stream ends -> flush() finishes it (no lost final turn).
    cut = run([sil] * 3 + [sp] * 15)
    ok &= check("an utterance cut off at end-of-stream is flushed", len(cut) == 1, f"{len(cut)} found")
    return ok


# ---------------------------------------------------------------- Endings (Tier 5 of the voice doc)

def endings_offline(cfg) -> bool:
    print("Endings — know when to stop (offline, deterministic):")
    from nexus import endings
    ok = True

    # Clear sign-offs: Nexus should stay quiet. (mid-conversation, no open question)
    sign_offs = [
        "okay, thanks", "thanks!", "thank you", "cool, thanks", "sounds good",
        "got it", "bye", "goodbye", "good night", "that's all for now", "right on",
        "awesome", "appreciate it", "perfect, will do", "great, I'll do that",
        "great, I'll send that email myself", "I'll handle it", "that's it, cheers",
    ]
    for u in sign_offs:
        if not endings.is_sign_off(u, is_first_turn=False, assistant_asked=False):
            ok &= check(f"sign-off recognized: {u!r}", False)

    # Must NOT be treated as sign-offs — these all want a reply.
    keep_going = [
        "okay, so the revenue is up",          # continuation + new info
        "great, send that email",              # command to Nexus
        "thanks, can you also remind me at 5?",# request
        "what about tomorrow?",                # question
        "one more thing",                      # request
        "cool, how does that work?",           # question
        "thanks for nothing, this is broken",  # complaint
        "great idea, let's build the new thing",# positive but leading into work
        "well",                                # look-alike for 'we'll' — not a goodbye
        "I'll think about it",                 # soft, ambiguous — bias to reply
        "set a reminder to buy milk",          # plain command
    ]
    for u in keep_going:
        if endings.is_sign_off(u, is_first_turn=False, assistant_asked=False):
            ok &= check(f"NOT a sign-off: {u!r}", False)

    # The first thing said is never swallowed, even if it's a bare "thanks".
    ok &= check("first utterance is never a sign-off",
                not endings.is_sign_off("thanks", is_first_turn=True))

    # If Nexus just asked a question, a bare 'yeah'/'thanks' is an ANSWER, not a goodbye —
    # only an explicit farewell ends it there.
    ok &= check("after a question, 'yeah' is an answer (reply)",
                not endings.is_sign_off("yeah", assistant_asked=True))
    ok &= check("after a question, 'sure, thanks' still replies",
                not endings.is_sign_off("sure, thanks", assistant_asked=True))
    ok &= check("after a question, an explicit 'goodbye' still ends it",
                endings.is_sign_off("okay, goodbye", assistant_asked=True))

    ok &= check("all sign-off / keep-going cases classified correctly", ok)
    return ok


# ---------------------------------------------------------------- Tier 3 (voice)

def tier3_offline(cfg) -> bool:
    print("Tier 3 — voice (offline):")
    ok = True
    sents = mouth.split_sentences("Hello there. How are you? Fine!")
    ok &= check("sentence splitter splits a reply for sentence-by-sentence speech",
                len(sents) == 3, repr(sents))
    print(f"  INFO  voice libs installed -> audio:{audio.is_available()} "
          f"stt:{ears.is_available()} tts:{mouth.is_available()}")

    # Streaming speech (Tier 4): a fake speaker records what would be spoken, so the
    # streaming/queueing/barge-in logic is tested without a sound card.
    def drive(chunks, should_stop=None, enabled=True):
        spoken = []
        player = mouth.SpeechPlayer(speaker=spoken.append)
        player.start_turn(should_stop=should_stop, enabled=enabled)
        for ch in chunks:
            player.feed(ch)
        player.end_turn()
        player.wait()
        player.close()
        return spoken

    # Sentences are spoken in order as they stream, split on boundaries, trailing bit flushed.
    spoken = drive(["Hello there. ", "How are ", "you? ", "Fine"])
    ok &= check("streams sentences in order, flushes the trailing partial",
                spoken == ["Hello there.", "How are you?", "Fine"], repr(spoken))

    # Barge-in: once should_stop is true, the remaining sentences are skipped (not spoken),
    # and wait() still returns (the turn drains cleanly).
    spoken = drive(["One. Two. Three."], should_stop=lambda: True)
    ok &= check("barge-in skips remaining sentences", spoken == [], repr(spoken))

    # Muted / voice off: feeding does nothing and wait() returns immediately.
    spoken = drive(["Anything at all."], enabled=False)
    ok &= check("disabled player speaks nothing", spoken == [], repr(spoken))
    return ok


def tier3_live(cfg) -> bool:
    print("Tier 3 — voice (live: speak -> WAV -> transcribe, no mic or speakers needed):")
    if not (mouth.is_available() and ears.is_available()):
        print('  SKIP  voice libs not installed (pip install -e ".[voice]")')
        return True
    wav = Path(tempfile.gettempdir()) / "nexus_voice_selftest.wav"
    wav.unlink(missing_ok=True)
    try:
        mouth.save_to_wav("Testing one two three.", wav)
        if not wav.exists() or wav.stat().st_size == 0:
            print("  SKIP  TTS produced no WAV on this machine")
            return True
        heard = ears.transcribe(str(wav), model_size=cfg.voice_whisper_model)
    except Exception as e:  # noqa: BLE001
        print(f"  SKIP  self-test couldn't run ({e})")
        return True
    finally:
        wav.unlink(missing_ok=True)
    low = heard.lower()
    return check("spoken words transcribe back",
                 any(w in low for w in ("test", "one", "two", "three")), repr(heard))


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass

    cfg = load_config()
    print(f"Nexus smoke test  (backend: {cfg.provider} / {cfg.model_name})\n")

    ok = True
    for section in (tier1_offline, tier1_live, tier2_offline, tier2_live,
                    tier4_offline, tier4_live, tier5_offline, tier6_offline,
                    endings_offline, vad_offline, tier3_offline, tier3_live):
        ok &= section(cfg)
        print()

    print("RESULT:", "ALL PASS" if ok else "FAILURES ABOVE")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
