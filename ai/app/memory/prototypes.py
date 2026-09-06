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
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("memory.prototypes")

# Nearest-prototype acceptance: the best cosine must clear this line AND lead
# the runner-up by the margin — ambiguous texts return None.
PROTOTYPE_COSINE = 0.45
PROTOTYPE_MARGIN = 0.05

# Reranker gates (P(yes) scale, NOT cosine). Calibrated 2026-09-06 by
# scripts/calibrate_reranker_gates.py over the residue corpus + real tails
# (n=40): 0.15/0.10 → 73% decided-accuracy at 65% coverage, the best combined
# cell; margin is barely discriminative on this data, min_score is the active
# dimension. Re-run the tool after every corpus edit.
#
# RERANK_TOPK=0 means rerank ALL labels (default — the GPU path costs
# ~0.1-0.3s for a whole corpus and a cosine shortlist measurably blinds the
# reranker: "被领导骂了一顿" has angry outside its cosine top-2, so a
# shortlisted rerank abstains where the full rescore votes angry 0.84). On
# the CPU fallback set RERANKER_TOPK=2 to bound latency.
RERANK_TOPK = 0
RERANK_MIN_SCORE = 0.15
RERANK_MARGIN = 0.10


def _rerank_config() -> tuple[int, float, float]:
    def _num(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, "").strip() or default)
        except (TypeError, ValueError):
            return default

    def _int(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name, "").strip() or default)
        except (TypeError, ValueError):
            return default

    return _int("RERANKER_TOPK", RERANK_TOPK), _num(
        "RERANKER_MIN_SCORE", RERANK_MIN_SCORE), _num(
        "RERANKER_MARGIN", RERANK_MARGIN)


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

    def _rerank_top_labels(
        self, text: str, cosine_ranked: list[tuple[str, float]], topk: int,
    ) -> Optional[dict[str, float]]:
        """Cross-encoder rescore of the top-K cosine labels' sentences.

        Returns {label: P(yes)} or None when the rerank channel is off or
        failed — callers keep their pure-cosine behavior in that case.
        """
        try:
            from app.memory.reranker import get_reranker

            reranker = get_reranker()
        except Exception:
            return None
        if reranker is None:
            return None
        chosen = ({label for label, _ in cosine_ranked[:topk]}
                  if topk > 0 else {label for label, _ in cosine_ranked})
        chosen_rows = [(label, sentence) for label, sentence, _ in self._labeled
                       if label in chosen]
        pairs = [(text, sentence) for _label, sentence in chosen_rows]
        try:
            scores = reranker.score_pairs(pairs)
        except Exception:
            logger.exception("Rerank scoring failed — using cosine only")
            return None
        if scores is None:
            return None
        per_label: dict[str, float] = {}
        for (label, _sentence), score in zip(chosen_rows, scores):
            per_label[label] = max(per_label.get(label, float("-inf")), score)
        return per_label

    def classify(
        self, text: str, *, min_cosine: float = PROTOTYPE_COSINE,
        margin: float = PROTOTYPE_MARGIN,
    ) -> Optional[tuple[str, float]]:
        """Nearest prototype: (label, score) or None when unconfident.

        With the rerank channel active, the top-K cosine labels are
        re-scored by the cross-encoder and gated on the P(yes) scale
        (RERANKER_MIN_SCORE / RERANKER_MARGIN — the cosine thresholds do
        not apply there). Without it, behavior is byte-for-byte the
        historical cosine path.
        """
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
        reranked = self._rerank_top_labels(text, ranked, _rerank_config()[0])
        if reranked:
            rr = sorted(reranked.items(), key=lambda kv: kv[1], reverse=True)
            _, min_score, margin_line = _rerank_config()
            best_label, best_score = rr[0]
            runner_up = rr[1][1] if len(rr) > 1 else 0.0
            gap = best_score - runner_up
            if best_score < min_score or gap < margin_line:
                logger.info(
                    "prototype vote [rerank:abstain] text=%r top=%s(%.3f) "
                    "runner=%s(%.3f) need>=%.2f/+%.2f",
                    text[:40], best_label, best_score,
                    rr[1][0] if len(rr) > 1 else "-", runner_up,
                    min_score, margin_line)
                return None
            logger.info(
                "prototype vote [rerank] text=%r -> %s (%.3f, margin %.3f)",
                text[:40], best_label, best_score, gap)
            return best_label, best_score
        best_label, best_score = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
        gap = best_score - runner_up
        if best_score < min_cosine or gap < margin:
            logger.info(
                "prototype vote [cosine:abstain] text=%r top=%s(%.3f) margin %.3f",
                text[:40], best_label, best_score, gap)
            return None
        logger.info(
            "prototype vote [cosine] text=%r -> %s (%.3f, margin %.3f)",
            text[:40], best_label, best_score, gap)
        return best_label, best_score

    def rank(self, text: str) -> list[tuple[str, float]]:
        """All labels scored against text, best first (no gating applied).

        With the rerank channel active the top-K cosine labels are
        re-ordered by cross-encoder score at the head of the list (their
        scores are P(yes); the tail keeps cosine values — the head is the
        verdict, the tail is fallback ordering). Used by consumers that
        need the full ordering (e.g. the residue adapter)."""
        text = str(text or "").strip()
        if not text or not self._ensure_vectors():
            return []
        try:
            from app.memory.embedder import get_embedder

            embedder = get_embedder()
        except Exception:
            return []
        if embedder is None:
            return []
        try:
            vec = embedder.embed_document(text)
        except Exception:
            return []
        if not vec:
            return []
        scores: dict[str, float] = {}
        for label, _, proto_vec in self._labeled:
            score = sum(x * y for x, y in zip(vec, proto_vec))
            scores[label] = max(scores.get(label, 0.0), score)
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        reranked = self._rerank_top_labels(text, ranked, _rerank_config()[0])
        if reranked:
            head = sorted(reranked.items(), key=lambda kv: kv[1], reverse=True)
            logger.info("residue rank [rerank] text=%r -> %s (%.3f)",
                        text[:40], head[0][0], head[0][1])
            head_labels = {label for label, _ in head}
            tail = [(label, score) for label, score in ranked
                    if label not in head_labels]
            return head + tail
        return ranked
