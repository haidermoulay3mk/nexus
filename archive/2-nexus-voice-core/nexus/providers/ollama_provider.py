"""Ollama backend — a free model running locally on this machine. No API key, no cost,
fully private (nothing leaves the laptop).

Talks to the local Ollama service over its HTTP API using only the standard library, so
this backend adds no dependency. Streaming is newline-delimited JSON: one object per line,
each carrying the next chunk of the reply (and, on a tool turn, the tool calls).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Callable

from ..config import Config
from ..llm import LLMError, LLMResult, ToolCall


def _coerce_content(content: object) -> str:
    """History content is normally a plain string for this backend, but coerce defensively."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return str(content)


def _to_ollama_messages(messages: list[dict]) -> list[dict]:
    out = []
    for m in messages:
        entry = {"role": m["role"], "content": _coerce_content(m.get("content", ""))}
        # Preserve a prior assistant turn's tool calls and a tool turn's name, untouched.
        if "tool_calls" in m:
            entry["tool_calls"] = m["tool_calls"]
        if "tool_name" in m:
            entry["tool_name"] = m["tool_name"]
        out.append(entry)
    return out


def _to_ollama_tools(tools: list | None) -> list[dict]:
    specs = []
    for t in tools or []:
        specs.append({
            "type": "function",
            "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
        })
    return specs


def _friendly_unreachable(config: Config) -> str:
    return (
        f"I couldn't reach the local Ollama service at {config.ollama_host}. "
        "Make sure Ollama is running (open the Ollama app), then try again."
    )


def stream(
    *,
    config: Config,
    system: str,
    messages: list[dict],
    tools: list | None = None,
    on_text: Callable[[str], None] | None = None,
) -> LLMResult:
    payload = {
        "model": config.model_name,
        "messages": [{"role": "system", "content": system}] + _to_ollama_messages(messages),
        "stream": True,
        "options": {
            "temperature": config.ollama_temperature,
            "num_ctx": config.ollama_num_ctx,
            "num_predict": config.max_tokens,
        },
    }
    if tools:
        payload["tools"] = _to_ollama_tools(tools)

    url = config.ollama_host.rstrip("/") + "/api/chat"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    parts: list[str] = []
    raw_tool_calls: list[dict] = []
    input_tokens = output_tokens = 0
    stop_reason = "end_turn"

    try:
        with urllib.request.urlopen(request, timeout=config.timeout_seconds) as resp:
            for raw in resp:
                line = raw.decode("utf-8").strip()
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get("error"):
                    raise LLMError(f"Ollama reported an error: {obj['error']}")
                msg = obj.get("message") or {}
                chunk = msg.get("content") or ""
                if chunk:
                    parts.append(chunk)
                    if on_text is not None:
                        on_text(chunk)
                if msg.get("tool_calls"):
                    raw_tool_calls.extend(msg["tool_calls"])
                if obj.get("done"):
                    input_tokens = int(obj.get("prompt_eval_count") or 0)
                    output_tokens = int(obj.get("eval_count") or 0)
                    stop_reason = obj.get("done_reason") or "end_turn"
    except urllib.error.URLError as err:
        raise LLMError(_friendly_unreachable(config)) from err
    except (ConnectionError, TimeoutError) as err:
        raise LLMError(
            "The local model didn't respond in time. Is Ollama running and the model available?"
        ) from err

    text = "".join(parts)

    tool_calls: list[ToolCall] = []
    for i, tc in enumerate(raw_tool_calls):
        fn = tc.get("function", {})
        args = fn.get("arguments", {})
        if isinstance(args, str):  # some models hand back a JSON string
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {"_raw": args}
        tool_calls.append(ToolCall(id=f"call_{i}", name=fn.get("name", ""), arguments=args or {}))

    assistant_message: dict = {"role": "assistant", "content": text}
    if raw_tool_calls:
        assistant_message["tool_calls"] = raw_tool_calls
        stop_reason = "tool_use"

    return LLMResult(
        text=text,
        tool_calls=tool_calls,
        assistant_message=assistant_message,
        stop_reason=stop_reason,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def format_tool_results(outcomes: list[tuple]) -> list[dict]:
    """Ollama takes one message per tool result, role 'tool', matched by tool_name."""
    messages = []
    for call, output, _is_error in outcomes:
        messages.append({"role": "tool", "tool_name": call.name, "content": str(output)})
    return messages
