"""The minimal action protocol the ReAct loop speaks.

The model is asked to reply with a single JSON object, either:

    {"action": "final", "answer": "..."}            # done, here is the reply
    {"action": "tool", "tool": "name", "args": {...}} # call a tool, then continue

Small local models are imperfect at strict JSON, so parsing is forgiving:
* extract the first balanced ``{...}`` block from the text;
* if no JSON is found, treat the whole response as a final answer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass
class Action:
    kind: str                 # "final" | "tool"
    answer: str = ""
    tool: str = ""
    args: dict[str, Any] | None = None


def _extract_json(text: str) -> str | None:
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start : i + 1]
    return None


def parse_action(text: str) -> Action:
    raw = _extract_json(text)
    if raw is None:
        # Model answered in plain prose — accept it as the final reply.
        return Action(kind="final", answer=text.strip())
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return Action(kind="final", answer=text.strip())

    action = str(data.get("action", "")).strip()
    al = action.lower()
    has_answer = bool(data.get("answer") or data.get("response"))

    def _args() -> dict:
        a = data.get("args") or data.get("arguments")
        if isinstance(a, dict):
            return a
        # Inline style: extra top-level keys ARE the arguments
        # (e.g. {"action": "task_add", "title": "...", "due": "..."}).
        return {k: v for k, v in data.items()
                if k not in ("action", "tool", "name", "answer", "response")}

    # Standard protocol: {"action": "tool", "tool": "name", "args": {...}}
    if al == "tool" and (data.get("tool") or data.get("name")):
        return Action(kind="tool", tool=str(data.get("tool") or data.get("name")), args=_args())

    # A "tool"/"name" key present without action=="tool".
    if (data.get("tool") or data.get("name")) and al != "final" and not has_answer:
        return Action(kind="tool", tool=str(data.get("tool") or data.get("name")), args=_args())

    # Small-model style: the tool name is placed directly in "action".
    if action and al != "final" and not has_answer:
        return Action(kind="tool", tool=action, args=_args())

    # Otherwise it's a final answer.
    answer = data.get("answer") or data.get("response") or data.get("text") or text.strip()
    return Action(kind="final", answer=str(answer))
