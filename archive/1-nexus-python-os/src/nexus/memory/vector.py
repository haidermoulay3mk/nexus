"""Vector encoding + brute-force cosine search.

For a single user the semantic corpus is small (thousands of notes), so an
in-memory NumPy cosine scan is instant and needs no native vector extension.
Embeddings are stored as float32 bytes in the ``memories.embedding`` column.
If the corpus ever grows large, swap this module for sqlite-vec without touching
callers.
"""

from __future__ import annotations

import numpy as np


def to_blob(vector: list[float]) -> bytes:
    return np.asarray(vector, dtype=np.float32).tobytes()


def from_blob(blob: bytes | None) -> np.ndarray | None:
    if not blob:
        return None
    return np.frombuffer(blob, dtype=np.float32)


def cosine_search(
    query: list[float],
    candidates: list[tuple[int, bytes | None]],
    k: int = 5,
) -> list[tuple[int, float]]:
    """Rank ``(id, embedding_blob)`` candidates against ``query``.

    Returns up to ``k`` ``(id, score)`` pairs sorted high-to-low. Candidates with
    no embedding are skipped. Scores are cosine similarity in [-1, 1].
    """
    q = np.asarray(query, dtype=np.float32)
    q_norm = np.linalg.norm(q)
    if q_norm == 0:
        return []
    q = q / q_norm

    scored: list[tuple[int, float]] = []
    for row_id, blob in candidates:
        vec = from_blob(blob)
        if vec is None or vec.size != q.size:
            continue
        v_norm = np.linalg.norm(vec)
        if v_norm == 0:
            continue
        score = float(np.dot(q, vec / v_norm))
        scored.append((row_id, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:k]
