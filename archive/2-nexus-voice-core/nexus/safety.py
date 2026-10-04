"""The confirmation gate.

Sits between the model choosing a tool and the tool running, so it covers typed, spoken,
and heartbeat-initiated actions alike (they all flow through the one agentic loop). Any tool
that's consequential — sends, spends, deletes, or changes a setting — stops and gets the
user's explicit yes first, stating plainly what it's about to do. Read-only actions flow
freely.

What's gated is config-driven: a tool flagged `requires_confirmation` in code, OR named in
`[safety] confirm` in config.toml. The whole gate can be turned off with `gate_enabled`
(don't, unless you mean it). Approval is per-action — saying yes once never pre-authorizes
the next action; each consequential call asks on its own.

A `Confirmer` is how the gate asks. Different front ends supply different ones:
  - the text REPL    -> an interactive y/N prompt
  - the heartbeat    -> a non-interactive default that does NOT block on a human (it declines
                        and leaves a note), so a background action can never deadlock waiting
                        for someone who isn't there.
"""

from __future__ import annotations

from typing import Callable

from .config import Config
from .toolspec import Tool

# A confirmer takes a plain description of the action and returns True only on explicit yes.
Confirmer = Callable[[str], bool]


def needs_confirmation(tool: Tool, config: Config) -> bool:
    if not config.safety_gate_enabled:
        return False
    return tool.requires_confirmation or (tool.name in config.safety_confirm_tools)


def describe(tool: Tool, args: dict) -> str:
    """A plain-language statement of what's about to happen, for the confirmation prompt."""
    if args:
        parts = ", ".join(f"{k}={v!r}" for k, v in args.items())
        return f"{tool.name} ({parts})"
    return tool.name


def deny_all(_desc: str) -> bool:
    """The safe default: if no one wired up a real confirmer, consequential actions don't run.

    This is also the heartbeat's confirmer — a background action that would need a human's yes
    is declined rather than left hanging. The caller leaves a note instead.
    """
    return False


def interactive_confirmer(prompt_fn: Callable[[str], str] = input) -> Confirmer:
    """A y/N prompt for the text interface. Anything but an explicit yes is a no."""
    def confirm(desc: str) -> bool:
        try:
            answer = prompt_fn(f"\n  Nexus wants to: {desc}\n  Allow this? [y/N] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return False
        return answer in ("y", "yes")
    return confirm
