"""Composition root: wires config, models, memory, domains, tools, and agents
into a single ``NexusApp``. The CLI, dashboard, and scheduler all build on this.

Constructing the app never requires Ollama to be running — model calls fail
gracefully at use time, so study/memory/doctor work offline.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from nexus.agents.manager import AgentManager
from nexus.domains.productivity import ProductivityRepository
from nexus.domains.study import StudyRepository
from nexus.kernel.config import NexusConfig, get_config
from nexus.kernel.registry import Registry
from nexus.kernel.types import ChatMessage, ModelTier
from nexus.memory.db import get_db
from nexus.memory.service import MemoryService
from nexus.models.embeddings import Embedder
from nexus.models.router import ModelRouter
from nexus.tools.mail_tools import build_mail_tools
from nexus.tools.memory_tools import build_memory_tools
from nexus.tools.productivity_tools import build_productivity_tools
from nexus.tools.study_tools import build_study_tools


class NexusApp:
    def __init__(self, *, db_file: Path | str | None = None, config: NexusConfig | None = None) -> None:
        self.config = config or get_config()
        self.db: sqlite3.Connection = get_db(db_file)
        self.router = ModelRouter(self.config)
        self.memory = MemoryService(
            self.db,
            embedder=self._make_embedder(),
            summarizer=self._make_summarizer(),
        )
        self.study = StudyRepository(self.db)
        self.productivity = ProductivityRepository(self.db)
        self.tools = self._build_tools()
        self.agents = AgentManager(self.tools, self.router, self.memory)
        self.agents.load_specs()
        self.agents.build()

    # --- assembly -------------------------------------------------------------

    def _make_embedder(self):
        """Embed via Ollama if reachable; otherwise None so memory uses keyword
        search. MemoryService already traps per-call failures, so we can hand it
        a live embedder safely."""
        try:
            return Embedder(self.config)
        except Exception:  # noqa: BLE001
            return None

    def _make_summarizer(self):
        def _summarize(text: str) -> str:
            try:
                return self.router.complete(
                    [
                        ChatMessage(role="system",
                                    content="Summarize the following concisely in 3-5 bullets."),
                        ChatMessage(role="user", content=text),
                    ],
                    tier=ModelTier.BALANCED,
                )
            except Exception:  # noqa: BLE001 - offline: return the raw text
                return text
        return _summarize

    def _build_tools(self) -> Registry:
        combined: Registry = Registry("tool")
        sources = (
            build_study_tools(self.study),
            build_productivity_tools(self.productivity),
            build_memory_tools(self.memory),
            build_mail_tools(self.router),  # email (IMAP) + calendar (iCal), lazy
        )
        for source in sources:
            for name, t in source.all().items():
                combined.register(name, t, overwrite=True)
        return combined

    # --- high-level API -------------------------------------------------------

    def ask(self, text: str, *, extra_preamble: str = "") -> tuple[str, str]:
        """Route ``text`` to the best agent and return (agent_name, answer)."""
        return self.agents.handle(text, extra_preamble=extra_preamble)

    def ask_voice(self, text: str) -> tuple[str, str]:
        """Voice-mode ask with the optional spoken-persona overlay."""
        preamble = self.config.voice.persona_preamble if self.config.voice.persona else ""
        return self.ask(text, extra_preamble=preamble)

    def set_gemini_key(self, key: str) -> str:
        """Save a Gemini key and switch the model backend live. Returns provider."""
        self.router.set_gemini_key(key)
        return self.router.provider

    def doctor(self) -> dict:
        """Health snapshot for `nexus doctor` and the setup wizard."""
        from nexus.kernel import paths

        health = self.router.health()
        health["db_path"] = str(paths.db_path())
        health["home"] = str(paths.home())
        health["agents"] = self.agents.names()
        health["tools"] = self.tools.names()
        return health
