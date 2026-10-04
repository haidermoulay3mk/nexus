"""Voice logic: wake matching, TTS text prep, voice selection, controller flow.

All hardware-free; no microphone, no audio engine, no faster-whisper needed.
"""

from __future__ import annotations

from nexus.kernel.config import VoiceConfig
from nexus.speech.controller import VoiceController
from nexus.speech.interfaces import VoiceInfo
from nexus.speech.tts_text import prepare_for_speech
from nexus.speech.voices import select_voice
from nexus.speech.wake import match_wake


# --- wake word ----------------------------------------------------------------

PHRASES = ["hey nexus", "daddy's home"]


def test_wake_exact_prefix_extracts_command():
    r = match_wake("Hey Nexus, what's on my calendar today?", PHRASES)
    assert r.matched
    assert r.command == "what's on my calendar today"


def test_wake_second_phrase():
    r = match_wake("Daddy's home! add a task to call mum", PHRASES)
    assert r.matched
    assert "add a task to call mum" in r.command


def test_wake_fuzzy_typo():
    # STT mishears "nexus" as "nexis"
    r = match_wake("hey nexis tell me a joke", PHRASES)
    assert r.matched
    assert r.command == "tell me a joke"


def test_wake_no_match():
    r = match_wake("what time is it", PHRASES)
    assert not r.matched


def test_wake_bare_phrase_has_empty_command():
    r = match_wake("hey nexus", PHRASES)
    assert r.matched
    assert r.command == ""


# --- tts text prep ------------------------------------------------------------

def test_prepare_strips_markdown_and_links():
    raw = "Here is **bold** and `code` and a [link](http://x.com).\n\n- bullet one"
    out = prepare_for_speech(raw)
    assert "**" not in out and "`" not in out
    assert "http://" not in out
    assert "link" in out and "bullet one" in out


def test_prepare_handles_code_block_and_urls():
    raw = "Run this:\n```\nprint(1)\n```\nSee https://example.com/page now"
    out = prepare_for_speech(raw)
    assert "print(1)" not in out
    assert "https://" not in out
    assert "a link" in out


# --- voice selection ----------------------------------------------------------

def test_select_prefers_british_male():
    voices = [
        VoiceInfo("v1", "Microsoft Zira", ["en-US"], "female"),
        VoiceInfo("v2", "Microsoft George", ["en-GB"], "male"),
        VoiceInfo("v3", "Microsoft David", ["en-US"], "male"),
    ]
    chosen = select_voice(voices)
    assert chosen.name == "Microsoft George"


def test_select_requested_name_wins():
    voices = [
        VoiceInfo("v1", "Microsoft George", ["en-GB"], "male"),
        VoiceInfo("v2", "Microsoft Hazel", ["en-GB"], "female"),
    ]
    assert select_voice(voices, requested_name="hazel").name == "Microsoft Hazel"


def test_select_empty_returns_none():
    assert select_voice([]) is None


# --- controller ---------------------------------------------------------------

class _FakeApp:
    def __init__(self):
        self.asked = []

    def ask(self, text):
        self.asked.append(text)
        return "assistant", "Very good, **sir**. The answer is [here](http://x)."


class _FakeTTS:
    def __init__(self):
        self.spoken = []

    def speak(self, text):
        self.spoken.append(text)

    def stop(self):
        pass


def _controller(require_wake=False):
    cfg = VoiceConfig(require_wake=require_wake)
    app, tts = _FakeApp(), _FakeTTS()
    return VoiceController(app, tts, cfg), app, tts


def test_controller_routes_and_speaks_clean_text():
    ctl, app, tts = _controller()
    res = ctl.process_transcript("what should I revise today")
    assert res["handled"] and res["agent"] == "assistant"
    assert app.asked == ["what should I revise today"]
    # Spoken text is cleaned of markdown.
    assert tts.spoken and "**" not in tts.spoken[0] and "http://" not in tts.spoken[0]


def test_controller_requires_wake_when_configured():
    ctl, app, tts = _controller(require_wake=True)
    miss = ctl.process_transcript("just talking to myself")
    assert not miss["handled"] and miss["reason"] == "no_wake"
    assert app.asked == []

    hit = ctl.process_transcript("hey nexus what's my progress")
    assert hit["handled"]
    assert app.asked == ["what's my progress"]


def test_controller_bare_wake_prompts_followup():
    ctl, app, tts = _controller(require_wake=True)
    res = ctl.process_transcript("hey nexus")
    assert res["handled"] and res["reason"] == "empty"
    assert app.asked == []
    assert tts.spoken  # it asked "Yes? How may I help?"


def test_controller_empty_transcript_is_unintelligible():
    ctl, app, tts = _controller()
    res = ctl.process_transcript("   ")
    assert not res["handled"] and res["reason"] == "unintelligible"
    assert app.asked == []


def test_voice_config_defaults():
    cfg = VoiceConfig()
    assert cfg.hotkey == "ctrl+space"
    assert "hey nexus" in cfg.wake_phrases
    assert cfg.wake_enabled is False          # privacy: off by default
    assert cfg.rate_wpm > 0
    assert cfg.stt_model in {"tiny", "base", "small"}


def test_controller_none_tts_does_not_crash():
    cfg = VoiceConfig()
    ctl = VoiceController(_FakeApp(), None, cfg)  # no TTS engine
    res = ctl.process_transcript("hello")
    assert res["handled"]  # still routes and returns, just doesn't speak
