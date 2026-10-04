"""Anthropic (Claude) backend. Kept available so switching to a paid, top-tier brain later
is a one-line config change (`[model] provider = "anthropic"` + a key in .env) — no other
code changes. Not the default while we're running free and local on Ollama.
"""

from __future__ import annotations

import os
from typing import Callable

import anthropic

from ..config import Config
from ..llm import LLMError, LLMResult, ToolCall

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise LLMError(
                "ANTHROPIC_API_KEY is not set. Add it to .env, or set "
                "[model] provider = \"ollama\" in config.toml to run free and local."
            )
        _client = anthropic.Anthropic()
    return _client


def _friendly(err: Exception) -> str:
    if isinstance(err, anthropic.APITimeoutError):
        return "The model took too long to respond. Give it another try."
    if isinstance(err, anthropic.APIConnectionError):
        return "I couldn't reach the model — looks like a network problem. Try again in a moment."
    if isinstance(err, anthropic.RateLimitError):
        return "We're being rate-limited. Wait a few seconds and try again."
    if isinstance(err, anthropic.AuthenticationError):
        return "The API key was rejected. Check ANTHROPIC_API_KEY in your .env."
    if isinstance(err, anthropic.APIStatusError):
        return f"The model service returned an error ({err.status_code}). Try again shortly."
    return "Something went wrong talking to the model. Try again."


def _to_anthropic_tools(tools: list | None) -> list[dict]:
    return [
        {"name": t.name, "description": t.description, "input_schema": t.parameters}
        for t in (tools or [])
    ]


def stream(
    *,
    config: Config,
    system: str,
    messages: list[dict],
    tools: list | None = None,
    on_text: Callable[[str], None] | None = None,
) -> LLMResult:
    client = _get_client()

    kwargs: dict = {
        "model": config.model_name,
        "max_tokens": config.max_tokens,
        "system": system,
        "messages": messages,
    }
    if config.thinking == "adaptive":
        kwargs["thinking"] = {"type": "adaptive"}
    if config.effort:
        kwargs["output_config"] = {"effort": config.effort}
    if tools:
        kwargs["tools"] = _to_anthropic_tools(tools)

    try:
        with client.messages.stream(**kwargs) as s:
            for chunk in s.text_stream:
                if on_text is not None:
                    on_text(chunk)
            final = s.get_final_message()
    except anthropic.APIError as err:
        raise LLMError(_friendly(err)) from err

    text = "".join(b.text for b in final.content if b.type == "text")
    tool_calls = [
        ToolCall(id=b.id, name=b.name, arguments=dict(b.input))
        for b in final.content
        if b.type == "tool_use"
    ]

    return LLMResult(
        text=text,
        tool_calls=tool_calls,
        assistant_message={"role": "assistant", "content": final.content},  # raw blocks incl. tool_use
        stop_reason=final.stop_reason,
        input_tokens=final.usage.input_tokens,
        output_tokens=final.usage.output_tokens,
    )


def format_tool_results(outcomes: list[tuple]) -> list[dict]:
    """Anthropic takes all tool results in a single user turn of tool_result blocks."""
    blocks = []
    for call, output, is_error in outcomes:
        block = {"type": "tool_result", "tool_use_id": call.id, "content": str(output)}
        if is_error:
            block["is_error"] = True
        blocks.append(block)
    return [{"role": "user", "content": blocks}]
