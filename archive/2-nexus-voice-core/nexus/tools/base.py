"""Backwards-compatible re-export. The `Tool` dataclass lives in `nexus.toolspec` (a
side-effect-free module) so top-level modules can import it without bootstrapping the tools
registry. Import from here or from `nexus.toolspec` — both give the same class.
"""

from ..toolspec import Tool  # noqa: F401
