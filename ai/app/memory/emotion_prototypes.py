"""Emotion second opinion — semantic prototype matching over the reply/user
text (小脑③, performance-layer E3 precursor).

The classifier votes ONLY where the keyword fallback used to: the caller
(emotion_step) invokes it after the LLM produced no usable emotion and before
the negation-aware keyword scan. An unconfident match (below the cosine line
or without a runner-up margin) returns None and the keyword fallback runs.
The LLM's own emotion verdict is never overridden by this module.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from app.memory.prototypes import PrototypeClassifier

_BASE_DIR = Path(__file__).resolve().parents[2]
_CONFIG_PATH = _BASE_DIR / "config" / "emotion_prototypes.json"
_CACHE_DIR = _BASE_DIR / "data" / "memory"

_classifier: Optional[PrototypeClassifier] = None


def _get_classifier() -> Optional[PrototypeClassifier]:
    global _classifier
    if _classifier is None:
        if not _CONFIG_PATH.exists():
            return None
        _classifier = PrototypeClassifier(_CONFIG_PATH, cache_dir=_CACHE_DIR)
    return _classifier


def classify_emotion(
    text: str, *, min_cosine: float = 0.60, margin: float = 0.05,
    min_length: int = 6,
) -> Optional[tuple[str, float]]:
    """Semantic emotion vote: (label, score) or None when unconfident.

    Dual-channel gating inside PrototypeClassifier.classify: with the rerank
    channel active (default) the vote is P(yes) gated at 0.15/+0.10
    (calibrated 2026-09-06, see scripts/calibrate_reranker_gates.py); with
    the channel off the legacy cosine line applies — strong-line defaults
    (Qwen3-0.6B calibrated 2026-09-05): meta/placeholder texts peak ≤0.518,
    genuine emotional expressions 0.616+. Short texts (<6 chars) match short
    prototypes meaninglessly and are rejected. min_cosine/margin only bind
    the cosine fallback, never the rerank branch.
    """
    if len(str(text or "").strip()) < min_length:
        return None
    classifier = _get_classifier()
    if classifier is None:
        return None
    try:
        return classifier.classify(text, min_cosine=min_cosine, margin=margin)
    except Exception:
        return None
