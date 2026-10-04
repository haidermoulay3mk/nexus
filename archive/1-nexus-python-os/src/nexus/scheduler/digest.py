"""The daily digest: a single morning briefing composed from study, calendar,
and email. Degrades gracefully — the study section always works offline; the
calendar/email sections appear only when Google is connected.

The result is stored in memory (namespace ``digest``) so the dashboard and
history can show it, and returned for printing.
"""

from __future__ import annotations


def _format_tool_output(output) -> str:
    if isinstance(output, list):
        return "\n".join(f"  {line}" for line in output)
    return str(output)


def build_digest(app) -> str:
    """Compose today's briefing from the app's domains and tools."""
    sections: list[str] = []

    # --- Study (always available, offline) ---
    recs = app.study.recommendations()
    if recs:
        sections.append("Study focus:\n" + "\n".join(f"  - {r}" for r in recs))

    # --- Tasks (offline) ---
    productivity = getattr(app, "productivity", None)
    if productivity is not None:
        open_tasks = productivity.list_tasks("open")
        if open_tasks:
            lines = "\n".join(f"  - {t.title}" + (f" (due {t.due_date})" if t.due_date else "")
                              for t in open_tasks[:5])
            sections.append(f"Open tasks ({len(open_tasks)}):\n{lines}")

    # --- Calendar (only if Google connected) ---
    cal = app.tools.try_get("calendar_upcoming")
    if cal is not None:
        res = cal.run(days=1)
        if res.ok:
            sections.append("Today's calendar:\n" + _format_tool_output(res.output))

    # --- Email (only if Google connected) ---
    em = app.tools.try_get("email_summary")
    if em is not None:
        res = em.run()
        if res.ok:
            sections.append("Inbox:\n" + _format_tool_output(res.output))

    text = "\n\n".join(sections) if sections else "Nothing to report yet."
    app.memory.store(text, title="Daily digest", namespace="digest", kind="digest", embed=False)
    return text
