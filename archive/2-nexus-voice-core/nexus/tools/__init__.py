"""The tool registry — the thing the assistant grows forever.

Adding a capability means writing one self-contained tool module with a `get_tools()` and
registering it here. The core loop never changes. `dispatch()` runs a tool by name and
turns any failure into a plain-language error *for the model* (not a crash) — the agent
reasoning over a failed tool result is a feature, not a bug.
"""

from __future__ import annotations

from .base import Tool
from . import reminders
from .. import memory

_REGISTRY: dict[str, Tool] = {}


def register(tool: Tool) -> None:
    _REGISTRY[tool.name] = tool


def all_tools() -> list[Tool]:
    return list(_REGISTRY.values())


def get(name: str) -> Tool | None:
    return _REGISTRY.get(name)


def dispatch(name: str, args: dict) -> tuple[str, bool]:
    """Run a tool by name. Returns (output_text, is_error)."""
    tool = get(name)
    if tool is None:
        return (f"Unknown tool '{name}'.", True)
    if not isinstance(args, dict):
        return (f"Tool '{name}' expects an object of arguments, got {type(args).__name__}.", True)
    try:
        return (tool.run(args), False)
    except Exception as exc:  # noqa: BLE001 — surface the problem to the model, never crash
        return (f"Tool '{name}' failed: {exc}", True)


# Register the built-in tools. New capabilities get one line each here.
for _tool in reminders.get_tools():
    register(_tool)
for _tool in memory.get_tools():
    register(_tool)
