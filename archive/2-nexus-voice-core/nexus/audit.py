"""A plain, visible audit trail — what Nexus did and why.

When something surprises you, this is how you find out what happened: which tools ran, what
it asked you to confirm, what it declined. Plus a running usage tally (tokens per turn and
a cumulative total) so a runaway loop is visible immediately. (On the local Ollama backend
the dollar cost is zero, but the token tally still catches a loop.)

Logging must never break the assistant, so every write is best-effort.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

_STATE = Path(__file__).resolve().parent.parent / "state"
_LOG = _STATE / "audit.log"
_USAGE = _STATE / "usage.json"


def log(event: str, message: str = "", **fields) -> None:
    """Append one timestamped line. Best-effort — never raises."""
    try:
        line = f"{datetime.now().isoformat(timespec='seconds')}  {event:<16}  {message}"
        if fields:
            line += "  " + json.dumps(fields, ensure_ascii=False)
        _LOG.parent.mkdir(parents=True, exist_ok=True)
        with _LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def _load_usage() -> dict:
    if not _USAGE.exists():
        return {"turns": 0, "input_tokens": 0, "output_tokens": 0}
    try:
        return json.loads(_USAGE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"turns": 0, "input_tokens": 0, "output_tokens": 0}


def record_usage(input_tokens: int, output_tokens: int) -> None:
    """Add one turn's token usage to the running total. Best-effort."""
    try:
        data = _load_usage()
        data["turns"] = data.get("turns", 0) + 1
        data["input_tokens"] = data.get("input_tokens", 0) + int(input_tokens or 0)
        data["output_tokens"] = data.get("output_tokens", 0) + int(output_tokens or 0)
        _USAGE.parent.mkdir(parents=True, exist_ok=True)
        _USAGE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


def totals() -> dict:
    return _load_usage()
