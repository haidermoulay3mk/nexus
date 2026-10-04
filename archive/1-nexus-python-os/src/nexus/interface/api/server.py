"""Nexus local dashboard.

A single-page "Today" view plus a small JSON API. FastAPI is imported lazily
inside ``create_app`` so the rest of Nexus runs without the web extra.

    nexus dashboard            # then open http://127.0.0.1:8765
"""

from __future__ import annotations

import html
import importlib.util
import logging
import threading
from functools import lru_cache

# Only one capture may use the microphone at a time (wake loop vs conversation).
_MIC_LOCK = threading.Lock()


def _ask_error_message(exc: Exception) -> str:
    """Turn a model/agent error into a friendly, actionable reply."""
    text = str(exc)
    if "429" in text or "rate" in text.lower() or "quota" in text.lower():
        return ("Gemini is rate-limiting me right now (free-tier limit). Wait a minute and "
                "try again — or start Ollama and I'll use the local model as backup.")
    return "Sorry, I ran into an error answering that. Please try again."


def _model_unready_message(nexus) -> str:
    if nexus.router.provider == "gemini":
        return "Add a free Gemini key in Settings, or start Ollama, so I can reason."
    return "Ollama isn't running. Start it, or add a free Gemini key in Settings."


def _module_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _voice_status(nexus) -> dict:
    cfg = nexus.config.voice
    missing = []
    if not _module_available("sounddevice"):
        missing.append("sounddevice")
    if not _module_available("numpy"):
        missing.append("numpy")
    if not (
        _module_available("speech_recognition")
        or _module_available("faster_whisper")
        or nexus.router.provider == "gemini"
    ):
        missing.append("speech_recognition or faster-whisper")
    return {
        "enabled": cfg.enabled,
        "ready": cfg.enabled and not missing,
        "missing": missing,
        "wake_enabled": cfg.wake_enabled,
        "wake_phrases": cfg.wake_phrases,
        "hotkey": cfg.hotkey,
        "stt_model": cfg.stt_model,
        "persona": cfg.persona,
        "model_ready": nexus.router.is_ready(),
        "provider": nexus.router.provider,
    }


@lru_cache(maxsize=1)
def _icon_png_bytes() -> bytes | None:
    """The PNG app icon (assets/nexus.png), if present."""
    from nexus.kernel import paths

    png = paths.package_root() / "assets" / "nexus.png"
    try:
        return png.read_bytes()
    except OSError:
        return None


def create_app(nexus_app=None):
    from fastapi import Body, FastAPI
    from fastapi.responses import HTMLResponse, Response

    from nexus.app import NexusApp

    nexus = nexus_app or NexusApp()
    api = FastAPI(title="Nexus", docs_url="/api/docs")

    from nexus.interface.api._render import LOGO_SVG, render_home

    @api.get("/", response_class=HTMLResponse)
    def home() -> str:
        return render_home(nexus)

    @api.get("/favicon.svg")
    def favicon() -> Response:
        return Response(content=LOGO_SVG, media_type="image/svg+xml")

    @api.get("/icon.png")
    def icon_png() -> Response:
        data = _icon_png_bytes()
        if data is None:
            return Response(status_code=404)
        return Response(content=data, media_type="image/png")

    @api.get("/manifest.webmanifest")
    def manifest() -> Response:
        import json

        body = json.dumps({
            "name": "Nexus",
            "short_name": "Nexus",
            "description": "Personal AI operating system",
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "background_color": "#0f1115",
            "theme_color": "#0f1115",
            "icons": [
                {"src": "/icon.png", "sizes": "256x256", "type": "image/png",
                 "purpose": "any maskable"},
            ],
        })
        return Response(content=body, media_type="application/manifest+json")

    @api.get("/api/health")
    def health() -> dict:
        return nexus.doctor()

    @api.get("/api/study/progress")
    def study_progress() -> dict:
        return nexus.study.progress(None)

    @api.get("/api/study/weak")
    def study_weak() -> list[dict]:
        return [
            {"subject": r["subject"], "topic": r["name"], "confidence": r["confidence"]}
            for r in nexus.study.weak_topics()
        ]

    @api.get("/api/today")
    def today() -> dict:
        from nexus.connectors.simple_accounts import list_calendars, list_email_accounts

        return {
            "weak": len(nexus.study.weak_topics()),
            "open_tasks": len(nexus.productivity.list_tasks("open")),
            "emails": len(list_email_accounts()),
            "calendars": len(list_calendars()),
            "provider": nexus.router.provider,
            "ready": nexus.router.is_ready(),
        }

    def _capture_transcript() -> tuple[bool, str, str]:
        """Record one utterance (Python mic) and transcribe it.

        Returns (available, spoke, transcript). ``available`` is False only when
        the mic/voice stack is missing."""
        from nexus.speech.runtime import record_segment, transcribe_wav

        if not _MIC_LOCK.acquire(blocking=False):
            return (True, False, "")        # another capture is in progress
        try:
            wav = record_segment()
        except Exception:  # noqa: BLE001 - missing libs OR no input device
            return (False, False, "")
        finally:
            _MIC_LOCK.release()
        if wav is None:
            return (True, False, "")        # silence
        try:
            return (True, True, transcribe_wav(nexus, wav))
        except Exception:  # noqa: BLE001
            return (True, True, "")

    @api.post("/api/voice/transcribe")
    def voice_transcribe() -> dict:
        """Listen + transcribe only (used by the hands-free wake loop)."""
        if not nexus.config.voice.enabled:
            return {"ok": False, "error": "Voice is disabled in Nexus settings."}
        available, spoke, text = _capture_transcript()
        if not available:
            return {"ok": False, "error": "Microphone unavailable."}
        return {"ok": True, "spoke": spoke, "transcript": text}

    @api.post("/api/voice/listen")
    def voice_listen() -> dict:
        """Listen + transcribe + route to an agent. The UI speaks the reply."""
        if not nexus.config.voice.enabled:
            return {"ok": False, "error": "Voice is disabled in Nexus settings."}
        available, spoke, text = _capture_transcript()
        if not available:
            return {"ok": False, "error": "Microphone unavailable.",
                    "hint": "Voice needs the mic stack; reinstall the latest app."}
        if not spoke or not text.strip():
            return {"ok": True, "handled": False, "transcript": text}
        if not nexus.router.is_ready():
            return {"ok": True, "handled": True, "transcript": text,
                    "agent": None, "reply": _model_unready_message(nexus)}
        try:
            agent, answer = nexus.ask_voice(text)
        except Exception as e:  # noqa: BLE001
            agent, answer = None, _ask_error_message(e)
        return {"ok": True, "handled": True, "transcript": text,
                "agent": agent, "reply": answer}

    @api.get("/api/voice/status")
    def voice_status() -> dict:
        return _voice_status(nexus)

    @api.post("/api/speak")
    def speak_text(payload: dict = Body(...)) -> dict:
        """Speak text through Windows' own voice engine (reliable, British voice
        if available). Blocks until finished so the UI knows when to resume."""
        from nexus.speech.tts_text import prepare_for_speech

        text = prepare_for_speech((payload or {}).get("text", "").strip())
        if not text:
            return {"ok": True}
        try:
            import pythoncom
            import win32com.client

            pythoncom.CoInitialize()
            try:
                voice = win32com.client.Dispatch("SAPI.SpVoice")
                try:
                    voices = voice.GetVoices()
                    for i in range(voices.Count):
                        desc = voices.Item(i).GetDescription()
                        if "Great Britain" in desc or "United Kingdom" in desc:
                            voice.Voice = voices.Item(i)
                            break
                except Exception:  # noqa: BLE001 - voice pick is best-effort
                    pass
                voice.Speak(text)  # synchronous: returns when speech finishes
                return {"ok": True}
            finally:
                pythoncom.CoUninitialize()
        except Exception:  # noqa: BLE001
            logging.getLogger("nexus.api").warning("SAPI speak failed", exc_info=True)
            return {"ok": False, "error": "speak_failed"}

    @api.get("/api/settings")
    def settings() -> dict:
        return {
            "provider": nexus.router.provider,
            "ready": nexus.router.is_ready(),
            "gemini_set": nexus.router.has_gemini_key(),
        }

    @api.post("/api/settings/gemini")
    def set_gemini(payload: dict = Body(...)) -> dict:
        key = (payload or {}).get("key", "").strip()
        provider = nexus.set_gemini_key(key)
        return {"ok": True, "provider": provider, "ready": nexus.router.is_ready(),
                "message": ("Gemini connected - fast cloud brain active." if provider == "gemini"
                            else "Gemini key cleared - using local Ollama.")}

    @api.get("/api/connections")
    def connections() -> dict:
        from nexus.connectors.simple_accounts import list_calendars, list_email_accounts

        return {"emails": list_email_accounts(), "calendars": list_calendars()}

    @api.post("/api/connections/email")
    def add_email(payload: dict = Body(...)) -> dict:
        from nexus.connectors.imap_mail import ImapMail
        from nexus.connectors.simple_accounts import add_email_account

        address = (payload or {}).get("email", "").strip()
        password = (payload or {}).get("password", "").strip()
        if not address or not password:
            return {"ok": False, "error": "Enter both your email and the app password."}
        add_email_account(address, password)
        # Verify the credentials by reading one message. Don't echo the raw
        # exception (it can carry account/host details) — log it, return generic.
        try:
            ImapMail.connect(address).list_recent(max_results=1)
        except Exception:  # noqa: BLE001
            logging.getLogger("nexus.api").warning("IMAP test login failed for an account",
                                                   exc_info=True)
            return {"ok": False,
                    "error": "Saved, but the test login failed. Check the address and app "
                             "password, and that IMAP is enabled in Gmail settings."}
        return {"ok": True, "message": f"Connected {address}."}

    @api.post("/api/connections/calendar")
    def add_calendar_conn(payload: dict = Body(...)) -> dict:
        from nexus.connectors.ical_cal import CalendarError, IcalCalendar, validate_calendar_url
        from nexus.connectors.simple_accounts import add_calendar

        name = (payload or {}).get("name", "").strip()
        url = (payload or {}).get("url", "").strip()
        if not name or not url:
            return {"ok": False, "error": "Enter both a name and the calendar link."}
        # Validate (https, .ics path, public address) BEFORE storing or fetching.
        try:
            validate_calendar_url(url)
        except CalendarError as e:
            return {"ok": False, "error": str(e)}
        add_calendar(name, url)
        try:
            IcalCalendar.connect(name).upcoming(days=30)
        except CalendarError as e:
            return {"ok": False, "error": str(e)}
        except Exception:  # noqa: BLE001 - don't echo upstream details
            return {"ok": False, "error": "Saved, but couldn't read that calendar link."}
        return {"ok": True, "message": f"Connected calendar '{name}'."}

    @api.post("/api/connections/email/remove")
    def remove_email(payload: dict = Body(...)) -> dict:
        from nexus.connectors.simple_accounts import remove_email_account

        address = (payload or {}).get("email", "").strip()
        if address:
            remove_email_account(address)
        return {"ok": True}

    @api.post("/api/connections/calendar/remove")
    def remove_calendar_conn(payload: dict = Body(...)) -> dict:
        from nexus.connectors.simple_accounts import remove_calendar

        name = (payload or {}).get("name", "").strip()
        if name:
            remove_calendar(name)
        return {"ok": True}

    @api.post("/api/ask")
    def ask(payload: dict = Body(...)) -> dict:
        text = (payload or {}).get("text", "").strip()
        if not text:
            return {"agent": None, "answer": "Ask me something."}
        if not nexus.router.is_ready():
            return {"agent": None, "answer": _model_unready_message(nexus)}
        try:
            name, answer = nexus.ask(text)
        except Exception as e:  # noqa: BLE001 - never crash the request
            return {"agent": None, "answer": _ask_error_message(e)}
        return {"agent": name, "answer": answer}

    return api


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    import uvicorn

    uvicorn.run(create_app(), host=host, port=port)
