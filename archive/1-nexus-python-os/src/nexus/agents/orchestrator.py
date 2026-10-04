"""Orchestrator: routes a user request to the right specialist agent.

Two-stage routing, cheap first:
1. Keyword scoring against each agent's name/description/keywords — deterministic,
   instant, works with no model running.
2. If keyword scoring is ambiguous (tie or no signal) and a router is available,
   ask the FAST model to pick from the candidate list.

This keeps everyday routing free and offline, using the model only when needed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from nexus.kernel.types import ChatMessage, ModelTier


@dataclass
class RouteCandidate:
    name: str
    description: str = ""
    keywords: list[str] = field(default_factory=list)


def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _stem_match(a: str, b: str, n: int = 4) -> bool:
    """Loose match: equal, or share a prefix of >= n chars (study ~ studies)."""
    if a == b:
        return True
    return len(a) >= n and len(b) >= n and a[:n] == b[:n]


class Orchestrator:
    def __init__(self, candidates: list[RouteCandidate], router: object | None = None) -> None:
        self.candidates = candidates
        self.router = router

    # Higher number = preferred when keyword scores tie. Study is the primary
    # capability; the general assistant is the lowest-priority catch-all.
    _PRIORITY = {"study": 5, "productivity": 4, "email": 3, "calendar": 3, "assistant": 0}

    # Strong action intents win regardless of other words in the sentence
    # (e.g. "remind me to finish physics coursework" is a task, not a study query).
    _INTENT = [
        (re.compile(r"\b(remind me|remember to|don'?t forget|add (a )?task|"
                    r"i have to|i need to|what (do i have |should i )?(to )?do|"
                    r"on my (plate|to ?do))\b", re.I), "productivity"),
        (re.compile(r"\b(send (an? )?(e-?mail|message|mail)|reply to|email (him|her|them|my|to))\b",
                    re.I), "email"),
    ]

    def route(self, user_input: str) -> str:
        """Pick an agent from keywords only — deterministic and instant.

        No model call: a tiny local model both adds 30–60s of latency and tends
        to mis-route. Ties break by priority; no keyword signal -> general agent.
        """
        if not self.candidates:
            raise ValueError("no agents registered to route to")
        if len(self.candidates) == 1:
            return self.candidates[0].name

        names = {c.name for c in self.candidates}
        for pattern, target in self._INTENT:
            if target in names and pattern.search(user_input):
                return target

        scores = self._keyword_scores(user_input)
        ranked = sorted(
            scores.items(),
            key=lambda kv: (kv[1], self._PRIORITY.get(kv[0], 1)),
            reverse=True,
        )
        top_name, top_score = ranked[0]
        if top_score == 0:
            return self._default_agent()
        return top_name

    def _default_agent(self) -> str:
        for name in ("assistant", "general"):
            if any(c.name == name for c in self.candidates):
                return name
        return self.candidates[0].name

    def _keyword_scores(self, user_input: str) -> dict[str, int]:
        """Score each agent by curated-keyword hits only.

        Matching against free-form description text proved too noisy (common
        words like "tells" stem-matched "tell"), so routing relies solely on the
        explicit ``keywords`` each agent declares, plus its own name.
        """
        tokens = _tokenize(user_input)
        scores: dict[str, int] = {}
        for c in self.candidates:
            vocab = {k.lower() for k in c.keywords} | {c.name.lower()}
            score = sum(
                1 for tok in tokens if any(_stem_match(tok, v) for v in vocab)
            )
            scores[c.name] = score
        return scores

    def _model_route(self, user_input: str) -> str | None:
        menu = "\n".join(f"- {c.name}: {c.description}" for c in self.candidates)
        names = {c.name for c in self.candidates}
        prompt = (
            "Choose the single best agent to handle the user's request.\n"
            f"Agents:\n{menu}\n\n"
            f'User: "{user_input}"\n\n'
            "Reply with ONLY the agent name, nothing else."
        )
        try:
            raw = self.router.complete(
                [ChatMessage(role="user", content=prompt)], tier=ModelTier.FAST
            )
        except Exception:  # noqa: BLE001 - routing must not crash the request
            return None
        guess = raw.strip().split()[0].strip(".,:`\"'").lower() if raw.strip() else ""
        for n in names:
            if n.lower() == guess or n.lower() in raw.lower():
                return n
        return None
