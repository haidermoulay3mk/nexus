"""BaseAgent: a single ReAct loop shared by every specialist agent.

Design choices:
* One runtime (no multiple competing agent runtimes like upstream OpenJarvis).
* Tools are injected per-agent from a registry, named in the AgentSpec.
* A loop guard caps iterations so a confused small model can't spin forever.
* If the model answers in plain prose instead of the JSON protocol, we accept
  it — robustness over rigidity, which matters a lot for 1–3B local models.
"""

from __future__ import annotations

from dataclasses import dataclass

from nexus.kernel.registry import Registry
from nexus.kernel.types import AgentSpec, ChatMessage, ModelTier
from nexus.agents.protocol import parse_action
from nexus.tools.base import Tool


@dataclass
class AgentContext:
    """Shared services handed to every agent. ``router`` only needs a
    ``complete(messages, tier=...)`` method, so tests can pass a fake."""

    router: object
    tools: Registry  # Registry[Tool]
    memory: object | None = None


_PROTOCOL_INSTRUCTIONS = """\
You are a focused assistant that can use tools to help the user.

To use a tool, reply with ONLY a JSON object:
{"action": "tool", "tool": "<tool_name>", "args": {<arguments>}}

When you have the final answer, reply with ONLY:
{"action": "final", "answer": "<your answer to the user>"}

Rules:
- Use one JSON object per reply. No extra text around it.
- Only call tools from the list below; invent nothing.
- Prefer to answer directly when no tool is needed.

Available tools:
__TOOLS__
"""


class BaseAgent:
    def __init__(self, spec: AgentSpec, ctx: AgentContext, system_prompt: str = "") -> None:
        self.spec = spec
        self.ctx = ctx
        self.system_prompt = system_prompt

    def _tools(self) -> list[Tool]:
        out = []
        for name in self.spec.tools:
            t = self.ctx.tools.try_get(name)
            if t is not None:
                out.append(t)
        return out

    def _build_system_message(self, extra_preamble: str = "") -> str:
        from datetime import datetime

        tools = self._tools()
        tool_lines = "\n".join(t.signature() for t in tools) or "(none)"
        base = _PROTOCOL_INSTRUCTIONS.replace("__TOOLS__", tool_lines)
        # Give the model today's date so "tomorrow"/"Friday"/"next week" resolve.
        today = f"Today's date is {datetime.now().strftime('%Y-%m-%d (%A)')}."
        parts = [p.strip() for p in (self.system_prompt, extra_preamble, today, base) if p.strip()]
        return "\n\n".join(parts)

    def run(self, user_input: str, *, extra_preamble: str = "") -> str:
        messages: list[ChatMessage] = [
            ChatMessage(role="system", content=self._build_system_message(extra_preamble)),
            ChatMessage(role="user", content=user_input),
        ]
        tier = self.spec.model_tier if isinstance(self.spec.model_tier, ModelTier) else ModelTier.BALANCED

        for _ in range(max(1, self.spec.max_steps)):
            raw = self.ctx.router.complete(messages, tier=tier)
            action = parse_action(raw)

            if action.kind == "final":
                return action.answer

            # tool action
            tool = self.ctx.tools.try_get(action.tool)
            if tool is None:
                observation = f"ERROR: unknown tool '{action.tool}'. Choose from: " \
                              f"{', '.join(t.name for t in self._tools())}"
            else:
                result = tool.run(**(action.args or {}))
                observation = (
                    f"TOOL {tool.name} -> {result.output}"
                    if result.ok
                    else f"TOOL {tool.name} FAILED: {result.error}"
                )

            # Record the model's move and the observation, then continue.
            messages.append(ChatMessage(role="assistant", content=raw))
            messages.append(ChatMessage(role="tool", content=observation, name=action.tool))

        return "I wasn't able to complete that within the allowed steps."
