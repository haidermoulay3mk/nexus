"""The shape of a tool — kept in its own side-effect-free module so any module (including
top-level ones like memory.py) can import `Tool` without triggering the tools registry's
package initialization. (The registry imports the tool modules; the tool modules must not
trigger the registry, or they deadlock at import time.)

A tool is a named capability with a reader-facing description, a typed input schema, a
handler, and a flag for whether it's consequential enough to require confirmation before it
runs. The model picks tools by their descriptions, so write them for a reader ("Use this
to…"), not for a compiler.

`requires_confirmation` is recorded now but not yet enforced — the hard confirmation gate
that reads it lands in Tier 6. Mark consequential tools (send / spend / delete / change a
setting) True from the moment they're written so the gate has teeth the day it arrives.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict                       # JSON Schema describing the inputs
    handler: Callable[[dict], str]         # takes validated args, returns a plain-text result
    requires_confirmation: bool = False    # enforced in Tier 6

    def run(self, args: dict) -> str:
        return self.handler(args)
