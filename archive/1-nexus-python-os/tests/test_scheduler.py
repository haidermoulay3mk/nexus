"""Daily digest builder + scheduler job configuration (offline)."""

from __future__ import annotations

from nexus.app import NexusApp
from nexus.scheduler.digest import build_digest
from nexus.scheduler.runner import SchedulerService


def _app_with_study():
    app = NexusApp(db_file=":memory:")
    app.study.seed_default_subjects()
    app.study.add_topic("Physics", "Projectile Motion", confidence=1)
    return app


def test_build_digest_includes_study_offline():
    app = _app_with_study()
    text = build_digest(app)
    assert "Study focus" in text
    assert "Projectile Motion" in text
    # It should not include calendar/email sections when Google isn't connected.
    assert "Today's calendar" not in text


def test_digest_is_persisted_to_memory():
    app = _app_with_study()
    build_digest(app)
    digests = app.memory.get(namespace="digest")
    assert len(digests) == 1
    assert digests[0].title == "Daily digest"


def test_scheduler_configures_digest_job():
    app = _app_with_study()
    svc = SchedulerService(app, digest_cron="0 8 * * *")
    job_ids = svc.configure()
    assert "morning_digest" in job_ids
    # Not started, so nothing is running.
    assert not svc.scheduler.running
