"""Long-term memory — durable facts that survive a restart.

The in-session history (Tier 1) is short-term; this is the long-term store. It's a plain,
human-readable file: one fact per line, each a single clear statement, so you can open it,
fix a wrong fact, or delete one by hand any time. Facts are loaded into the system prompt
at the start of each conversation, so Nexus walks in already knowing them.

The model manages its own memory through three tools (remember / update / forget). Memory
is treated as *knowledge, not instructions* — a stored note never becomes a backdoor around
the user's judgment or the Tier 6 safety gate (the system prompt says so explicitly).
"""

from __future__ import annotations

from pathlib import Path

from .toolspec import Tool

# memory/ at the project root: plain text, git-ignored, hand-editable.
_STORE = Path(__file__).resolve().parent.parent / "memory" / "facts.md"

_HEADER = (
    "# Nexus memory — durable facts about the user. One per line; edit or delete freely.\n\n"
)


def load_facts() -> list[str]:
    """Read the saved facts (one per bullet line). Returns [] if there are none."""
    if not _STORE.exists():
        return []
    facts = []
    for raw in _STORE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("- "):
            fact = line[2:].strip()
            if fact:
                facts.append(fact)
    return facts


def _save_facts(facts: list[str]) -> None:
    _STORE.parent.mkdir(parents=True, exist_ok=True)
    body = _HEADER + "".join(f"- {f}\n" for f in facts)
    _STORE.write_text(body, encoding="utf-8")


# ----------------------------------------------------------------- tool handlers

def remember_fact(args: dict) -> str:
    text = (args.get("text") or "").strip()
    if not text:
        return "Nothing to remember — no text given."
    facts = load_facts()
    if any(text.lower() == f.lower() for f in facts):
        return "Already saved — I knew that."
    facts.append(text)
    _save_facts(facts)
    return f"Got it, I'll remember: {text}"


def update_fact(args: dict) -> str:
    query = (args.get("old") or "").strip().lower()
    new = (args.get("new") or "").strip()
    if not query or not new:
        return "Updating a fact needs both the existing fact to find and the new wording."
    facts = load_facts()
    for i, f in enumerate(facts):
        if query in f.lower():
            old = facts[i]
            facts[i] = new
            _save_facts(facts)
            return f"Updated: \"{old}\" -> \"{new}\""
    return f"I couldn't find a saved fact matching \"{args.get('old')}\"."


def forget_fact(args: dict) -> str:
    query = (args.get("query") or "").strip().lower()
    if not query:
        return "Tell me which fact to forget."
    facts = load_facts()
    for i, f in enumerate(facts):
        if query in f.lower():
            removed = facts.pop(i)
            _save_facts(facts)
            return f"Forgotten: {removed}"
    return f"Nothing saved matches \"{args.get('query')}\"."


def list_facts(args: dict) -> str:
    facts = load_facts()
    if not facts:
        return "I don't have any saved facts about you yet."
    return "\n".join(f"- {f}" for f in facts)


def get_tools() -> list[Tool]:
    return [
        Tool(
            name="remember_fact",
            description=(
                "Use this to save a durable fact about the user so you'll know it in future "
                "conversations — their name, preferences, important people, recurring "
                "decisions. Save lasting facts, not passing chatter from this conversation."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The fact, as one plain statement."}
                },
                "required": ["text"],
            },
            handler=remember_fact,
        ),
        Tool(
            name="update_fact",
            description=(
                "Use this to correct a saved fact when it has changed or was wrong. Give the "
                "existing fact to find (`old`) and its new wording (`new`)."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "old": {"type": "string", "description": "Text identifying the saved fact to change."},
                    "new": {"type": "string", "description": "The corrected fact."},
                },
                "required": ["old", "new"],
            },
            handler=update_fact,
        ),
        Tool(
            name="forget_fact",
            description=(
                "Use this to delete a saved fact when the user asks you to forget something. "
                "Give text identifying the fact in `query`."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text identifying the fact to delete."}
                },
                "required": ["query"],
            },
            handler=forget_fact,
            requires_confirmation=True,  # deleting the user's data — gated in Tier 6
        ),
    ]
