"""AgentManager: turns YAML descriptors into runnable agents.

This is the heart of "extend by configuration": dropping a ``*.yaml`` into
``config/agents`` (shipped defaults) or ``<NEXUS_HOME>/config/agents`` (user
overrides) registers a new agent. A custom Python handler is only needed when an
agent wants behavior beyond the generic ReAct loop.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import yaml

from nexus.kernel import paths
from nexus.kernel.registry import Registry
from nexus.kernel.types import AgentSpec
from nexus.agents.base import AgentContext, BaseAgent
from nexus.agents.orchestrator import Orchestrator, RouteCandidate


class AgentManager:
    def __init__(self, tools: Registry, router: object, memory: object | None = None) -> None:
        self.ctx = AgentContext(router=router, tools=tools, memory=memory)
        self._specs: dict[str, AgentSpec] = {}
        self._agents: dict[str, BaseAgent] = {}

    # --- loading --------------------------------------------------------------

    def load_specs(self, *extra_dirs: Path) -> list[AgentSpec]:
        """Read every agent YAML. Later dirs override earlier ones by name."""
        search_dirs = [paths.default_agents_dir(), paths.config_dir() / "agents", *extra_dirs]
        specs: dict[str, AgentSpec] = {}
        for d in search_dirs:
            if not d.exists():
                continue
            for f in sorted(d.glob("*.yaml")) + sorted(d.glob("*.yml")):
                data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
                spec = AgentSpec.model_validate(data)
                specs[spec.name] = spec
        self._specs = {name: s for name, s in specs.items() if s.enabled}
        return list(self._specs.values())

    def build(self) -> None:
        """Instantiate an agent object for each loaded spec."""
        self._agents = {}
        for name, spec in self._specs.items():
            prompt = self._resolve_prompt(spec)
            agent = self._instantiate(spec, prompt)
            self._agents[name] = agent

    def _instantiate(self, spec: AgentSpec, prompt: str) -> BaseAgent:
        if spec.handler:
            module_name, _, attr = spec.handler.rpartition(".")
            cls = getattr(importlib.import_module(module_name), attr)
            return cls(spec, self.ctx, prompt)
        return BaseAgent(spec, self.ctx, prompt)

    def _resolve_prompt(self, spec: AgentSpec) -> str:
        sp = spec.system_prompt
        if not sp:
            return ""
        # Treat as a file path if it looks like one or exists.
        for base in (paths.default_prompts_dir(), paths.config_dir() / "prompts"):
            candidate = base / sp
            if candidate.exists():
                return candidate.read_text(encoding="utf-8")
        p = Path(sp)
        if p.exists():
            return p.read_text(encoding="utf-8")
        return sp  # inline prompt text

    # --- access ---------------------------------------------------------------

    def names(self) -> list[str]:
        return sorted(self._agents)

    def specs(self) -> list[AgentSpec]:
        return list(self._specs.values())

    def get(self, name: str) -> BaseAgent:
        return self._agents[name]

    def orchestrator(self) -> Orchestrator:
        candidates = [
            RouteCandidate(
                name=s.name,
                description=s.description,
                keywords=s.keywords or s.tools,  # curated hints, falling back to tool names
            )
            for s in self._specs.values()
        ]
        return Orchestrator(candidates, router=self.ctx.router)

    def handle(self, user_input: str, *, extra_preamble: str = "") -> tuple[str, str]:
        """Route then run. Returns (agent_name, answer)."""
        if not self._agents:
            raise RuntimeError("no agents built; call load_specs() then build()")
        name = self.orchestrator().route(user_input)
        agent = self._agents.get(name) or next(iter(self._agents.values()))
        return name, agent.run(user_input, extra_preamble=extra_preamble)
