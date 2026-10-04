"""Model backends. Each exposes the same two functions: `stream(...)` and
`format_tool_results(...)`. `get_backend` imports only the one actually in use, so
selecting Ollama never imports the Anthropic SDK and vice versa.
"""

from __future__ import annotations

from ..llm import LLMError


def get_backend(provider: str):
    p = (provider or "").strip().lower()
    if p == "ollama":
        from . import ollama_provider
        return ollama_provider
    if p == "anthropic":
        from . import anthropic_provider
        return anthropic_provider
    raise LLMError(
        f"Unknown model provider '{provider}'. "
        "Set [model] provider in config.toml to 'ollama' or 'anthropic'."
    )
