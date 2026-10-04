"""Know when to stop — recognize a sign-off and let the conversation end.

A natural person lets "okay, thanks" be the end. Most assistants manufacture one more
reply and always grab the last word. This module is the small, deterministic check that
runs the instant a transcript comes back — *before* any model call — and decides whether
the turn is just a sign-off. If it is, Nexus stays quiet: no model call, no tokens, no
spoken reply.

The failure modes are NOT symmetric. Going silent when the user wanted a reply reads as
broken; replying to a borderline goodbye is merely the old, mild behavior. So every rule
here biases toward *replying* — a sign-off has to clear several hurdles, and any sign the
user wants something back vetoes it.

Tuning is meant to be a one-line change: when a real goodbye slips through, or it goes
quiet when it shouldn't have, move a phrase into the right list below. Capture the misses
in MISSES so the behavior stays documented.
"""

from __future__ import annotations

import re

# --- thresholds (tunable) ---------------------------------------------------

MAX_SIGNOFF_WORDS = 7      # real goodbyes are brief; longer almost always leads into something
SHORT_UTTERANCE_WORDS = 3  # a bare positive ("great", "cool") only ends things when this short

# --- evidence FOR a sign-off ------------------------------------------------

# Explicit farewells — the strongest evidence. These can end even a conversation where
# Nexus just asked a question (a farewell trumps an open question).
FAREWELLS = (
    "bye", "goodbye", "good night", "goodnight", "see you", "see ya", "talk later",
    "talk soon", "catch you later", "that's all", "thats all", "that'll be all",
    "thatll be all", "that's it", "thats it", "gotta go", "i'm done", "im done",
    "i'm good", "im good", "we're good", "were good", "all good", "that's everything",
    "thats everything",
)

# Thanks / acknowledgement — a sign-off when nothing vetoes it.
THANKS = (
    "thanks", "thank you", "got it", "will do", "sounds good", "appreciate it",
    "cheers", "right on", "good to know", "makes sense", "perfect thanks", "nice one",
    "fair enough",
)

# Bare positives — only a sign-off in a very short utterance; in a longer sentence they're
# almost always leading into something ("great, so the next step is...").
BARE_POSITIVES = (
    "great", "cool", "nice", "awesome", "perfect", "ok", "okay", "okey", "alright",
    "fine", "sweet", "gotcha", "yep", "yeah", "yup", "good", "excellent", "wonderful",
    "lovely", "brilliant",
)

# The user committing to do the thing themselves ("great, I'll send that") — a sign-off,
# even though it mentions an action, because they're taking it off Nexus's plate.
SELF_COMMITMENTS = (
    "i'll", "i will", "i'm going to", "im going to", "i'm gonna", "im gonna",
    "let me handle", "i got it", "i've got it", "ive got it", "i'll handle",
    "i'll do", "i'll take", "i'll sort",
)

# --- evidence AGAINST (vetoes) ----------------------------------------------

# A question or request wants a reply.
QUESTION_MARKERS = (
    "can you", "could you", "would you", "will you", "how about", "what about",
    "one more thing", "do you", "are you", "is there", "is it", "what's", "whats",
    "how do", "how can", "tell me", "show me", "give me", "let me know", "remind me",
    "what time", "any chance",
)
# Leading interrogatives (as the first word) signal a question too.
QUESTION_WORDS = frozenset(
    "what how why when where who which whose whom is are do does did can could would should will".split()
)

# An imperative aimed at Nexus wants action — unless it's a self-commitment (above).
COMMAND_VERBS = frozenset(
    "send delete remove add create schedule remind set change update draft write call "
    "email text message make find search check open play cancel book buy pay move rename "
    "turn start tell give show".split()
)

# Complaints/negatives want engagement, not silence — even if "thanks" is present
# ("thanks for nothing, this is broken").
COMPLAINTS = (
    "broken", "not working", "doesn't work", "doesnt work", "didn't work", "didnt work",
    "for nothing", "useless", "wrong", "that's wrong", "thats wrong", "still not",
)

# Misses captured from real use — move the phrase into the right list above, then add a
# line here so we remember why. (label, expected) pairs live in the tests.
MISSES: list[str] = []


def _normalize(text: str) -> str:
    """Lowercase; drop punctuation except the apostrophes that carry meaning (i'll, we're)."""
    low = text.lower().strip()
    low = re.sub(r"[^\w'\s]", " ", low)   # keep apostrophes, blank out other punctuation
    return re.sub(r"\s+", " ", low).strip()


def _contains_any(norm: str, phrases) -> bool:
    # word-boundary-ish match so "ok" doesn't fire inside "okay" only when we mean it; but
    # phrases here are whole words/expressions, so a padded search is enough.
    padded = f" {norm} "
    return any(f" {p} " in padded for p in phrases)


def _has_farewell(norm: str) -> bool:
    return _contains_any(norm, FAREWELLS)


def _has_command(words: list[str]) -> bool:
    return any(w in COMMAND_VERBS for w in words)


def _is_self_commitment(norm: str) -> bool:
    return _contains_any(norm, SELF_COMMITMENTS)


def _is_question(raw: str, norm: str, words: list[str]) -> bool:
    if "?" in raw:
        return True
    if words and words[0] in QUESTION_WORDS:
        return True
    return _contains_any(norm, QUESTION_MARKERS)


def is_sign_off(text: str, *, is_first_turn: bool = False, assistant_asked: bool = False) -> bool:
    """True only when `text` is clearly just a sign-off and nothing wants a reply back.

    - `is_first_turn`: never swallow the very first thing said — Nexus has to have been part
      of the conversation to end it.
    - `assistant_asked`: if Nexus just asked a question, a bare "yeah"/"thanks" is an ANSWER,
      not a goodbye — only an explicit farewell ends it there.
    """
    raw = (text or "").strip()
    if not raw or is_first_turn:
        return False

    norm = _normalize(raw)
    words = norm.split()
    n = len(words)
    if n == 0 or n > MAX_SIGNOFF_WORDS:
        return False

    # Vetoes — any of these means "reply normally".
    if _is_question(raw, norm, words):
        return False
    if _contains_any(norm, COMPLAINTS):
        return False
    if _has_command(words) and not _is_self_commitment(norm):
        return False

    # If Nexus just asked something, only an explicit farewell counts as ending it.
    if assistant_asked:
        return _has_farewell(norm)

    # Otherwise, require real sign-off evidence.
    if _has_farewell(norm) or _contains_any(norm, THANKS):
        return True
    if _is_self_commitment(norm) and (_contains_any(norm, BARE_POSITIVES) or n <= SHORT_UTTERANCE_WORDS):
        return True  # "great, I'll do that" / "I'll handle it"
    if n <= SHORT_UTTERANCE_WORDS and all(w in BARE_POSITIVES for w in words):
        return True  # bare "great", "cool", "okay" — only when the whole utterance is tiny
    return False
