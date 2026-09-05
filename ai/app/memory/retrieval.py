"""Deterministic hybrid scoring for local memory retrieval."""

from __future__ import annotations

import math
import re
import time
from difflib import SequenceMatcher
from typing import Any

_ALIASES = {
    "bug": "程序错误",
    "报错": "程序错误",
    "错误": "程序错误",
    "爱吃": "喜欢",
    "爱好": "喜欢",
    "喜好": "喜欢",
    "烦": "烦躁",
    "记得": "记忆",
}


def normalize(text: str) -> str:
    value = str(text or "").lower()
    for source, target in _ALIASES.items():
        value = value.replace(source, target)
    return re.sub(r"[\W_]+", "", value, flags=re.UNICODE)


def _ngrams(value: str, size: int = 2) -> set[str]:
    if len(value) < size:
        return {value} if value else set()
    return {value[i:i + size] for i in range(len(value) - size + 1)}


def document_frequencies(candidates: list[dict[str, Any]]) -> dict[str, int]:
    """Per-candidate-set bigram document frequencies (incl. tags).

    Computed once per search call over the whole candidate list; lets the
    lexical channel down-weight high-frequency grams ("喜欢" appears in every
    preference and must not count as evidence of relevance).
    """
    counts: dict[str, int] = {"__total__": 0}
    for item in candidates:
        grams = set(_ngrams(normalize(item.get("content") or item.get("fact") or "")))
        grams |= set(_ngrams(normalize(" ".join(str(t) for t in item.get("tags") or []))))
        grams.discard("")
        counts["__total__"] += 1
        for gram in grams:
            counts[gram] = counts.get(gram, 0) + 1
    return counts


def _weighted_overlap(
    qgrams: set[str], cgrams: set[str], df: dict[str, int] | None
) -> float:
    shared = qgrams & cgrams
    if not qgrams or not shared:
        return 0.0
    if not df:
        return len(shared) / len(qgrams)
    total = max(1, df.get("__total__", 1))

    def idf(gram: str) -> float:
        return math.log(1.0 + total / max(1, df.get(gram, 0)))

    return sum(idf(g) for g in shared) / sum(idf(g) for g in qgrams)


def _idf_dice(qgrams: set[str], cgrams: set[str], df: dict[str, int]) -> float:
    """IDF-weighted Dice coefficient (diagnostic/ranking aid, not a gate).

    Kept for score diagnostics; do NOT use as an evidence gate: preference-
    frame queries ("你知道我爱吃什么吗" → alias 喜欢; "我最喜欢吃的水果") are
    linguistically identical in structure whether or not a matching memory
    exists, so no bigram threshold can separate paraphrase recall from
    abstention — that separation lives downstream (temporal anchor + honest
    replies) and in stronger embedding models.
    """
    shared = qgrams & cgrams
    if not shared:
        return 0.0
    total = max(1, df.get("__total__", 1))

    def idf(gram: str) -> float:
        return math.log(1.0 + total / max(1, df.get(gram, 0)))

    return 2 * sum(idf(g) for g in shared) / (
        sum(idf(g) for g in qgrams) + sum(idf(g) for g in cgrams)
    )


def _text_overlap(query_norm: str, text_norm: str, qgrams: set[str]) -> float:
    """Normalized overlap of the query against one auxiliary text."""
    if not query_norm or not text_norm:
        return 0.0
    if query_norm in text_norm or text_norm in query_norm:
        return 1.0
    tgrams = _ngrams(text_norm)
    if not tgrams:
        return 0.0
    return len(qgrams & tgrams) / max(1, len(qgrams))


def score_memory(
    query: str, item: dict[str, Any], now: float | None = None,
    df: dict[str, int] | None = None,
) -> tuple[float, list[str]]:
    q = normalize(query)
    content = normalize(item.get("content") or item.get("fact") or "")
    if not q or not content:
        return 0.0, []

    reasons: list[str] = []
    qgrams, cgrams = _ngrams(q), _ngrams(content)
    overlap = _weighted_overlap(qgrams, cgrams, df)
    sequence = SequenceMatcher(None, q, content).ratio()
    if q in content or content in q:
        lexical = 1.0
        reasons.append("direct_match")
    else:
        lexical = max(overlap, sequence * 0.65)
        # Evidence stays at "any overlap" (legacy contract): the alias table
        # ("我爱吃"→"喜欢") IS the designed paraphrase bridge for learned
        # preferences and relies on a single shared gram. IDF weighting
        # lowers the *score* of template-only matches instead. The known
        # residual: preference-frame abstention queries surface the top
        # preference — documented in the eval fixtures.
        if overlap:
            reasons.append("semantic_overlap")

    # Key-expansion channel (LongMemEval's "fact-augmented key expansion"):
    # tags and paraphrases let a differently-worded query hit a memory that
    # shares no surface text with it.
    auxiliary = [normalize(str(tag)) for tag in (item.get("tags") or [])]
    auxiliary += [normalize(str(p)) for p in (item.get("paraphrases") or [])]
    tag_score = max(
        (_text_overlap(q, text, qgrams) for text in auxiliary if text),
        default=0.0,
    )
    if tag_score >= 1.0 and "direct_match" not in reasons:
        reasons.append("tag_match")

    importance = max(0.0, min(1.0, float(item.get("importance", 0.5) or 0.5)))
    confidence = max(0.0, min(1.0, float(item.get("confidence", 0.6) or 0.6)))
    access_count = max(0, int(item.get("access_count", 0) or 0))
    familiarity = min(1.0, math.log1p(access_count) / math.log(11))
    created = float(item.get("updated_ts", item.get("created_ts", 0.0)) or 0.0)
    age_days = max(0.0, ((now or time.time()) - created) / 86400) if created else 30.0
    recency = math.exp(-age_days / 180.0)

    # The vector channel is enabled uniformly per search call (the store sets
    # "vector_enabled" on every candidate when the query itself embedded
    # successfully), so all rows in one ranking share the same weight set.
    vector_enabled = bool(item.get("vector_enabled"))
    if vector_enabled:
        vector = max(0.0, min(1.0, float(item.get("vector_score") or 0.0)))
        weights = (
            0.46 * lexical
            + 0.20 * vector
            + 0.10 * tag_score
            + 0.10 * importance
            + 0.08 * confidence
            + 0.04 * recency
            + 0.02 * familiarity
        )
        # Vector evidence: renormalized >= 0.25 == raw cosine >= ~0.59, i.e.
        # inside the measured related-pair band (see _renormalized_cosine).
        if vector >= 0.25 and "direct_match" not in reasons:
            reasons.append("vector_match")
    else:
        weights = (
            0.56 * lexical
            + 0.10 * tag_score
            + 0.13 * importance
            + 0.11 * confidence
            + 0.06 * recency
            + 0.04 * familiarity
        )
    score = weights
    if importance >= 0.75:
        reasons.append("important")
    if recency >= 0.8:
        reasons.append("recent")
    if familiarity >= 0.4:
        reasons.append("frequently_used")
    return score, reasons
