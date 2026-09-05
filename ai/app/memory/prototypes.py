"""Generic prototype classifier — the shared machinery behind the "小脑"
prototype matches (emotion second opinion, conversation-residue idle hints,
any future corpus of labeled example sentences).

Pattern: a user-editable JSON corpus of labeled example sentences; vectors
computed once and persisted next to the memory data (keyed by corpus hash —
a corpus edit invalidates the cache); classification = nearest prototype by
cosine, gated by an absolute confidence line plus a runner-up margin.

Failures degrade to None — callers always keep their existing fallback path.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("memory.prototypes")

# Nearest-prototype acceptance: the best cosine must clear this line AND lead
# the runner-up by the margin — ambiguous texts return None.
PROTOTYPE_COSINE = 0.45
PROTOTYPE_MARGIN = 0.05


def _corpus_hash(config_path: Path) -> str:
    return hashlib.sha256(config_path.read_bytes()).hexdigest()[:16]


def _cache_path(config_path: Path) -> Path:
    return config_path.with_suffix(".vectors.json")


class PrototypeClassifier:
    """Nearest-prototype classifier over one labeled sentence corpus."""

    def __init__(self, config_path: Path, cache_dir: Optional[Path] = None):
        self._config_path = Path(config_path)
        self._cache_dir = Path(cache_dir) if cache_dir else self._config_path.parent
        self._labeled: list[tuple[str, str, list[float]]] = []  # (label, sentence, vector)
        self._loaded_hash: Optional[str] = None

    def _load_corpus(self) -> Optional[tuple[str, list[tuple[str, str]]]]:
        try:
            data = json.loads(self._config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        prototypes = data.get("prototypes") if isinstance(data, dict) else None
        if not isinstance(prototypes, dict):
            return None
        labeled: list[tuple[str, str]] = []
        for label, entry in prototypes.items():
            # Two corpus shapes: label → [sentences], or label →
            # {"sentences": [...], ...meta} (meta stays readable by consumers).
            if isinstance(entry, dict):
                sentences = entry.get("sentences")
            else:
                sentences = entry
            if not isinstance(sentences, list):
                continue
            for sentence in sentences:
                text = str(sentence).strip()
                if len(text) >= 2:
                    labeled.append((str(label), text))
        if not labeled:
            return None
        return json.dumps(labeled, ensure_ascii=False), labeled

    def _ensure_vectors(self) -> bool:
        corpus = self._load_corpus()
        if corpus is None:
            return False
        corpus_json, labeled = corpus
        digest = hashlib.sha256(corpus_json.encode("utf-8")).hexdigest()[:16]
        if self._loaded_hash == digest and self._labeled:
            return True

        cache_path = _cache_path(self._config_path)
        cache_file = self._cache_dir / cache_path.name
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if cached.get("hash") == digest:
                self._labeled = [
                    (item["label"], item["sentence"], item["vector"])
                    for item in cached.get("items", [])
                    if isinstance(item, dict) and item.get("vector")
                ]
                if self._labeled:
                    self._loaded_hash = digest
                    return True
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            pass

        # (Re)compute vectors and persist.
        try:
            from app.memory.embedder import get_embedder

            embedder = get_embedder()
            if embedder is None:
                return False
            items = []
            for label, sentence in labeled:
                vec = embedder.embed_document(sentence)
                if vec:
                    items.append({"label": label, "sentence": sentence, "vector": vec})
        except Exception:
            logger.exception("Prototype vector computation failed")
            return False
        if not items:
            return False
        try:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(
                json.dumps({"hash": digest, "items": items}, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            logger.exception("Prototype vector cache write failed")
        self._labeled = [
            (item["label"], item["sentence"], item["vector"]) for item in items
        ]
        self._loaded_hash = digest
        return True

    def classify(
        self, text: str, *, min_cosine: float = PROTOTYPE_COSINE,
        margin: float = PROTOTYPE_MARGIN,
    ) -> Optional[tuple[str, float]]:
        """Nearest prototype: (label, cosine) or None when unconfident."""
        text = str(text or "").strip()
        if not text or not self._ensure_vectors():
            return None
        try:
            from app.memory.embedder import get_embedder

            embedder = get_embedder()
            if embedder is None:
                return None
            vec = embedder.embed_document(text)
        except Exception:
            return None
        if not vec:
            return None
        scores: dict[str, float] = {}
        for label, _, proto_vec in self._labeled:
            score = sum(x * y for x, y in zip(vec, proto_vec))
            scores[label] = max(scores.get(label, 0.0), score)
        if not scores:
            return None
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        best_label, best_score = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
        if best_score < min_cosine or best_score - runner_up < margin:
            return None
        return best_label, best_score
