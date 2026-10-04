"""Tool abstraction.

A Tool wraps a plain Python callable with a name, a description, and a small
parameter spec. Agents discover tools by name from a Registry and call them with
keyword arguments produced by the model. Every call returns a ToolResult, so the
ReAct loop has a uniform shape to reason about.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from nexus.kernel.registry import Registry
from nexus.kernel.types import ToolResult


@dataclass
class ToolParam:
    name: str
    type: str = "string"        # informational hint shown to the model
    description: str = ""
    required: bool = True


@dataclass
class Tool:
    name: str
    description: str
    func: Callable[..., Any]
    params: list[ToolParam] = field(default_factory=list)

    def run(self, **kwargs: Any) -> ToolResult:
        """Execute, normalizing the return value and trapping exceptions."""
        # Reject unknown args defensively (small models hallucinate keys).
        allowed = {p.name for p in self.params}
        if allowed:
            kwargs = {k: v for k, v in kwargs.items() if k in allowed}
        missing = [p.name for p in self.params if p.required and p.name not in kwargs]
        if missing:
            return ToolResult.fail(f"missing required argument(s): {', '.join(missing)}")
        try:
            result = self.func(**kwargs)
        except Exception as e:  # noqa: BLE001 - surface tool errors to the loop
            return ToolResult.fail(f"{type(e).__name__}: {e}")
        if isinstance(result, ToolResult):
            return result
        return ToolResult(ok=True, output=result)

    def signature(self) -> str:
        """One-line description for the system prompt."""
        if not self.params:
            return f"- {self.name}(): {self.description}"
        args = ", ".join(
            f"{p.name}:{p.type}" + ("" if p.required else "?") for p in self.params
        )
        return f"- {self.name}({args}): {self.description}"


# A registry of tools, keyed by tool name.
ToolRegistry = Registry[Tool]


def tool(name: str, description: str, params: list[ToolParam] | None = None):
    """Decorator that turns a function into a registered-ready Tool."""

    def _wrap(func: Callable[..., Any]) -> Tool:
        return Tool(name=name, description=description, func=func, params=params or [])

    return _wrap
