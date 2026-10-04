"""Generic memory tools (remember / recall) for the general assistant agent."""

from __future__ import annotations

from nexus.kernel.registry import Registry
from nexus.memory.service import MemoryService
from nexus.tools.base import Tool, ToolParam


def build_memory_tools(memory: MemoryService) -> Registry:
    reg: Registry = Registry("tool")

    def remember(content: str, title: str = "") -> str:
        memory.store(content, title=title, namespace="knowledge", kind="note")
        return "Saved to your knowledge base."

    def recall(query: str) -> list[str]:
        hits = memory.search(query, k=5)
        if not hits:
            return ["Nothing relevant found."]
        return [f"{r.title or '(untitled)'}: {r.content}" for r, _score in hits]

    reg.register("mem_remember", Tool(
        "mem_remember", "Save a fact or note to long-term memory", remember,
        [ToolParam("content"), ToolParam("title", required=False)]))
    reg.register("mem_recall", Tool(
        "mem_recall", "Search long-term memory for relevant notes", recall,
        [ToolParam("query")]))
    return reg
