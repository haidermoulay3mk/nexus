"""Memory service: store, semantic search, keyword fallback, prefs, report."""

from __future__ import annotations

from nexus.memory.service import MemoryService


def test_store_and_get(memory):
    rid = memory.store("Newton's second law F=ma", title="Mechanics", namespace="study")
    assert rid > 0
    records = memory.get(namespace="study")
    assert len(records) == 1
    assert records[0].title == "Mechanics"
    assert "F=ma" in records[0].content


def test_semantic_search_ranks_relevant_first(memory):
    memory.store("Physics revision: projectile motion and energy", title="Physics")
    memory.store("Calendar planning for the week ahead", title="Calendar")
    memory.store("German vocabulary: die Katze, der Hund", title="German")

    results = memory.search("physics physics", k=3)
    assert results, "expected at least one result"
    top_record, top_score = results[0]
    # The fake embedder weights the word 'physics', so the physics note wins.
    assert "Physics" in top_record.title


def test_keyword_fallback_without_embedder():
    svc = MemoryService(db_file=":memory:", embedder=None)
    svc.store("Computer Science: Big-O notation and complexity", title="CS")
    svc.store("Workout: 5x5 squats", title="Fitness")
    results = svc.search("Big-O", k=5)
    assert len(results) == 1
    assert results[0][0].title == "CS"


def test_preferences_roundtrip(memory):
    assert memory.get_pref("missing") is None
    memory.set_pref("name", "Sam")
    assert memory.get_pref("name") == "Sam"
    memory.set_pref("name", "H")  # upsert
    assert memory.get_pref("name") == "H"


def test_report_counts(memory):
    memory.store("a", namespace="study", kind="note")
    memory.store("b", namespace="study", kind="paper")
    memory.store("c", namespace="health", kind="workout")
    rep = memory.report()
    assert rep["total"] == 3
    assert rep["by_namespace"]["study"] == 2
    assert rep["by_kind"]["workout"] == 1


def test_summarize_without_summarizer_concatenates(memory):
    memory.store("first fact", title="A")
    memory.store("second fact", title="B")
    out = memory.summarize()
    assert "first fact" in out and "second fact" in out


def test_summarize_uses_injected_summarizer():
    svc = MemoryService(
        db_file=":memory:",
        embedder=None,
        summarizer=lambda text: f"SUMMARY({len(text)} chars)",
    )
    svc.store("something to condense", title="X")
    out = svc.summarize()
    assert out.startswith("SUMMARY(")
