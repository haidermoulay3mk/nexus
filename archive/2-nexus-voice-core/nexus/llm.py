"""The provider seam.

Nothing outside this seam knows which model backend is in use. Everything calls
`stream()`; the active backend is chosen by `[model] provider` in config.toml and
dispatched to a module under `nexus/providers/`. Swapping the brain — local Ollama,
Anthropic, something else later — is a config edit plus one provider module, never a
change to the agent, the tools, or the voice layer.

The seam also normalizes tool use (Tier 2): each backend reports tool calls in the same
neutral `ToolCall` shape and knows how to append its own assistant turn and tool-result
turns to the history, so the agentic loop in `agent.py` stays completely backend-agnostic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .config import Config


class LLMError(Exception):
    """A backend problem already turned into a friendly, user-facing message."""


@dataclass
class ToolCall:
    """A model's request to run one tool, normalized across backends."""

    id: str
    name: str
    arguments: dict


@dataclass
class LLMResult:
    text: str                              # the concatenated text of the reply
    tool_calls: list[ToolCall] = field(default_factory=list)
    assistant_message: dict = field(default_factory=dict)  # exact history entry to append (backend-shaped)
    stop_reason: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0


def stream(
    *,
    config: Config,
    system: str,
    messages: list[dict],
    tools: list | None = None,          # neutral Tool objects (nexus.tools.base.Tool); converted per backend
    on_text: Callable[[str], None] | None = None,
) -> LLMResult:
    """Send the conversation, stream the reply, return a structured result.

    `on_text` is called with each text chunk as it arrives. Backend/network failures are
    raised as `LLMError` with a friendly message — callers print it and reprompt rather
    than crashing.
    """
    from .providers import get_backend  # lazy: keeps unused backends' deps out of the way

    backend = get_backend(config.provider)
    return backend.stream(
        config=config,
        system=system,
        messages=messages,
        tools=tools,
        on_text=on_text,
    )


def format_tool_results(config: Config, outcomes: list[tuple]) -> list[dict]:
    """Turn executed tool outcomes into the history turn(s) the active backend expects.

    `outcomes` is a list of (ToolCall, output_text, is_error) tuples. Returns the message(s)
    to append to history before the next model turn.
    """
    from .providers import get_backend

    return get_backend(config.provider).format_tool_results(outcomes)
