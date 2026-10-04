"""A tiny synchronous in-process event bus.

Decouples producers from consumers: e.g. the Email agent publishes
``email.fetched`` and the digest builder subscribes, without either importing
the other. Intentionally simple — no async, no persistence.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable
from typing import Any

Handler = Callable[[Any], None]
_log = logging.getLogger("nexus.events")


class EventBus:
    def __init__(self) -> None:
        self._subscribers: dict[str, list[Handler]] = defaultdict(list)

    def subscribe(self, event: str, handler: Handler) -> Callable[[], None]:
        """Register ``handler`` for ``event``. Returns an unsubscribe callable."""
        self._subscribers[event].append(handler)

        def _unsubscribe() -> None:
            handlers = self._subscribers.get(event, [])
            if handler in handlers:
                handlers.remove(handler)

        return _unsubscribe

    def publish(self, event: str, payload: Any = None) -> None:
        """Invoke every handler for ``event``. Handler errors are swallowed so
        one bad subscriber cannot break the publisher."""
        for handler in list(self._subscribers.get(event, [])):
            try:
                handler(payload)
            except Exception:  # noqa: BLE001 - bus must never crash a publisher
                _log.exception("event handler for %r failed", event)


# Process-wide default bus.
bus = EventBus()
