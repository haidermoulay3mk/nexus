"""Study domain repository, tools, and a scripted agent run."""

from __future__ import annotations

import pytest

from nexus.agents.base import AgentContext, BaseAgent
from nexus.domains.study import StudyRepository
from nexus.kernel.types import AgentSpec, ModelTier
from nexus.memory.db import get_db
from nexus.tools.study_tools import build_study_tools


@pytest.fixture
def repo():
    conn = get_db(":memory:")
    r = StudyRepository(conn)
    r.seed_default_subjects()
    return r


def test_seed_subjects(repo):
    names = [s["name"] for s in repo.list_subjects()]
    assert names == ["Computer Science", "Mathematics", "Physics"]


def test_topics_and_weak_strong(repo):
    repo.add_topic("Physics", "Projectile Motion", confidence=1)
    repo.add_topic("Physics", "Circular Motion", confidence=5)
    repo.add_topic("Mathematics", "Integration", confidence=2)

    weak = repo.weak_topics(threshold=2)
    weak_names = {r["name"] for r in weak}
    assert "Projectile Motion" in weak_names
    assert "Integration" in weak_names
    assert "Circular Motion" not in weak_names

    strong = repo.strong_topics(threshold=4)
    assert {r["name"] for r in strong} == {"Circular Motion"}


def test_set_confidence_updates_status(repo):
    repo.add_topic("Computer Science", "Big-O", confidence=1)
    repo.set_confidence("Computer Science", "Big-O", 4)
    rows = repo.list_topics("Computer Science")
    assert rows[0]["confidence"] == 4
    assert rows[0]["status"] == "done"


def test_log_paper_percentage(repo):
    r = repo.log_paper("Physics", 54, 75, paper="Paper 1 2022")
    assert r.percentage == 72.0
    papers = repo.list_papers("Physics")
    assert len(papers) == 1


def test_progress_rollup(repo):
    repo.add_topic("Physics", "A", confidence=4, status="done")
    repo.add_topic("Physics", "B", confidence=1, status="in_progress")
    repo.log_paper("Physics", 40, 100)
    repo.log_paper("Physics", 60, 100)
    prog = repo.progress("Physics")["Physics"]
    assert prog["topics_total"] == 2
    assert prog["topics_done"] == 1
    assert prog["completion_pct"] == 50.0
    assert prog["avg_paper_pct"] == 50.0


def test_recommendations_flag_weak(repo):
    repo.add_topic("Mathematics", "Vectors", confidence=1)
    recs = repo.recommendations()
    assert any("Vectors" in r for r in recs)


def test_unknown_subject_raises(repo):
    with pytest.raises(KeyError):
        repo.add_topic("Chemistry", "Atoms")


# --- tools + agent ------------------------------------------------------------

def test_study_tools_log_paper(repo):
    tools = build_study_tools(repo)
    result = tools.get("study_log_paper").run(subject="Physics", score=45, max_score=60)
    assert result.ok
    assert "75.0%" in result.output


class _ScriptedRouter:
    def __init__(self, replies):
        self.replies = list(replies)

    def complete(self, messages, tier=ModelTier.BALANCED, **kw):
        return self.replies.pop(0) if self.replies else '{"action":"final","answer":"ok"}'


def test_study_agent_logs_paper_then_replies(repo):
    tools = build_study_tools(repo)
    router = _ScriptedRouter([
        '{"action":"tool","tool":"study_log_paper","args":{"subject":"Physics","score":45,"max_score":60}}',
        '{"action":"final","answer":"Logged your Physics paper at 75%. Solid work."}',
    ])
    ctx = AgentContext(router=router, tools=tools, memory=None)
    spec = AgentSpec(name="study", tools=tools.names(), model_tier=ModelTier.BALANCED)
    agent = BaseAgent(spec, ctx)

    out = agent.run("I scored 45 out of 60 on a physics paper")
    assert "75%" in out
    # And it actually persisted:
    assert len(repo.list_papers("Physics")) == 1
