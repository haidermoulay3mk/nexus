"""Google Gemini backend (free tier) via the REST API — no extra dependencies.

Get a free key at https://aistudio.google.com/apikey (no billing required).
Using Gemini sends prompts to Google; it's the fast/smart cloud option, opt-in
via a key. The local Ollama path stays the private default when no key is set.
"""

from __future__ import annotations

from collections.abc import Iterable

import httpx

from nexus.kernel.types import ChatMessage

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiError(RuntimeError):
    pass


def _to_gemini(messages: Iterable) -> tuple[str, list[dict]]:
    """Split messages into a system instruction + Gemini 'contents'."""
    system_parts: list[str] = []
    contents: list[dict] = []
    for m in messages:
        role = m.role if isinstance(m, ChatMessage) else m.get("role")
        content = m.content if isinstance(m, ChatMessage) else m.get("content", "")
        if role == "system":
            system_parts.append(content)
        else:
            g_role = "model" if role == "assistant" else "user"
            contents.append({"role": g_role, "parts": [{"text": content}]})
    return "\n".join(system_parts), contents


class GeminiClient:
    def __init__(self, api_key: str, model: str = "gemini-2.0-flash",
                 timeout_s: float = 60.0) -> None:
        self.api_key = api_key
        self.model = model
        self._timeout = timeout_s

    def is_available(self) -> bool:
        return bool(self.api_key)

    def chat(self, messages, *, model: str | None = None,
             temperature: float = 0.7) -> str:
        model = model or self.model
        system, contents = _to_gemini(messages)
        body: dict = {"contents": contents,
                      "generationConfig": {"temperature": temperature}}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        try:
            r = httpx.post(f"{_BASE}/{model}:generateContent",
                           params={"key": self.api_key}, json=body, timeout=self._timeout)
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise GeminiError(f"Gemini API error ({e.response.status_code}). Check your key.") from e
        except httpx.HTTPError as e:
            raise GeminiError(f"Could not reach Gemini ({type(e).__name__}).") from e
        data = r.json()
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            # Blocked/empty response (e.g. safety filter) -> empty string.
            return ""

    def transcribe(self, audio_bytes: bytes, mime: str = "audio/wav") -> str:
        """Transcribe speech audio to text using Gemini (multimodal)."""
        import base64

        body = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": "Transcribe the spoken words in this audio verbatim. "
                             "Output only the words spoken, nothing else. "
                             "If there is no clear speech, output nothing."},
                    {"inline_data": {"mime_type": mime,
                                     "data": base64.b64encode(audio_bytes).decode("ascii")}},
                ],
            }],
            "generationConfig": {"temperature": 0.0},
        }
        try:
            r = httpx.post(f"{_BASE}/{self.model}:generateContent",
                           params={"key": self.api_key}, json=body, timeout=self._timeout)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise GeminiError(f"Gemini transcription failed ({type(e).__name__}).") from e
        data = r.json()
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()
        except (KeyError, IndexError):
            return ""

    def list_models(self) -> list[str]:
        return [self.model]
