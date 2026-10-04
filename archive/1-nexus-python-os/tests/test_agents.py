"""Agent framework: protocol parsing, ReAct loop, tool use, loop guard, routing.

All tests use a scripted fake router so they run without Ollama.
"""

from __future__ import annotations

from nexus.kernel.registry import Registry
from nexus.kernel.types import AgentSpec, ModelTier
from nexus.agents.base import AgentContext, BaseAgent
from nexus.agents.orchestrator import Orchestrator, RouteCandidate
from nexus.agents.protocol import parse_action
from nexus.tools.base import Tool, ToolParam


class ScriptedRouter:
    """Returns queued replies in order; records each call."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def complete(self, messages, tier=ModelTier.BALANCED, **kwargs):
        self.calls.append(messages)
        if self.replies:
            return self.replies.pop(0)
        return '{"action": "final", "answer": "done"}'


def _add_tool_registry() -> Registry:
    reg: Registry = Registry("tool")
    reg.register(
        "add",
        Tool(
            name="add",
            description="Add two integers",
            func=lambda a, b: int(a) + int(b),
            params=[ToolParam("a", "int"), ToolParam("b", "int")],
        ),
    )
    return reg


# --- protocol -----------------------------------------------------------------

def test_parse_tool_action():
    a = parse_action('{"action": "tool", "tool": "add", "args": {"a": 1, "b": 2}}')
    assert a.kind == "tool"
    assert a.tool == "add"
    assert a.args == {"a": 1, "b": 2}


def test_parse_final_action():
    a = parse_action('Sure! {"action": "final", "answer": "hello"} ignore me')
    assert a.kind == "final"
    assert a.answer == "hello"


def test_parse_plain_prose_is_final():
    a = parse_action("I think the answer is 42.")
    assert a.kind == "final"
    assert "42" in a.answer


def test_parse_tool_name_in_action_field():
    # Small models often emit {"action": "<tool>", "args": {...}} — treat as tool.
    a = parse_action('{"action": "calendar_upcoming", "args": {"days": 1}}')
    assert a.kind == "tool"
    assert a.tool == "calendar_upcoming"
    assert a.args == {"days": 1}


def test_parse_inline_args_style():
    # Some models inline the args as top-level keys instead of under "args".
    a = parse_action('{"action": "task_add", "title": "buy a folder", '
                     '"due": "2026-06-21", "priority": 2}')
    assert a.kind == "tool"
    assert a.tool == "task_add"
    assert a.args["title"] == "buy a folder"
    assert a.args["due"] == "2026-06-21"
    assert "action" not in a.args


# --- ReAct loop ---------------------------------------------------------------

def test_agent_uses_tool_then_finalizes():
    router = ScriptedRouter([
        '{"action": "tool", "tool": "add", "args": {"a": 2, "b": 3}}',
        '{"action": "final", "answer": "The sum is 5"}',
    ])
    ctx = AgentContext(router=router, tools=_add_tool_registry())
    spec = AgentSpec(name="calc", tools=["add"], max_steps=4)
    agent = BaseAgent(spec, ctx)

    answer = agent.run("add 2 and 3")
    assert answer == "The sum is 5"
    assert len(router.calls) == 2
    # The second model call must include the tool observation.
    observation_seen = any(
        getattr(m, "role", "") == "tool" and "TOOL add -> 5" in getattr(m, "content", "")
        for m in router.calls[1]
    )
    assert observation_seen


def test_agent_accepts_plain_answer():
    router = ScriptedRouter(["The capital of France is Paris."])
    ctx = AgentContext(router=router, tools=Registry("tool"))
    agent = BaseAgent(AgentSpec(name="qa"), ctx)
    assert "Paris" in agent.run("capital of France?")


def test_agent_loop_guard():
    # Always asks for a tool, never finalizes -> guard message after max_steps.
    router = ScriptedRouter([
        '{"action": "tool", "tool": "add", "args": {"a": 1, "b": 1}}',
    ] * 10)
    ctx = AgentContext(router=router, tools=_add_tool_registry())
    agent = BaseAgent(AgentSpec(name="calc", tools=["add"], max_steps=3), ctx)
    out = agent.run("loop forever")
    assert "wasn't able to complete" in out
    assert len(router.calls) == 3  # exactly max_steps


def test_agent_handles_unknown_tool():
    router = ScriptedRouter([
        '{"action": "tool", "tool": "nope", "args": {}}',
        '{"action": "final", "answer": "recovered"}',
    ])
    ctx = AgentContext(router=router, tools=_add_tool_registry())
    agent = BaseAgent(AgentSpec(name="calc", tools=["add"], max_steps=4), ctx)
    assert agent.run("x") == "recovered"


# --- orchestrator -------------------------------------------------------------

def test_orchestrator_keyword_routing():
    candidates = [
        RouteCandidate("study", "A-Level study", keywords=["study", "revise", "physics", "paper"]),
        RouteCandidate("email", "Your inbox", keywords=["inbox", "gmail", "email"]),
    ]
    orch = Orchestrator(candidates, router=None)
    # Stem matching: "revise"/"papers" hit study even with plural/variant forms.
    assert orch.route("help me revise physics past papers") == "study"
    assert orch.route("summarize my inbox") == "email"


def test_orchestrator_no_signal_falls_back_to_assistant():
    candidates = [
        RouteCandidate("study", "studies", keywords=["study"]),
        RouteCandidate("assistant", "general help"),
    ]
    orch = Orchestrator(candidates, router=None)
    # No domain keyword -> safe general agent, deterministically (no model call).
    assert orch.route("tell me a joke please") == "assistant"
