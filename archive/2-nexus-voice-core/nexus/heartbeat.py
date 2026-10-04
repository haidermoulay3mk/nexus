"""The heartbeat — a background loop, separate from the conversation loop, that lets Nexus
act without being spoken to.

It wakes on an interval, runs each scheduled check that's due, and routes anything
noteworthy into the inbox. It does NOT print to the user directly — it only fills the inbox;
the interface reads the inbox at natural moments (so a background thread never garbles the
prompt).

Design rules, all here:
  - quiet by default        : checks usually return nothing; "log" notices don't interrupt.
  - quiet hours             : non-critical interrupts are downgraded to "log" overnight.
  - survive restarts        : each check's next-due time is persisted to state/heartbeat.json;
                              a fresh check is scheduled one interval out, so a restart never
                              fires everything at once on boot.
  - no overlapping runs     : checks run sequentially in the loop, so a check never overlaps
                              its own previous run.
  - relocatable             : the loop doesn't care which machine it's on. Run it inside the
                              REPL (a daemon thread) on a laptop, or standalone
                              (`python -m nexus.heartbeat`) on an always-on host later.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path

from . import inbox
from . import killswitch
from .checks import get_checks
from .config import Config, load_config

_SCHEDULE = Path(__file__).resolve().parent.parent / "state" / "heartbeat.json"


# ----------------------------------------------------------------- schedule state

def _load_schedule() -> dict:
    if not _SCHEDULE.exists():
        return {}
    try:
        return json.loads(_SCHEDULE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_schedule(sched: dict) -> None:
    _SCHEDULE.parent.mkdir(parents=True, exist_ok=True)
    _SCHEDULE.write_text(json.dumps(sched, indent=2), encoding="utf-8")


# ----------------------------------------------------------------- quiet hours

def in_quiet_hours(when: datetime, config: Config) -> bool:
    start, end = config.quiet_hours_start, config.quiet_hours_end
    if start == end:
        return False
    h = when.hour
    if start < end:
        return start <= h < end
    return h >= start or h < end  # window wraps past midnight


def effective_level(notice, config: Config, when: datetime) -> str:
    """A non-critical interrupt becomes a quiet log entry during quiet hours."""
    if notice.level == "interrupt" and not notice.critical and in_quiet_hours(when, config):
        return "log"
    return notice.level


# ----------------------------------------------------------------- running checks

def _safe_run(check) -> list:
    try:
        return check.run() or []
    except Exception:  # noqa: BLE001 — one bad check must never kill the loop
        return []


def _surface(notices: list, config: Config, when: datetime) -> list[dict]:
    """Apply quiet-hours and hand each notice to the inbox (which dedups). Returns the ones
    actually added."""
    added = []
    for n in notices:
        if inbox.add(n, level=effective_level(n, config, when)):
            added.append({"text": n.text, "level": effective_level(n, config, when)})
    return added


def run_checks(config: Config, when: datetime | None = None) -> list[dict]:
    """Run every enabled check once, ignoring the schedule. Used for tests and a manual
    'check now'."""
    when = when or datetime.now()
    surfaced = []
    for check in get_checks(config):
        surfaced += _surface(_safe_run(check), config, when)
    return surfaced


def run_due(config: Config, now: float | None = None) -> list[dict]:
    """Run only the checks whose next-due time has arrived; reschedule them. A check with no
    schedule entry yet is set one interval into the future (no boot stampede)."""
    if killswitch.is_paused():
        return []  # kill switch: hold all proactive behavior
    now = time.time() if now is None else now
    sched = _load_schedule()
    surfaced = []
    for check in get_checks(config):
        due = sched.get(check.name)
        if due is None:
            sched[check.name] = now + check.interval_seconds
            continue
        if now >= due:
            surfaced += _surface(_safe_run(check), config, datetime.now())
            sched[check.name] = now + check.interval_seconds
    _save_schedule(sched)
    return surfaced


# ----------------------------------------------------------------- the loop

def run_forever(config: Config, stop_event: threading.Event | None = None, on_surface=None) -> None:
    stop_event = stop_event or threading.Event()
    while not stop_event.is_set():
        try:
            surfaced = run_due(config)
            if on_surface and surfaced:
                on_surface(surfaced)
        except Exception:  # noqa: BLE001 — the loop must keep beating
            pass
        stop_event.wait(config.heartbeat_tick_seconds)


def start_background(config: Config) -> tuple[threading.Thread, threading.Event]:
    """Start the heartbeat as a daemon thread (used by the REPL). Returns (thread, stop)."""
    stop = threading.Event()
    thread = threading.Thread(target=run_forever, args=(config, stop), daemon=True, name="nexus-heartbeat")
    thread.start()
    return thread, stop


def main() -> int:
    """Standalone runner — for relocating the heartbeat to an always-on host later."""
    config = load_config()
    print("Nexus heartbeat running (Ctrl-C to stop). Notices go to the inbox.")

    def on_surface(items):
        for it in items:
            print(f"  [{it['level']}] {it['text']}")

    try:
        run_forever(config, on_surface=on_surface)
    except KeyboardInterrupt:
        print("\nheartbeat stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
