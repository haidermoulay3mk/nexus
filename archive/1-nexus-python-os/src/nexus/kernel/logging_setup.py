"""Rotating-file logging under <NEXUS_HOME>/logs/nexus.log.

Call ``setup_logging()`` once at process start (the CLI does this). Library code
just uses ``logging.getLogger("nexus.<area>")`` and stays silent until configured.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from nexus.kernel import paths

_CONFIGURED = False


def setup_logging(level: int = logging.INFO) -> logging.Logger:
    global _CONFIGURED
    logger = logging.getLogger("nexus")
    if _CONFIGURED:
        return logger
    logger.setLevel(level)
    handler = RotatingFileHandler(
        paths.logs_dir() / "nexus.log",
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    logger.addHandler(handler)
    _CONFIGURED = True
    return logger
