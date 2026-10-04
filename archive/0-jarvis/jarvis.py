#!/usr/bin/env python3
"""
Desktop clap listener: reads the default microphone and logs when two loud transients
(a double clap) are detected within a short time window.

Run:
  python -m pip install -r requirements.txt
  python clap_listen.py

Tuning (constants below):
  SAMPLE_RATE   — usually 44100 or 48000; match your device if needed.
  BLOCK_MS      — analysis window size; smaller = snappier, noisier.
  SPIKE_RATIO   — how many times louder than the noise floor counts as a clap;
                    raise if false triggers; lower if claps are missed.
  COOLDOWN_S    — minimum seconds between double-clap logs (debounce).
  MIN_DOUBLE_GAP_S / MAX_DOUBLE_GAP_S — allowed time between the two claps.
  RETRIGGER_RATIO — audio must fall below threshold * this before another hit counts.
  NOISE_FLOOR_ALPHA — closer to 1 = slower baseline adaptation to room noise.
  MIN_RMS       — ignore spikes below this absolute level (float audio ~ [-1, 1]).
  SONG_URI      — Spotify or YouTube URL/URI to open on each double clap (empty = log only).
  FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP — if True, launch Cursor without -n (reuse / focus existing instance).
  OPEN_NEW_CURSOR_ON_DOUBLE_CLAP — if True, also launch Cursor with -n (extra new window; runs after focus launch if both).
  CURSOR_OPEN_FULLSCREEN — Windows: after focus/launch, send F11 to enter Cursor/VS Code-style fullscreen (toggle off with F11).
  OPEN_CLAUDE_DESKTOP_APP — launch the installed Claude desktop app after Spotify.
  OPEN_GMAIL_YOUTUBE_IN_COMET — open one new Comet window with Gmail + YouTube tabs (GMAIL_URL / YOUTUBE_URL).
  COMET_WINDOW_MONITOR — 1-based display index for the Comet window (Windows: sorted left-to-top).
  CHROME_SEPARATE_SITE_PROFILES — Windows: if True, uses a temp --user-data-dir (not your normal profile).
    Default False so the Comet window uses your usual profile and logins; enable only if the window keeps
    opening on the wrong monitor and you accept a separate profile for automation.
  OPEN_CHROME_FULLSCREEN — Fullscreen on the chosen monitor (Windows: new window is detected and snapped with SetWindowPos).
  VOICE_CHAT_ENABLED — two-way voice chat on double clap: a fresh casual intro (no canned
    line), then it listens and replies until you say "goodbye" or stay silent.
    Brain = Groq (free; set GROQ_API_KEY in .env from https://console.groq.com),
    ears = local faster-whisper (offline, no key; first run downloads WHISPER_MODEL),
    mouth = ElevenLabs (ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID in .env).
    Apps/tabs open once per run; each later double clap starts a fresh chat.
    Tip: use headphones — if your speakers play the song/replies out loud, the mic
    can hear them and interrupt the chat.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import wave
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv
import numpy as np
import sounddevice as sd

# --- tuning knobs -----------------------------------------------------------
SAMPLE_RATE = 44100
BLOCK_MS = 40
CHANNELS = 1

SPIKE_RATIO = 7.0
COOLDOWN_S = 0.45
MIN_DOUBLE_GAP_S = 0.05
MAX_DOUBLE_GAP_S = 0.35
RETRIGGER_RATIO = 0.55
NOISE_FLOOR_ALPHA = 0.992
MIN_RMS = 0.012
QUIET_GATE_MULT = 2.2  # update noise floor only when below floor * this
# Startup mic probe: if default input RMS stays below this, scan for a louder device.
INPUT_PROBE_S = 0.5
INPUT_SILENT_RMS = 0.001

# Spotify: "spotify:track:TRACK_ID" or https://open.spotify.com/track/...
# YouTube: https://www.youtube.com/watch?v=...
SONG_URI = ""  # paste your own track here
# Cursor: focus existing instance (no -n). Set OPEN_NEW_CURSOR_ON_DOUBLE_CLAP for a new window as well.
FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP = True
OPEN_NEW_CURSOR_ON_DOUBLE_CLAP = False
CURSOR_OPEN_FULLSCREEN = True

# Claude desktop app (launched directly, not in a browser).
OPEN_CLAUDE_DESKTOP_APP = True
# Comet browser (fallback: default browser). URLs overridable in .env.
OPEN_GMAIL_YOUTUBE_IN_COMET = True
OPEN_CHROME_FULLSCREEN = True
# False = default browser profile (your normal user, extensions, cookies). True = temp dir under %TEMP%.
CHROME_SEPARATE_SITE_PROFILES = False
# Which physical screen (1 = leftmost/top-first after sorting). Windows only; ignored elsewhere.
COMET_WINDOW_MONITOR = 1

JARVIS_WELCOME_ENABLED = True
# Seconds after launching SONG_URI before speaking (gives Spotify/browser time to start).
JARVIS_AFTER_SONG_DELAY_S = 1.0

# --- Two-way voice conversation --------------------------------------------
# On double clap: open apps, speak a fresh casual intro, then listen + reply
# back and forth until you say goodbye (or stay silent). Brain = Groq (free),
# ears = local faster-whisper (offline), mouth = ElevenLabs (already set up).
VOICE_CHAT_ENABLED = True
# Groq LLM (free tier). Create a key at https://console.groq.com and put GROQ_API_KEY in .env.
# 70b-versatile is smarter and reliable at tool/action calling; swap via GROQ_MODEL in .env
# (e.g. "llama-3.1-8b-instant" for snappier but dumber replies).
GROQ_MODEL_DEFAULT = "llama-3.3-70b-versatile"
# Local speech-to-text. "base.en" is English-tuned (more accurate than plain "base")
# and light on memory. If you have RAM to spare, set WHISPER_MODEL=small.en in .env for
# noticeably better accuracy; drop to "base.en"/"tiny.en" if it's slow or runs out of memory.
WHISPER_MODEL_DEFAULT = "base.en"
# How Jarvis addresses you (override with JARVIS_USER_NAME in .env).
JARVIS_USER_NAME_DEFAULT = "sir"
# Conversation tuning.
CHAT_SPEECH_START_TIMEOUT_S = 12.0  # wait this long for you to start talking
CHAT_END_SILENCE_S = 0.9            # trailing silence that ends your turn
CHAT_MIN_UTTERANCE_S = 0.3          # ignore blips shorter than this
CHAT_MAX_UTTERANCE_S = 30.0         # hard cap on one turn
# Absolute floor for the speech threshold; the detector also self-calibrates to
# your room each turn (it requires sustained sound, so mic noise won't trigger it).
CHAT_SPEECH_RMS = 0.012
CHAT_START_BLOCKS = 3              # consecutive loud blocks needed to start a turn
CHAT_END_PHRASES = (
    "goodbye",
    "good bye",
    "bye",
    "see you",
    "that's all",
    "that is all",
    "stop",
    "exit",
    "quit",
    "nothing thanks",
    "nothing thank you",
)
JARVIS_SYSTEM_PROMPT = (
    "You are Jarvis, a witty, warm, loyal British AI assistant speaking out loud. "
    "Keep every reply short and conversational - 1 to 3 sentences, the way a person "
    "actually talks, never written like an essay. No markdown, no bullet points, no "
    "emojis, no stage directions or asterisks. Be casual, a touch dry-humoured, and "
    "genuinely helpful. "
    "You can actually DO things on the user's computer via your tools: search or play "
    "YouTube, add Google Calendar events, web-search, and open websites. When the user "
    "asks for one of these, CALL THE TOOL rather than just describing it. After a tool "
    "runs, confirm what you did in one short spoken sentence. Only use a tool when the "
    "user clearly wants that action; otherwise just chat. If a request needs a detail "
    "you don't have (like a date or time), ask one quick question first. The transcript "
    "comes from speech-to-text and may have small errors - if something seems garbled, "
    "ask the user to repeat instead of guessing."
)
# Phrases Whisper notoriously invents from silence/noise; treat as "heard nothing".
_STT_JUNK = {
    "",
    "you",
    "thank you",
    "thank you for watching",
    "thanks for watching",
    "thank you very much",
    "please subscribe",
    "subtitles by the amara.org community",
    ".",
}
# Spoken if Groq is unavailable, so there's still a (non-fixed) greeting.
CASUAL_INTRO_FALLBACKS = (
    "Welcome back. What are we getting into today?",
    "Good to see you. Where would you like to start?",
    "Back at it, I see. What's first?",
    "Hello again. Ready when you are.",
    "Welcome home. What can I do for you?",
)
# Save ElevenLabs PCM as WAV under .cache/jarvis_welcome/; replay skips the API when the key matches.
JARVIS_WELCOME_CACHE_ENABLED = True

load_dotenv(Path(__file__).resolve().parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("clap_listen")


def block_samples() -> int:
    n = int(SAMPLE_RATE * BLOCK_MS / 1000)
    return max(n, 1)


def rms_mono(block: np.ndarray) -> float:
    if block.ndim > 1:
        block = np.mean(block.astype(np.float64), axis=1)
    else:
        block = block.astype(np.float64)
    if block.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(block**2)))


def _input_devices() -> list[tuple[int, dict]]:
    return [
        (i, dev)
        for i, dev in enumerate(sd.query_devices())
        if dev["max_input_channels"] >= 1
    ]


def _resolve_input_device_index(spec: str) -> int:
    spec = spec.strip()
    if spec.isdigit():
        idx = int(spec)
        sd.query_devices(idx)
        return idx
    needle = spec.lower()
    for idx, dev in _input_devices():
        if needle in dev["name"].lower():
            return idx
    raise ValueError(f"No input device matches {spec!r}")


def _probe_input_max_rms(device: int, blocksize: int) -> float | None:
    try:
        with sd.InputStream(
            device=device,
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=blocksize,
        ) as stream:
            peak = 0.0
            deadline = time.monotonic() + INPUT_PROBE_S
            while time.monotonic() < deadline:
                data, _ = stream.read(blocksize)
                peak = max(peak, rms_mono(data))
            return peak
    except sd.PortAudioError:
        return None


def _choose_input_device(blocksize: int) -> int:
    log.info("Audio devices:\n%s", sd.query_devices())

    override = (os.environ.get("JARVIS_INPUT_DEVICE") or "").strip()
    if override:
        try:
            idx = _resolve_input_device_index(override)
        except ValueError as e:
            log.error("%s", e)
            log.error("Set JARVIS_INPUT_DEVICE to a device index or name substring.")
            raise SystemExit(1) from e
        name = sd.query_devices(idx)["name"]
        peak = _probe_input_max_rms(idx, blocksize)
        log.info("Using JARVIS_INPUT_DEVICE [%d]: %s", idx, name)
        if peak is None:
            log.warning("Could not open configured mic; trying anyway.")
        elif peak < INPUT_SILENT_RMS:
            log.warning(
                "Configured mic looks silent (probe rms=%.5f). "
                "Check Windows input level or try another JARVIS_INPUT_DEVICE.",
                peak,
            )
        else:
            log.info("Mic probe OK (rms=%.5f).", peak)
        return idx

    default = sd.default.device[0]
    if default is not None and default >= 0:
        default_name = sd.query_devices(default)["name"]
        peak = _probe_input_max_rms(default, blocksize)
        if peak is not None and peak >= INPUT_SILENT_RMS:
            log.info(
                "Using default microphone [%d]: %s (probe rms=%.5f)",
                default,
                default_name,
                peak,
            )
            return default
        log.warning(
            "Default mic [%d] %s is silent or unavailable (probe rms=%s); "
            "scanning other inputs...",
            default,
            default_name,
            f"{peak:.5f}" if peak is not None else "unopenable",
        )

    best_idx: int | None = None
    best_peak = -1.0
    for idx, dev in _input_devices():
        if default is not None and idx == default:
            continue
        peak = _probe_input_max_rms(idx, blocksize)
        if peak is not None and peak > best_peak:
            best_peak = peak
            best_idx = idx

    if best_idx is not None and best_peak >= INPUT_SILENT_RMS:
        log.info(
            "Auto-selected microphone [%d]: %s (probe rms=%.5f)",
            best_idx,
            sd.query_devices(best_idx)["name"],
            best_peak,
        )
        return best_idx

    if default is not None and default >= 0:
        log.warning("No active mic found; falling back to default [%d].", default)
        return default
    inputs = _input_devices()
    if not inputs:
        log.error("No input devices found.")
        raise SystemExit(1)
    idx, dev = inputs[0]
    log.warning("No active mic found; falling back to [%d] %s.", idx, dev["name"])
    return idx


def _elevenlabs_pcm_sample_rate(output_format: str) -> int:
    override = (os.environ.get("ELEVENLABS_PCM_SAMPLE_RATE") or "").strip()
    if override.isdigit():
        return int(override)
    if output_format.startswith("pcm_"):
        try:
            return int(output_format.split("_", maxsplit=1)[1])
        except (ValueError, IndexError):
            pass
    return 24000


def elevenlabs_env_config() -> tuple[str, str, str, int]:
    """voice_id, model_id, output_format, pcm_sample_rate."""
    voice = (os.environ.get("ELEVENLABS_VOICE_ID") or "").strip()
    model = (os.environ.get("ELEVENLABS_MODEL_ID") or "eleven_multilingual_v2").strip()
    fmt = (os.environ.get("ELEVENLABS_OUTPUT_FORMAT") or "pcm_24000").strip()
    rate = _elevenlabs_pcm_sample_rate(fmt)
    return voice, model, fmt, rate


def _jarvis_welcome_cache_dir() -> Path:
    base = Path(__file__).resolve().parent
    override = (os.environ.get("JARVIS_WELCOME_CACHE_DIR") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return base / ".cache" / "jarvis_welcome"


def _jarvis_welcome_cache_path(
    text: str, voice_id: str, model_id: str, output_format: str
) -> Path:
    key = f"{text}|{voice_id}|{model_id}|{output_format}".encode()
    digest = hashlib.sha256(key).hexdigest()[:24]
    return _jarvis_welcome_cache_dir() / f"{digest}.wav"


def _play_pcm_wav_file(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as wf:
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
            rate = wf.getframerate()
            if ch != 1 or sw != 2:
                log.warning("Unsupported cached WAV (channels=%s, width=%s).", ch, sw)
                return False
            raw = wf.readframes(wf.getnframes())
    except (OSError, wave.Error) as e:
        log.warning("Could not read cached welcome audio: %s", e)
        return False
    if not raw:
        return False
    pcm_i16 = np.frombuffer(raw, dtype=np.int16)
    pcm_f = pcm_i16.astype(np.float32) / 32768.0
    try:
        sd.play(pcm_f, rate)
        sd.wait()
    except Exception as e:
        log.warning("Could not play cached welcome audio: %s", e)
        return False
    return True


def _save_pcm_wav_file(path: Path, pcm_bytes: bytes, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with wave.open(str(tmp), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_bytes)
        tmp.replace(path)
    except OSError:
        if tmp.is_file():
            tmp.unlink(missing_ok=True)
        raise


def _elevenlabs_tts_bytes(text: str) -> bytes | None:
    """Convert text to raw PCM bytes via ElevenLabs (None on any failure)."""
    vid, model_id, output_format, _pcm_rate = elevenlabs_env_config()
    if not vid:
        log.warning("Set ELEVENLABS_VOICE_ID in the environment for ElevenLabs TTS.")
        return None
    api_key = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not api_key:
        log.warning("Set ELEVENLABS_API_KEY in the environment for ElevenLabs TTS.")
        return None
    try:
        from elevenlabs.client import ElevenLabs
    except ImportError:
        log.warning("Install dependencies: pip install -r requirements.txt")
        return None
    try:
        client = ElevenLabs(api_key=api_key)
        chunks = client.text_to_speech.convert(
            voice_id=vid,
            text=text,
            model_id=model_id,
            output_format=output_format,
        )
        raw = b"".join(chunks)
    except Exception as e:
        log.warning("ElevenLabs TTS failed: %s", e)
        return None
    if not raw:
        log.warning("ElevenLabs returned empty audio.")
        return None
    return raw


def speak(text: str) -> None:
    """Speak text out loud via ElevenLabs (blocks until playback finishes)."""
    text = (text or "").strip()
    if not text:
        return
    raw = _elevenlabs_tts_bytes(text)
    if not raw:
        return
    _vid, _model_id, _fmt, pcm_rate = elevenlabs_env_config()
    pcm_i16 = np.frombuffer(raw, dtype=np.int16)
    pcm_f = pcm_i16.astype(np.float32) / 32768.0
    try:
        sd.play(pcm_f, pcm_rate)
        sd.wait()
    except Exception as e:
        log.warning("Could not play ElevenLabs audio: %s", e)


def _jarvis_user_name() -> str:
    return (os.environ.get("JARVIS_USER_NAME") or JARVIS_USER_NAME_DEFAULT).strip()


# ---- Two-way voice conversation: Groq brain + local Whisper ears -----------

_whisper_model = None
_whisper_lock = threading.Lock()


def _get_whisper_model():
    """Load faster-whisper lazily (first call downloads the model)."""
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel

                name = (os.environ.get("WHISPER_MODEL") or WHISPER_MODEL_DEFAULT).strip()
                log.info("Loading Whisper model %r (first run downloads it)...", name)
                _whisper_model = WhisperModel(
                    name, device="cpu", compute_type="int8"
                )
    return _whisper_model


def _groq_client():
    api_key = (os.environ.get("GROQ_API_KEY") or "").strip()
    if not api_key:
        return None
    try:
        from groq import Groq
    except ImportError:
        log.warning("Install dependencies: pip install groq")
        return None
    return Groq(api_key=api_key)


def _groq_reply(client, messages: list[dict]) -> str:
    model = (os.environ.get("GROQ_MODEL") or GROQ_MODEL_DEFAULT).strip()
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.7,
            max_tokens=200,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.warning("Groq request failed: %s", e)
        return ""


# ---- Tools: things Jarvis can actually DO on the computer ------------------

def _open_in_browser(url: str, new_window: bool = False) -> None:
    """Open a URL in Comet (new tab in the current window), else default browser."""
    url = url.strip()
    if not url:
        return
    comet = _chrome_executable()
    try:
        if comet:
            args = [comet]
            if new_window:
                args.append("--new-window")
            args.append(url)
            kw: dict = {
                "args": args,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if sys.platform == "win32":
                kw["creationflags"] = subprocess.CREATE_NO_WINDOW
            subprocess.Popen(**kw)
        else:
            webbrowser.open(url)
    except OSError as e:
        log.warning("Could not open %s: %s", url, e)


def tool_search_youtube(query: str = "", **_) -> str:
    q = (query or "").strip()
    if not q:
        return "No search terms given."
    _open_in_browser("https://www.youtube.com/results?search_query=" + urllib.parse.quote(q))
    return f"Opened YouTube search for {q!r}."


def tool_web_search(query: str = "", **_) -> str:
    q = (query or "").strip()
    if not q:
        return "No search terms given."
    _open_in_browser("https://www.google.com/search?q=" + urllib.parse.quote(q))
    return f"Searched the web for {q!r}."


def tool_open_website(url: str = "", **_) -> str:
    u = (url or "").strip()
    if not u:
        return "No website given."
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    _open_in_browser(u)
    return f"Opened {u}."


def tool_add_calendar_event(
    title: str = "",
    start: str = "",
    duration_minutes: int = 60,
    details: str = "",
    **_,
) -> str:
    """Open Google Calendar's 'create event' page, pre-filled. User clicks Save."""
    title = (title or "").strip() or "New event"
    base = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    params = {"text": title}
    start = (start or "").strip()
    if start:
        try:
            dt = datetime.fromisoformat(start)
        except ValueError:
            return (
                "I couldn't read that date/time. Tell me a clear day and time, "
                "like 'tomorrow at 3pm'."
            )
        try:
            mins = int(duration_minutes)
        except (TypeError, ValueError):
            mins = 60
        end = dt + timedelta(minutes=max(5, mins))
        fmt = "%Y%m%dT%H%M%S"
        params["dates"] = f"{dt.strftime(fmt)}/{end.strftime(fmt)}"
    if (details or "").strip():
        params["details"] = details.strip()
    url = base + "&" + urllib.parse.urlencode(params)
    _open_in_browser(url)
    when = ""
    if start:
        try:
            when = " for " + datetime.fromisoformat(start).strftime("%a %d %b, %I:%M %p")
        except ValueError:
            when = ""
    return f"Opened a pre-filled calendar event {title!r}{when}. Hit Save to confirm."


TOOL_IMPLS = {
    "search_youtube": tool_search_youtube,
    "web_search": tool_web_search,
    "open_website": tool_open_website,
    "add_calendar_event": tool_add_calendar_event,
}

TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "search_youtube",
            "description": "Open a YouTube search for the user (use for 'search/play/find ... on YouTube').",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for on YouTube."}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web (Google) for the user.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The web search query."}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_website",
            "description": "Open a specific website / URL in the browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The site or URL to open, e.g. github.com."}
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_calendar_event",
            "description": (
                "Create a Google Calendar event (opens it pre-filled for the user to save). "
                "Resolve relative dates like 'tomorrow' or 'next Monday' yourself using the "
                "current date/time given to you."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Event title."},
                    "start": {
                        "type": "string",
                        "description": "Start datetime in ISO 8601 local time, e.g. 2026-06-23T15:00:00.",
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": "Event length in minutes (default 60).",
                    },
                    "details": {"type": "string", "description": "Optional notes/description."},
                },
                "required": ["title", "start"],
            },
        },
    },
]


def _run_tool_call(tc) -> str:
    name = tc.function.name
    try:
        args = json.loads(tc.function.arguments or "{}")
    except (ValueError, TypeError):
        args = {}
    impl = TOOL_IMPLS.get(name)
    if impl is None:
        return f"Unknown tool {name}."
    try:
        result = impl(**args)
        log.info("Action: %s(%s) -> %s", name, args, result)
        return result
    except Exception as e:
        log.warning("Tool %s failed: %s", name, e)
        return f"That action failed: {e}"


def _recover_tool_from_error(e) -> tuple[str, dict] | None:
    """Llama sometimes emits a malformed tool call that Groq rejects with a 400
    ('tool_use_failed'). Parse the raw text out of that error so the action still runs."""
    body = getattr(e, "body", None)
    fg = ""
    if isinstance(body, dict):
        fg = ((body.get("error") or {}).get("failed_generation")) or ""
    if not fg:
        return None
    m = re.search(r"<function=([A-Za-z_]\w*)\s*(\{.*\})", fg, re.S)
    if not m:
        m = re.search(r"\"?name\"?\s*[:=]\s*\"?([A-Za-z_]\w*)\"?.*?(\{.*\})", fg, re.S)
    if not m:
        return None
    name = m.group(1)
    blob = m.group(2)
    for candidate in (blob, blob[: blob.rfind("}") + 1]):
        try:
            return name, json.loads(candidate)
        except (ValueError, TypeError):
            continue
    return None


def _groq_chat_turn(client, messages: list[dict]) -> str:
    """One assistant turn with tool use: may call tools, then returns spoken text."""
    model = (os.environ.get("GROQ_MODEL") or GROQ_MODEL_DEFAULT).strip()
    for _ in range(4):  # allow a few tool rounds per turn
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOLS_SCHEMA,
                tool_choice="auto",
                temperature=0.6,
                max_tokens=300,
            )
        except Exception as e:
            rec = _recover_tool_from_error(e)
            if rec:
                name, args = rec
                impl = TOOL_IMPLS.get(name)
                result = impl(**args) if impl else f"Unknown tool {name}."
                log.info("Action (recovered): %s(%s) -> %s", name, args, result)
                return result  # result strings are already speakable confirmations
            log.warning("Groq request failed: %s", e)
            return ""
        msg = resp.choices[0].message
        tool_calls = getattr(msg, "tool_calls", None)
        if not tool_calls:
            return (msg.content or "").strip()
        # Record the assistant's tool request, then run each tool and feed results back.
        messages.append(
            {
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in tool_calls
                ],
            }
        )
        for tc in tool_calls:
            result = _run_tool_call(tc)
            messages.append(
                {"role": "tool", "tool_call_id": tc.id, "name": tc.function.name, "content": result}
            )
    # Fell through after several tool rounds; ask the model to wrap up in words.
    return _groq_reply(client, messages) or "Done."


def generate_casual_intro() -> str:
    """A fresh, casual greeting each time (no canned line, no assumptions)."""
    client = _groq_client()
    if client is None:
        return random.choice(CASUAL_INTRO_FALLBACKS)
    name = _jarvis_user_name()
    messages = [
        {"role": "system", "content": JARVIS_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Greet me casually in one short spoken sentence as I sit down at my "
                f"desk. Address me as '{name}'. Vary it every time. Do NOT assume "
                f"anything specific about my day, mood, clients, deals, or projects."
            ),
        },
    ]
    return _groq_reply(client, messages) or random.choice(CASUAL_INTRO_FALLBACKS)


def _beep(freq: float = 880.0, secs: float = 0.12, vol: float = 0.25) -> None:
    """Short tone so you know it's your turn to talk."""
    try:
        t = np.linspace(0, secs, int(24000 * secs), endpoint=False)
        tone = (vol * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        sd.play(tone, 24000)
        sd.wait()
    except Exception:
        pass


def _flush_stream(stream, blocksize: int) -> None:
    """Discard buffered audio (e.g. our own TTS tail) so it isn't transcribed."""
    try:
        avail = stream.read_available
        while avail and avail >= blocksize:
            stream.read(blocksize)
            avail = stream.read_available
    except Exception:
        pass


def _record_utterance(stream, blocksize: int) -> np.ndarray | None:
    """Read one spoken turn from the already-open mic stream (None if silence).

    Self-calibrates to the room each turn and requires *sustained* sound to start,
    so a noisy mic's ambient spikes don't false-trigger or get sent as a 'turn'.
    """
    from collections import deque

    _flush_stream(stream, blocksize)
    block_dt = blocksize / SAMPLE_RATE

    # Calibrate ambient noise (~0.5s) with robust high estimate, then set a
    # threshold comfortably above the room so speech stands out.
    cal: list[float] = []
    for _ in range(max(4, int(0.5 / block_dt))):
        d, _o = stream.read(blocksize)
        cal.append(rms_mono(d))
    cal.sort()
    amb_med = cal[len(cal) // 2]
    amb_hi = cal[-1]
    speech_th = max(amb_med * 4.0, amb_hi * 1.4, CHAT_SPEECH_RMS)
    log.info(
        "Listening... (ambient med=%.4f hi=%.4f, speak above %.4f)",
        amb_med, amb_hi, speech_th,
    )

    preroll: deque = deque(maxlen=max(1, int(0.3 / block_dt)))
    frames: list[np.ndarray] = []
    above = 0
    started = False
    waited = 0.0
    silence = 0.0
    peak = 0.0
    while True:
        d, _o = stream.read(blocksize)
        lvl = rms_mono(d)
        peak = max(peak, lvl)
        if not started:
            preroll.append(d.copy())
            if lvl >= speech_th:
                above += 1
                if above >= CHAT_START_BLOCKS:  # sustained -> real speech
                    started = True
                    frames.extend(preroll)
            else:
                above = 0
                waited += block_dt
                if waited >= CHAT_SPEECH_START_TIMEOUT_S:
                    return None
        else:
            frames.append(d.copy())
            if lvl < speech_th:
                silence += block_dt
                if silence >= CHAT_END_SILENCE_S:
                    break
            else:
                silence = 0.0
            if len(frames) * block_dt >= CHAT_MAX_UTTERANCE_S:
                break

    dur = len(frames) * block_dt
    if dur < CHAT_MIN_UTTERANCE_S:
        return None
    log.info("Heard %.1fs (peak rms=%.4f).", dur, peak)
    return np.concatenate(frames, axis=0).reshape(-1).astype(np.float32)


def _transcribe(audio_44k: np.ndarray | None) -> str:
    if audio_44k is None or audio_44k.size == 0:
        return ""
    # faster-whisper wants 16 kHz mono float32; resample from our 44.1 kHz capture.
    target = 16000
    n_out = int(round(audio_44k.size * target / SAMPLE_RATE))
    if n_out <= 0:
        return ""
    x_old = np.linspace(0.0, 1.0, num=audio_44k.size, endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    audio_16k = np.interp(x_new, x_old, audio_44k).astype(np.float32)
    try:
        model = _get_whisper_model()
        segments, _info = model.transcribe(
            audio_16k,
            language="en",
            beam_size=5,                     # more accurate than greedy
            vad_filter=True,
            temperature=0.0,
            condition_on_previous_text=False,  # stops it parroting earlier turns
            no_speech_threshold=0.6,
        )
        kept = []
        for seg in segments:
            # Drop low-confidence / non-speech segments (Whisper's noise hallucinations).
            if getattr(seg, "no_speech_prob", 0.0) > 0.6:
                continue
            if getattr(seg, "avg_logprob", 0.0) < -1.0:
                continue
            kept.append(seg.text)
        text = " ".join(kept).strip()
        # Common whisper hallucinations on near-silence.
        if text.lower().strip(" .!?") in _STT_JUNK:
            return ""
        return text
    except Exception as e:
        log.warning("Speech-to-text failed: %s", e)
        return ""


def voice_conversation(stream, blocksize: int) -> None:
    """Speak a casual intro, then chat back and forth using the open mic stream."""
    if not VOICE_CHAT_ENABLED:
        return
    # Let the apps/song get going first, then greet.
    delay = max(0.0, JARVIS_AFTER_SONG_DELAY_S)
    if delay:
        time.sleep(delay)

    intro = generate_casual_intro()
    log.info("Jarvis: %s", intro)
    speak(intro)

    client = _groq_client()
    if client is None:
        log.warning(
            "No GROQ_API_KEY in .env - intro only, no two-way chat. "
            "Add a free key from https://console.groq.com to enable conversation."
        )
        return
    try:
        _get_whisper_model()  # warm up so the first turn isn't slow
    except Exception as e:
        log.warning("Could not load Whisper (pip install faster-whisper): %s", e)
        return

    name = _jarvis_user_name()
    now_str = datetime.now().strftime("%A %d %B %Y, %I:%M %p")
    system = (
        f"{JARVIS_SYSTEM_PROMPT} You are speaking with {name}. "
        f"The current date and time is {now_str} (the user's local time); "
        f"use it to resolve relative dates like 'tomorrow' or 'next Monday'."
    )
    messages = [{"role": "system", "content": system}]
    log.info("Conversation started - just talk; say 'goodbye' to end.")
    misses = 0
    while True:
        _flush_stream(stream, blocksize)
        _beep()  # audible 'your turn' cue
        audio = _record_utterance(stream, blocksize)
        if audio is None:
            misses += 1
            if misses >= 2:
                speak("I'll be around if you need me.")
                log.info("Conversation ended (silence).")
                return
            continue
        misses = 0
        user_text = _transcribe(audio)
        if not user_text:
            log.info("(heard sound but no words - try again)")
            continue
        log.info("You: %s", user_text)
        low = user_text.lower().strip(" .,!?")
        if any(p in low for p in CHAT_END_PHRASES):
            speak(f"Right then. Talk soon, {name}.")
            log.info("Conversation ended (goodbye).")
            return
        messages.append({"role": "user", "content": user_text})
        reply = _groq_chat_turn(client, messages)  # may run actions (tools)
        if not reply:
            speak("Sorry, my brain hiccuped there. Say that again?")
            continue
        messages.append({"role": "assistant", "content": reply})
        if len(messages) > 25:  # keep history bounded
            messages = [messages[0]] + messages[-24:]
        log.info("Jarvis: %s", reply)
        speak(reply)


def play_song(uri: str) -> None:
    u = uri.strip()
    if not u:
        return
    try:
        if sys.platform == "win32":
            os.startfile(u)
        else:
            webbrowser.open(u)
    except OSError as e:
        log.warning("Could not open SONG_URI: %s", e)


def _chrome_executable() -> str | None:
    if sys.platform == "win32":
        for base in (
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            os.environ.get("LOCALAPPDATA", ""),
        ):
            if not base:
                continue
            p = os.path.join(base, "Perplexity", "Comet", "Application", "comet.exe")
            if os.path.isfile(p):
                return p
    return shutil.which("comet")


def _win32_sorted_monitor_rects() -> list[tuple[int, int, int, int]]:
    """Each monitor as (left, top, right, bottom), sorted left-to-right then top-to-bottom."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", wintypes.LONG),
            ("top", wintypes.LONG),
            ("right", wintypes.LONG),
            ("bottom", wintypes.LONG),
        ]

    collected: list[tuple[int, int, int, int]] = []

    @ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HMONITOR,
        wintypes.HDC,
        ctypes.POINTER(RECT),
        wintypes.LPARAM,
    )
    def _cb(_hm, _hdc, lprc, _lp):
        r = lprc.contents
        collected.append((int(r.left), int(r.top), int(r.right), int(r.bottom)))
        return True

    ctypes.windll.user32.EnumDisplayMonitors(None, None, _cb, 0)
    collected.sort(key=lambda t: (t[0], t[1]))
    return collected


def _chrome_monitor_top_left(one_based_index: int) -> tuple[int, int]:
    """Top-left corner on virtual desktop for monitor N (1-based)."""
    l, t, _, _ = _chrome_monitor_bounds(one_based_index)
    return (l, t)


def _chrome_monitor_bounds(one_based_index: int) -> tuple[int, int, int, int]:
    """Monitor N as (left, top, right, bottom), 1-based index (sorted like other Chrome helpers)."""
    rects = _win32_sorted_monitor_rects()
    if not rects:
        return (0, 0, 1920, 1080)
    idx = one_based_index - 1
    if idx < 0:
        idx = 0
    if idx >= len(rects):
        log.warning(
            "Monitor %d requested but only %d found; using last monitor.",
            one_based_index,
            len(rects),
        )
        idx = len(rects) - 1
    return rects[idx]


def _chrome_monitor_pixel_size(one_based_index: int) -> tuple[int, int]:
    l, t, r, b = _chrome_monitor_bounds(one_based_index)
    return (max(320, r - l), max(240, b - t))


def _chrome_window_size() -> tuple[int, int]:
    w = (os.environ.get("CHROME_WINDOW_WIDTH") or "1400").strip()
    h = (os.environ.get("CHROME_WINDOW_HEIGHT") or "900").strip()
    try:
        return (max(400, int(w)), max(300, int(h)))
    except ValueError:
        return (1400, 900)


def _chrome_site_user_data_dir(site_key: str) -> str:
    p = Path(tempfile.gettempdir()) / "clap-trigger-chrome" / site_key
    p.mkdir(parents=True, exist_ok=True)
    return str(p)


def _chrome_new_window_wait_timeout_s() -> float:
    try:
        return max(3.0, float((os.environ.get("CHROME_NEW_WINDOW_WAIT_S") or "25").strip()))
    except ValueError:
        return 25.0


def _chrome_top_level_browser_hwnds_win32() -> set[int]:
    """HWND ints for visible-or-minimized top-level Chrome browser windows."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    found: set[int] = set()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd: wintypes.HWND, _lp: wintypes.LPARAM) -> bool:
        if user32.GetWindow(hwnd, GW_OWNER):
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        if not user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return True
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not hproc:
            return True
        try:
            buf = ctypes.create_unicode_buffer(4096)
            sz = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(hproc, 0, buf, ctypes.byref(sz)):
                return True
            exe_path = buf.value
        finally:
            kernel32.CloseHandle(hproc)
        if os.path.basename(exe_path).lower() != "comet.exe":
            return True
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 80 or h < 80:
            return True
        found.add(int(hwnd))
        return True

    user32.EnumWindows(_enum, 0)
    return found


def _wait_new_chrome_hwnd_win32(before: set[int], timeout: float) -> int | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.12)
        now = _chrome_top_level_browser_hwnds_win32()
        new = now - before
        if not new:
            continue
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        best: int | None = None
        best_area = 0
        for h in new:
            r = wintypes.RECT()
            if user32.GetWindowRect(h, ctypes.byref(r)):
                a = max(0, r.right - r.left) * max(0, r.bottom - r.top)
                if a > best_area:
                    best_area = a
                    best = h
        if best is not None:
            return best
    return None


def _chrome_snap_window_to_monitor_win32(
    hwnd: int,
    one_based_monitor: int,
    *,
    fullscreen: bool,
    windowed_size: tuple[int, int] | None,
) -> None:
    import ctypes
    from ctypes import wintypes

    ml, mt, mr, mb = _chrome_monitor_bounds(one_based_monitor)
    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    SW_SHOWMAXIMIZED = 3
    HWND_TOP = 0
    SWP_SHOWWINDOW = 0x0040
    SWP_FRAMECHANGED = 0x0020
    flags = SWP_SHOWWINDOW | SWP_FRAMECHANGED

    user32.ShowWindow(hwnd, SW_RESTORE)
    if fullscreen:
        w, h = mr - ml, mb - mt
        x, y = ml, mt
    else:
        ww, wh = windowed_size or _chrome_window_size()
        w, h = ww, wh
        x = ml + max(0, (mr - ml - w) // 2)
        y = mt + max(0, (mb - mt - h) // 2)
    user32.SetWindowPos(hwnd, HWND_TOP, x, y, w, h, flags)

    if fullscreen:
        user32.ShowWindow(hwnd, SW_SHOWMAXIMIZED)
        KEYEVENTF_KEYUP = 0x0002
        VK_F11 = 0x7A
        fg = user32.GetForegroundWindow()
        tid_tgt = user32.GetWindowThreadProcessId(hwnd, None)
        tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        if tid_fg and tid_tgt:
            user32.AttachThreadInput(tid_fg, tid_tgt, True)
        user32.SetForegroundWindow(hwnd)
        if tid_fg and tid_tgt:
            user32.AttachThreadInput(tid_fg, tid_tgt, False)
        user32.keybd_event(VK_F11, 0, 0, 0)
        user32.keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, 0)


def _open_url_in_chrome(
    url: str,
    *,
    new_window: bool = True,
    label: str = "URL",
    window_position: tuple[int, int] | None = None,
    window_size: tuple[int, int] | None = None,
    fullscreen: bool = False,
    win32_post_fullscreen_monitor: int | None = None,
    user_data_dir: str | None = None,
    extra_urls: list[str] | None = None,
) -> None:
    u = url.strip()
    if not u:
        return
    extra = [e.strip() for e in (extra_urls or []) if e and e.strip()]
    chrome = _chrome_executable()
    try:
        if chrome:
            args = [chrome]
            if user_data_dir:
                args.append(f"--user-data-dir={user_data_dir}")
                args.append("--no-first-run")
            if new_window:
                args.append("--new-window")
            if window_position is not None:
                x, y = window_position
                args.append(f"--window-position={x},{y}")
            if window_size:
                args.append(f"--window-size={window_size[0]},{window_size[1]}")
            if fullscreen and not (
                sys.platform == "win32" and win32_post_fullscreen_monitor is not None
            ):
                args.append("--start-fullscreen")
            args.append(u)
            args.extend(extra)
            popen_kw: dict = {
                "args": args,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if sys.platform == "win32":
                popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
            before: set[int] | None = None
            if sys.platform == "win32" and win32_post_fullscreen_monitor is not None:
                before = _chrome_top_level_browser_hwnds_win32()
            subprocess.Popen(**popen_kw)
            if sys.platform == "win32" and win32_post_fullscreen_monitor is not None:
                mon = win32_post_fullscreen_monitor
                hwnd = _wait_new_chrome_hwnd_win32(before, _chrome_new_window_wait_timeout_s())
                if hwnd is not None:
                    _chrome_snap_window_to_monitor_win32(
                        hwnd,
                        mon,
                        fullscreen=fullscreen,
                        windowed_size=window_size if not fullscreen else None,
                    )
                else:
                    log.warning(
                        "Chrome: timed out waiting for new window (%s); check "
                        "CHROME_NEW_WINDOW_WAIT_S or close extra Chrome instances.",
                        label,
                    )
        else:
            log.warning("Comet not found; opening %s in default browser.", label)
            webbrowser.open(u)
            for e in extra:
                webbrowser.open_new_tab(e)
    except OSError as e:
        log.warning("Could not open %s in Comet: %s", label, e)


def open_claude_desktop() -> None:
    if not OPEN_CLAUDE_DESKTOP_APP:
        return
    if sys.platform != "win32":
        log.warning("Claude desktop launch is only wired up for Windows.")
        return
    # Packaged (Store/MSIX) app; launch by AppUserModelID via the shell apps folder.
    aumid = (
        os.environ.get("CLAUDE_DESKTOP_AUMID") or "Claude_pzs8sxrjxfjjc!Claude"
    ).strip()
    try:
        subprocess.Popen(
            ["explorer.exe", f"shell:AppsFolder\\{aumid}"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except OSError as e:
        log.warning("Could not launch Claude desktop app: %s", e)


def open_gmail_youtube_in_comet() -> None:
    if not OPEN_GMAIL_YOUTUBE_IN_COMET:
        return
    gmail = (
        os.environ.get("GMAIL_URL")
        or "https://mail.google.com/mail/u/0/#inbox"
    ).strip()
    youtube = (os.environ.get("YOUTUBE_URL") or "https://www.youtube.com").strip()
    pos: tuple[int, int] | None = None
    size: tuple[int, int] | None = None
    fs = OPEN_CHROME_FULLSCREEN
    post_mon: int | None = None
    user_data: str | None = None
    if sys.platform == "win32":
        post_mon = COMET_WINDOW_MONITOR
        pos = _chrome_monitor_top_left(COMET_WINDOW_MONITOR)
        if fs:
            size = _chrome_monitor_pixel_size(COMET_WINDOW_MONITOR)
        else:
            size = _chrome_window_size()
        if CHROME_SEPARATE_SITE_PROFILES:
            user_data = _chrome_site_user_data_dir("comet")
    elif not fs:
        size = _chrome_window_size()
    else:
        size = None
    # One new window; Gmail is the first tab, YouTube the second.
    _open_url_in_chrome(
        gmail,
        new_window=True,
        label="Gmail + YouTube",
        window_position=pos,
        window_size=size,
        fullscreen=fs,
        win32_post_fullscreen_monitor=post_mon,
        user_data_dir=user_data,
        extra_urls=[youtube],
    )


def _cursor_executable() -> str | None:
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        for sub in ("Programs\\cursor\\Cursor.exe", "Programs\\Cursor\\Cursor.exe"):
            if local:
                p = os.path.join(local, *sub.split("\\"))
                if os.path.isfile(p):
                    return p
    return shutil.which("cursor")


def _cursor_largest_main_hwnd_win32() -> int | None:
    """Largest top-level Cursor.exe window (visible or minimized)."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    candidates: list[tuple[int, wintypes.HWND]] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd: wintypes.HWND, _lp: wintypes.LPARAM) -> bool:
        if user32.GetWindow(hwnd, GW_OWNER):
            return True
        if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        if not user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == 0:
            return True
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not hproc:
            return True
        try:
            buf = ctypes.create_unicode_buffer(4096)
            sz = wintypes.DWORD(len(buf))
            if not kernel32.QueryFullProcessImageNameW(hproc, 0, buf, ctypes.byref(sz)):
                return True
            exe_path = buf.value
        finally:
            kernel32.CloseHandle(hproc)
        if os.path.basename(exe_path).lower() != "cursor.exe":
            return True
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 200 or h < 200:
            return True
        candidates.append((w * h, hwnd))
        return True

    user32.EnumWindows(_enum, 0)
    if not candidates:
        return None
    return int(max(candidates, key=lambda t: t[0])[1])


def _cursor_foreground_hwnd_win32(hwnd: int) -> None:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    SW_RESTORE = 9
    user32.ShowWindow(hwnd, SW_RESTORE)
    fg = user32.GetForegroundWindow()
    tid_tgt = user32.GetWindowThreadProcessId(hwnd, None)
    tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    if tid_fg and tid_tgt:
        user32.AttachThreadInput(tid_fg, tid_tgt, True)
    user32.SetForegroundWindow(hwnd)
    if tid_fg and tid_tgt:
        user32.AttachThreadInput(tid_fg, tid_tgt, False)


def _cursor_send_f11_fullscreen_win32(hwnd: int) -> None:
    """F11 toggles Zen/fullscreen in Cursor (Electron)."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    VK_F11 = 0x7A
    _cursor_foreground_hwnd_win32(hwnd)
    user32.keybd_event(VK_F11, 0, 0, 0)
    user32.keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, 0)


def _focus_existing_cursor_window_win32() -> bool:
    """Bring an existing Cursor.exe main window to the foreground (no new process)."""
    if sys.platform != "win32":
        return False
    hwnd = _cursor_largest_main_hwnd_win32()
    if hwnd is None:
        return False
    _cursor_foreground_hwnd_win32(hwnd)
    return True


def run_double_clap_actions() -> None:
    """Open the usual apps/tabs. Runs in a background thread so it never stalls
    the mic (the spoken intro + chat happen on the main thread)."""
    play_song(SONG_URI)
    open_claude_desktop()
    open_gmail_youtube_in_comet()
    open_cursor_window()


def open_cursor_window() -> None:
    if not FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP and not OPEN_NEW_CURSOR_ON_DOUBLE_CLAP:
        return
    exe = _cursor_executable()
    if not exe:
        log.warning(
            "Could not find Cursor (install app or add the `cursor` command to PATH)."
        )
        return
    popen_kw: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        popen_kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        if FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP:
            focused = (
                sys.platform == "win32" and _focus_existing_cursor_window_win32()
            )
            if not focused:
                subprocess.Popen([exe], **popen_kw)
        if OPEN_NEW_CURSOR_ON_DOUBLE_CLAP:
            subprocess.Popen([exe, "-n"], **popen_kw)
    except OSError as e:
        log.warning("Could not start or focus Cursor: %s", e)
        return
    if sys.platform == "win32" and CURSOR_OPEN_FULLSCREEN:
        time.sleep(0.5)
        hwnd = _cursor_largest_main_hwnd_win32()
        if hwnd is not None:
            _cursor_send_f11_fullscreen_win32(hwnd)
        else:
            log.warning("Cursor fullscreen: no Cursor window found to send F11.")


def main() -> int:
    blocksize = block_samples()
    noise_floor = 1e-4
    last_logged_double = 0.0
    first_clap_time: float | None = None
    spike_armed = True
    apps_opened = False

    log.info(
        "Listening (double clap: %.2f–%.2fs apart, rate=%d, block=%d ms, "
        "spike_ratio=%.1f, cooldown=%.2fs). Ctrl+C to stop.",
        MIN_DOUBLE_GAP_S,
        MAX_DOUBLE_GAP_S,
        SAMPLE_RATE,
        BLOCK_MS,
        SPIKE_RATIO,
        COOLDOWN_S,
    )
    if SONG_URI.strip():
        log.info("Double clap opens this track: %s", SONG_URI.strip())
    else:
        log.info("SONG_URI is empty — set it to play one song on each double clap.")
    if FOCUS_EXISTING_CURSOR_ON_DOUBLE_CLAP:
        log.info(
            "Double clap will foreground an existing Cursor window (Windows API); "
            "falls back to launching Cursor if none is running."
        )
    if OPEN_NEW_CURSOR_ON_DOUBLE_CLAP:
        log.info("Double clap will also open a new Cursor window (-n).")
    if CURSOR_OPEN_FULLSCREEN and sys.platform == "win32":
        log.info("Cursor will be sent F11 for fullscreen after focus/launch.")
    if OPEN_CLAUDE_DESKTOP_APP:
        log.info("After Spotify, launch the Claude desktop app.")
    if OPEN_GMAIL_YOUTUBE_IN_COMET:
        gu = (
            os.environ.get("GMAIL_URL")
            or "https://mail.google.com/mail/u/0/#inbox"
        ).strip()
        yu = (os.environ.get("YOUTUBE_URL") or "https://www.youtube.com").strip()
        log.info(
            "After Spotify, open a new Comet window%s on monitor %d with tabs: %s | %s",
            " fullscreen" if OPEN_CHROME_FULLSCREEN else "",
            COMET_WINDOW_MONITOR,
            gu,
            yu,
        )
    if VOICE_CHAT_ENABLED:
        ev, em, ef, er = elevenlabs_env_config()
        has_groq = bool((os.environ.get("GROQ_API_KEY") or "").strip())
        log.info(
            "Voice chat ON: casual intro then two-way conversation "
            "(ElevenLabs voice=%s, Groq model=%s, Whisper=%s).",
            ev or "(unset)",
            (os.environ.get("GROQ_MODEL") or GROQ_MODEL_DEFAULT).strip(),
            (os.environ.get("WHISPER_MODEL") or WHISPER_MODEL_DEFAULT).strip(),
        )
        if not has_groq:
            log.warning(
                "GROQ_API_KEY not set in .env — you'll get the spoken intro but no "
                "two-way chat. Add a free key from https://console.groq.com."
            )

    input_idx = _choose_input_device(blocksize)

    try:
        with sd.InputStream(
            device=input_idx,
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=blocksize,
        ) as stream:
            while True:
                data, overflowed = stream.read(blocksize)
                if overflowed:
                    log.warning("Input overflow; try a larger BLOCK_MS")

                level = rms_mono(data)

                quiet_gate = noise_floor * QUIET_GATE_MULT
                if level < quiet_gate:
                    noise_floor = NOISE_FLOOR_ALPHA * noise_floor + (
                        1.0 - NOISE_FLOOR_ALPHA
                    ) * level
                    noise_floor = max(noise_floor, 1e-7)

                threshold = max(noise_floor * SPIKE_RATIO, MIN_RMS)
                now = time.monotonic()
                retrigger_level = threshold * RETRIGGER_RATIO

                if level < retrigger_level:
                    spike_armed = True

                if (
                    spike_armed
                    and level >= threshold
                    and (now - last_logged_double) >= COOLDOWN_S
                ):
                    spike_armed = False
                    if first_clap_time is None:
                        first_clap_time = now
                    else:
                        gap = now - first_clap_time
                        if gap < MIN_DOUBLE_GAP_S:
                            pass
                        elif gap <= MAX_DOUBLE_GAP_S:
                            first_clap_time = None
                            last_logged_double = now
                            log.info(
                                "Double clap detected (gap=%.3fs, rms=%.5f, "
                                "noise_floor=%.5f, threshold=%.5f)",
                                gap,
                                level,
                                noise_floor,
                                threshold,
                            )
                            # Open the apps/tabs once per run, in the background.
                            if not apps_opened:
                                apps_opened = True
                                threading.Thread(
                                    target=run_double_clap_actions, daemon=True
                                ).start()
                            # Run the intro + chat inline so it reuses THIS mic stream
                            # (avoids a second InputStream fighting for the device).
                            if VOICE_CHAT_ENABLED:
                                try:
                                    voice_conversation(stream, blocksize)
                                except Exception as e:
                                    log.warning("Voice chat error: %s", e)
                                # Reset detector so claps register cleanly afterward.
                                noise_floor = 1e-4
                                spike_armed = True
                                first_clap_time = None
                                last_logged_double = time.monotonic()
                        else:
                            first_clap_time = now

    except KeyboardInterrupt:
        log.info("Stopped.")
        return 0
    except sd.PortAudioError as e:
        log.error("Audio error: %s", e)
        log.error("If PortAudio fails, install/repair drivers or try another SAMPLE_RATE.")
        return 1

    return 0


def voice_test() -> int:
    """Skip clap detection: open the mic and start a conversation immediately.
    Run with:  python jarvis.py --voicetest"""
    blocksize = block_samples()
    input_idx = _choose_input_device(blocksize)
    log.info("Voice test: starting a conversation now (Ctrl+C to stop).")
    try:
        with sd.InputStream(
            device=input_idx,
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=blocksize,
        ) as stream:
            voice_conversation(stream, blocksize)
    except KeyboardInterrupt:
        log.info("Stopped.")
    except sd.PortAudioError as e:
        log.error("Audio error: %s", e)
        return 1
    return 0


if __name__ == "__main__":
    if "--voicetest" in sys.argv:
        sys.exit(voice_test())
    sys.exit(main())
