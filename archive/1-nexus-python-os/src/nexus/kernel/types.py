"""Shared types used across every layer.

Kept dependency-light (pydantic only) so the kernel never pulls in model,
memory, or web dependencies.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class ModelTier(str, Enum):
    """Which class of model a task should run on.

    The router maps each tier to a concrete Ollama model. This indirection is
    what lets you swap models (or add a GPU/cloud tier) via config, not code.
    """

    FAST = "fast"          # tiny model: routing, classification, short replies
    BALANCED = "balanced"  # default interactive chat
    REASONING = "reasoning"  # slow, high-quality; non-interactive heavy tasks


class AgentMode(str, Enum):
    """How an agent is invoked (adopted from OpenJarvis's three-mode model)."""

    ON_DEMAND = "on_demand"    # user asks
    SCHEDULED = "scheduled"    # runs on a cron schedule (e.g. morning digest)
    CONTINUOUS = "continuous"  # long-lived watcher (e.g. calendar reminders)


Role = Literal["system", "user", "assistant", "tool"]


class ChatMessage(BaseModel):
    role: Role
    content: str
    name: str | None = None  # tool name, when role == "tool"


class ToolResult(BaseModel):
    """Normalized result returned by every tool."""

    ok: bool = True
    output: Any = None
    error: str | None = None

    @classmethod
    def fail(cls, error: str) -> "ToolResult":
        return cls(ok=False, output=None, error=error)


class AgentSpec(BaseModel):
    """Declarative agent definition — loaded from a YAML file.

    Adding an agent means adding one of these (plus an optional handler).
    """

    name: str
    description: str = ""
    mode: AgentMode = AgentMode.ON_DEMAND
    model_tier: ModelTier = ModelTier.BALANCED
    tools: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)  # routing hints for the orchestrator
    system_prompt: str | None = None  # path (relative to prompts dir) or inline text
    schedule: str | None = None       # cron expression when mode == SCHEDULED
    handler: str | None = None        # dotted path to a custom AgentHandler subclass
    enabled: bool = True
    max_steps: int = 8                # ReAct loop guard


class MemoryRecord(BaseModel):
    """A row in the generic ``memories`` table (notes / knowledge / context)."""

    id: int | None = None
    namespace: str = "default"
    kind: str = "note"
    title: str = ""
    content: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None
