"""Tools exposing Tasks + Goals to the Productivity agent."""

from __future__ import annotations

from nexus.domains.productivity import ProductivityRepository
from nexus.kernel.registry import Registry
from nexus.tools.base import Tool, ToolParam

_PRIORITY = {1: "high", 2: "normal", 3: "low"}


def build_productivity_tools(repo: ProductivityRepository) -> Registry:
    reg: Registry = Registry("tool")

    def task_add(title: str, due: str = "", priority: int = 2, project: str = "") -> str:
        tid = repo.add_task(title, due=due or None, priority=int(priority), project=project)
        return f"Added task #{tid}: {title}" + (f" (due {due})" if due else "")

    def task_list(status: str = "open") -> list[str]:
        tasks = repo.list_tasks(status)
        if not tasks:
            return [f"No {status} tasks."]
        return [
            f"#{t.id} [{_PRIORITY.get(t.priority, '?')}] {t.title}"
            + (f" (due {t.due_date})" if t.due_date else "")
            for t in tasks
        ]

    def task_done(task_id: int) -> str:
        ok = repo.complete_task(int(task_id))
        return f"Completed task #{task_id}." if ok else f"No open task #{task_id}."

    def goal_add(title: str, description: str = "", target_date: str = "") -> str:
        gid = repo.add_goal(title, description=description, target_date=target_date or None)
        return f"Added goal #{gid}: {title}"

    def goal_list() -> list[str]:
        goals = repo.list_goals("active")
        if not goals:
            return ["No active goals."]
        return [f"#{g['id']} {g['title']} — {g['progress']}%"
                + (f" (by {g['target_date']})" if g['target_date'] else "") for g in goals]

    def goal_progress(goal_id: int, progress: int) -> str:
        p = repo.update_goal_progress(int(goal_id), int(progress))
        done = " (done!)" if p >= 100 else ""
        return f"Goal #{goal_id} now at {p}%{done}."

    tools = [
        Tool("task_add", "Add a to-do task (optional ISO due date, priority 1-3)", task_add,
             [ToolParam("title"), ToolParam("due", required=False),
              ToolParam("priority", "int", required=False), ToolParam("project", required=False)]),
        Tool("task_list", "List tasks (status open/done)", task_list,
             [ToolParam("status", required=False)]),
        Tool("task_done", "Mark a task complete by id", task_done, [ToolParam("task_id", "int")]),
        Tool("goal_add", "Add a longer-term goal", goal_add,
             [ToolParam("title"), ToolParam("description", required=False),
              ToolParam("target_date", required=False)]),
        Tool("goal_list", "List active goals with progress", goal_list),
        Tool("goal_progress", "Set a goal's progress percent (0-100)", goal_progress,
             [ToolParam("goal_id", "int"), ToolParam("progress", "int")]),
    ]
    for t in tools:
        reg.register(t.name, t)
    return reg
