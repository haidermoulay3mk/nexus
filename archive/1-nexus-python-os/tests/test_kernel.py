"""Kernel: paths, config defaults + env overrides, registry, event bus."""

from __future__ import annotations

import os

from nexus.kernel.events import EventBus
from nexus.kernel.registry import Registry
from nexus.kernel.types import AgentMode, AgentSpec, ModelTier


def test_home_is_isolated_and_created():
    from nexus.kernel import paths

    h = paths.home()
    assert h.exists()
    # conftest pointed NEXUS_HOME at a temp dir
    assert "nexus_home" in str(h)
    assert paths.config_dir().exists()
    assert paths.logs_dir().exists()


def test_config_defaults_and_tiers():
    from nexus.kernel.config import NexusConfig

    cfg = NexusConfig()
    assert cfg.models.model_for(ModelTier.BALANCED) == "qwen2.5:3b-instruct"
    assert cfg.models.model_for(ModelTier.FAST) == "llama3.2:1b"
    # unknown tier falls back to balanced
    assert cfg.models.model_for("nonsense") == "qwen2.5:3b-instruct"


def test_config_env_override(monkeypatch):
    from nexus.kernel.config import NexusConfig

    monkeypatch.setenv("NEXUS_MODEL_BALANCED", "my-model:latest")
    monkeypatch.setenv("OLLAMA_HOST", "http://example:1234")
    cfg = NexusConfig().apply_env_overrides()
    assert cfg.models.model_for(ModelTier.BALANCED) == "my-model:latest"
    assert cfg.models.ollama_host == "http://example:1234"


def test_registry_register_get_and_duplicate():
    reg: Registry[int] = Registry("tool")
    reg.register("a", 1)
    assert reg.get("a") == 1
    assert reg.has("a")
    assert "a" in reg
    assert reg.try_get("missing") is None
    assert reg.names() == ["a"]

    try:
        reg.register("a", 2)
        raise AssertionError("expected duplicate registration to fail")
    except ValueError:
        pass
    reg.register("a", 2, overwrite=True)
    assert reg.get("a") == 2


def test_event_bus_pub_sub_and_unsubscribe():
    bus = EventBus()
    seen = []
    unsub = bus.subscribe("ping", lambda p: seen.append(p))
    bus.publish("ping", 42)
    assert seen == [42]
    unsub()
    bus.publish("ping", 99)
    assert seen == [42]  # no longer receiving


def test_event_bus_isolates_handler_errors():
    bus = EventBus()
    seen = []

    def bad(_):
        raise RuntimeError("boom")

    bus.subscribe("e", bad)
    bus.subscribe("e", lambda p: seen.append(p))
    bus.publish("e", "ok")
    assert seen == ["ok"]  # good handler still ran


def test_agent_spec_defaults():
    spec = AgentSpec(name="study", tools=["study_db"])
    assert spec.mode is AgentMode.ON_DEMAND
    assert spec.model_tier is ModelTier.BALANCED
    assert spec.enabled is True
    assert spec.max_steps == 8
