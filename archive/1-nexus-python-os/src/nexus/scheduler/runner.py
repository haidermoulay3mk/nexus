"""SchedulerService: runs the morning digest and any scheduled agents on cron.

Uses APScheduler's BackgroundScheduler. Building the service does not start it,
so tests can assert the configured jobs without a running loop. ``start()`` is
called by ``nexus scheduler start`` and blocks until interrupted.
"""

from __future__ import annotations

from nexus.kernel.types import AgentMode
from nexus.scheduler.digest import build_digest
from nexus.scheduler.reminders import run_reminder_check

DEFAULT_DIGEST_CRON = "30 7 * * *"  # 07:30 local time daily
DEFAULT_REMINDER_INTERVAL_MIN = 15  # how often to scan the calendar


class SchedulerService:
    def __init__(self, app, digest_cron: str = DEFAULT_DIGEST_CRON) -> None:
        from apscheduler.schedulers.background import BackgroundScheduler

        self.app = app
        self.digest_cron = digest_cron
        self.scheduler = BackgroundScheduler(timezone=app.config.timezone)
        self._configured = False

    def configure(self) -> list[str]:
        """Register jobs (digest + reminders + scheduled agents). Returns job ids."""
        from apscheduler.triggers.cron import CronTrigger
        from apscheduler.triggers.interval import IntervalTrigger

        self.scheduler.add_job(
            self._run_digest,
            CronTrigger.from_crontab(self.digest_cron, timezone=self.app.config.timezone),
            id="morning_digest",
            replace_existing=True,
        )
        self.scheduler.add_job(
            self._run_reminders,
            IntervalTrigger(minutes=DEFAULT_REMINDER_INTERVAL_MIN),
            id="calendar_reminders",
            replace_existing=True,
        )
        for spec in self.app.agents.specs():
            if spec.mode == AgentMode.SCHEDULED and spec.schedule:
                self.scheduler.add_job(
                    self._make_agent_job(spec.name),
                    CronTrigger.from_crontab(spec.schedule, timezone=self.app.config.timezone),
                    id=f"agent::{spec.name}",
                    replace_existing=True,
                )
        self._configured = True
        return [j.id for j in self.scheduler.get_jobs()]

    def _run_digest(self) -> str:
        text = build_digest(self.app)
        print("\n=== Nexus daily digest ===\n" + text + "\n")
        return text

    def _run_reminders(self) -> list[dict]:
        new = run_reminder_check(self.app)
        for r in new:
            print(f"[reminder] {r['summary']} in {r['minutes_until']} min")
        return new

    def _make_agent_job(self, agent_name: str):
        def _job():
            agent = self.app.agents.get(agent_name)
            agent.run("Run your scheduled task and report concisely.")
        return _job

    def start(self) -> None:
        if not self._configured:
            self.configure()
        self.scheduler.start()

    def shutdown(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
