"""Tools that expose the StudyRepository to the Study agent.

Each tool returns plain data/strings; the agent's model turns them into prose.
The functions are deterministic, so the study features work even when described
to a weak local model (or driven directly from the CLI).
"""

from __future__ import annotations

from nexus.domains.study import StudyRepository
from nexus.kernel.registry import Registry
from nexus.tools.base import Tool, ToolParam


def build_study_tools(repo: StudyRepository) -> Registry:
    reg: Registry = Registry("tool")

    def add_subject(name: str, board: str = "A-Level") -> str:
        repo.add_subject(name, board)
        return f"Added subject '{name}' ({board})."

    def add_topic(subject: str, name: str, chapter: str = "", confidence: int = 0) -> str:
        repo.add_topic(subject, name, chapter=chapter, confidence=int(confidence))
        return f"Tracked topic '{name}' under {subject} (confidence {confidence}/5)."

    def set_confidence(subject: str, topic: str, confidence: int) -> str:
        repo.set_confidence(subject, topic, int(confidence))
        return f"Updated {subject} → '{topic}' to confidence {confidence}/5."

    def log_paper(subject: str, score: float, max_score: float = 100,
                  paper: str = "", year: int = 0, season: str = "") -> str:
        r = repo.log_paper(
            subject, score, max_score, paper=paper,
            year=year or None, season=season,
        )
        label = f" ({paper})" if paper else ""
        return f"Logged {subject}{label}: {r.score}/{r.max_score} = {r.percentage}%."

    def weak_topics(threshold: int = 2) -> list[str]:
        rows = repo.weak_topics(int(threshold))
        return [f"{r['subject']}: {r['name']} ({r['confidence']}/5)" for r in rows] or \
            ["No weak topics recorded."]

    def strong_topics(threshold: int = 4) -> list[str]:
        rows = repo.strong_topics(int(threshold))
        return [f"{r['subject']}: {r['name']} ({r['confidence']}/5)" for r in rows] or \
            ["No strong topics recorded yet."]

    def progress(subject: str = "") -> dict:
        return repo.progress(subject or None)

    def recommendations() -> list[str]:
        return repo.recommendations()

    specs = [
        Tool("study_add_subject", "Add an A-Level subject", add_subject,
             [ToolParam("name"), ToolParam("board", required=False)]),
        Tool("study_add_topic", "Start tracking a topic/chapter for a subject", add_topic,
             [ToolParam("subject"), ToolParam("name"),
              ToolParam("chapter", required=False), ToolParam("confidence", "int", required=False)]),
        Tool("study_set_confidence", "Update confidence (0-5) for a topic", set_confidence,
             [ToolParam("subject"), ToolParam("topic"), ToolParam("confidence", "int")]),
        Tool("study_log_paper", "Record a past-paper score for a subject", log_paper,
             [ToolParam("subject"), ToolParam("score", "number"),
              ToolParam("max_score", "number", required=False),
              ToolParam("paper", required=False), ToolParam("year", "int", required=False),
              ToolParam("season", required=False)]),
        Tool("study_weak_topics", "List weak topics (low confidence)", weak_topics,
             [ToolParam("threshold", "int", required=False)]),
        Tool("study_strong_topics", "List strong topics (high confidence)", strong_topics,
             [ToolParam("threshold", "int", required=False)]),
        Tool("study_progress", "Summarize progress for one or all subjects", progress,
             [ToolParam("subject", required=False)]),
        Tool("study_recommendations", "Get prioritized study recommendations", recommendations),
    ]
    for t in specs:
        reg.register(t.name, t)
    return reg
