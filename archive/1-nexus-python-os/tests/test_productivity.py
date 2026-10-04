"""Tasks + Goals repository."""

from __future__ import annotations

import pytest

from nexus.domains.productivity import ProductivityRepository
from nexus.memory.db import get_db


@pytest.fixture
def repo():
    return ProductivityRepository(get_db(":memory:"))


def test_add_and_list_tasks_ordered_by_priority(repo):
    repo.add_task("Low thing", priority=3)
    repo.add_task("Urgent thing", priority=1)
    repo.add_task("Normal thing", priority=2)
    tasks = repo.list_tasks("open")
    assert [t.title for t in tasks] == ["Urgent thing", "Normal thing", "Low thing"]


def test_complete_task(repo):
    tid = repo.add_task("Finish lab report")
    assert repo.complete_task(tid) is True
    assert repo.list_tasks("open") == []
    assert repo.complete_task(tid) is False  # already done


def test_goal_progress_completes_at_100(repo):
    gid = repo.add_goal("Finish Physics revision", target_date="2026-07-01")
    repo.update_goal_progress(gid, 50)
    assert len(repo.list_goals("active")) == 1
    repo.update_goal_progress(gid, 100)
    assert repo.list_goals("active") == []
    assert len(repo.list_goals("done")) == 1


def test_summary(repo):
    repo.add_task("A", due="2026-06-25")
    repo.add_task("B")
    repo.add_goal("Goal 1")
    s = repo.summary()
    assert s["open_tasks"] == 2
    assert s["active_goals"] == 1
    assert s["next_due"] == "A"


def test_priority_clamped(repo):
    tid = repo.add_task("x", priority=9)
    t = repo.list_tasks("open")[0]
    assert t.priority == 3
