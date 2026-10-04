"""Filesystem layout for Nexus.

Two roots:

* The **package config** (``config/`` at the repo root) ships default agent
  descriptors and prompts. Read-only defaults.
* The **runtime home** (``NEXUS_HOME`` or ``%LOCALAPPDATA%\\Nexus``) holds all
  user data: the SQLite DB, vector index, logs, OAuth tokens, and backups.
  Nothing here is ever committed to source control.
"""

from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def home() -> Path:
    """Return the runtime data directory, creating it if necessary.

    Resolution order:
    1. ``NEXUS_HOME`` environment variable, if set.
    2. ``%LOCALAPPDATA%\\Nexus`` on Windows.
    3. ``~/.nexus`` everywhere else (or if LOCALAPPDATA is unset).
    """
    override = os.environ.get("NEXUS_HOME")
    if override:
        root = Path(override)
    else:
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            root = Path(local_appdata) / "Nexus"
        else:
            root = Path.home() / ".nexus"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _sub(name: str) -> Path:
    p = home() / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    """SQLite system-of-record file."""
    return home() / "nexus.db"


def config_dir() -> Path:
    """User config overrides (config.toml, custom agent YAML)."""
    return _sub("config")


def logs_dir() -> Path:
    return _sub("logs")


def credentials_dir() -> Path:
    """OAuth token files. Permissions are tightened by the credentials module."""
    return _sub("credentials")


def backups_dir() -> Path:
    return _sub("backups")


@lru_cache(maxsize=1)
def package_root() -> Path:
    """Directory that contains ``config/`` and ``assets/``.

    When frozen by PyInstaller, bundled data lives under ``sys._MEIPASS``.
    Otherwise it's the repo root (paths.py -> kernel -> nexus -> src -> root).
    """
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[3]


def package_config_dir() -> Path:
    """Default (shipped) config directory containing agents/ and prompts/."""
    return package_root() / "config"


def default_agents_dir() -> Path:
    return package_config_dir() / "agents"


def default_prompts_dir() -> Path:
    return package_config_dir() / "prompts"
