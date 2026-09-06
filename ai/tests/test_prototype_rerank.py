"""PrototypeClassifier rerank integration — unit tests with fake channels.

No real models involved: the embedder and the reranker are stubbed so the
gating/ordering/fallback logic is verified deterministically. Model-backed
quality validation lives in scripts/experiment_reranker_prototypes.py.
"""

from __future__ import annotations

import json
from typing import Optional

import pytest

from app.memory.prototypes import PrototypeClassifier

# ── fixtures ──────────────────────────────────────────────────────────

CORPUS = {
    "prototypes": {
        "alpha": {"sentences": ["alpha one", "alpha two"]},
        "beta": {"sentences": ["beta one"]},
    }
}

# Deterministic 4-dim vectors keyed by text (cosines are hand-checkable).
VECTORS = {
    "alpha one": [1.0, 0.0, 0.0, 0.0],
    "alpha two": [0.9, 0.1, 0.0, 0.0],
    "beta one": [0.0, 1.0, 0.0, 0.0],
    "clear alpha": [0.95, 0.05, 0.0, 0.0],
    "near tie": [0.7, 0.7, 0.0, 0.0],
}


class FakeEmbedder:
    def embed_document(self, text: str) -> Optional[list[float]]:
        return VECTORS.get(text, [0.0, 0.0, 0.0, 0.0])


class FakeReranker:
    """score_pairs returns a score per pair based on the document text."""

    def __init__(self, doc_scores: dict[str, float], fail: bool = False):
        self.doc_scores = doc_scores
        self.fail = fail
        self.calls: list[list[tuple[str, str]]] = []

    def score_pairs(self, pairs, instruction="", max_length=None):
        self.calls.append(list(pairs))
        if self.fail:
            return None
        return [self.doc_scores.get(doc, 0.0) for _, doc in pairs]


@pytest.fixture()
def classifier(tmp_path, monkeypatch):
    config = tmp_path / "corpus.json"
    config.write_text(json.dumps(CORPUS), encoding="utf-8")
    monkeypatch.setattr("app.memory.embedder.get_embedder", lambda: FakeEmbedder())
    return PrototypeClassifier(config, cache_dir=tmp_path)


def install_reranker(monkeypatch, fake: FakeReranker) -> None:
    monkeypatch.setattr("app.memory.reranker.get_reranker", lambda: fake)


# ── reranker channel off → cosine behavior byte-for-byte ─────────────

def test_no_reranker_clear_cosine_passes(classifier, monkeypatch):
    install_reranker(monkeypatch, FakeReranker({}))  # never consulted
    monkeypatch.setattr("app.memory.reranker.get_reranker", lambda: None)
    assert classifier.classify("clear alpha") == ("alpha", pytest.approx(0.95))


def test_no_reranker_cosine_gates_apply(classifier, monkeypatch):
    monkeypatch.setattr("app.memory.reranker.get_reranker", lambda: None)
    # Perfect tie → margin gate rejects.
    assert classifier.classify("near tie") is None
    # Caller's strict cosine line is respected on the cosine path.
    assert classifier.classify("clear alpha", min_cosine=0.99) is None


def test_reranker_channel_disabled_env(monkeypatch):
    monkeypatch.setenv("RERANKER_ENABLED", "0")
    import app.memory.reranker as rr

    rr.reset_reranker_for_tests()
    assert rr.get_reranker() is None


# ── reranker active → P(yes) verdict decides ─────────────────────────

def test_rerank_overrides_cosine_order(classifier, monkeypatch):
    # Cosine slightly prefers alpha (0.95 vs 0.05); reranker flips to beta.
    fake = FakeReranker({"alpha one": 0.05, "alpha two": 0.05, "beta one": 0.9})
    install_reranker(monkeypatch, fake)
    assert classifier.classify("clear alpha") == ("beta", pytest.approx(0.9))


def test_rerank_absolute_score_gate(classifier, monkeypatch):
    monkeypatch.setenv("RERANKER_MIN_SCORE", "0.30")
    monkeypatch.setenv("RERANKER_MARGIN", "0.10")
    # Both labels weak → abstain even though beta wins by margin 0.1+.
    fake = FakeReranker({"alpha one": 0.2, "alpha two": 0.2, "beta one": 0.05})
    install_reranker(monkeypatch, fake)
    assert classifier.classify("clear alpha") is None


def test_rerank_margin_gate(classifier, monkeypatch):
    monkeypatch.setenv("RERANKER_MIN_SCORE", "0.30")
    monkeypatch.setenv("RERANKER_MARGIN", "0.10")
    # 0.5 vs 0.45 → margin 0.05 < 0.10 → abstain.
    fake = FakeReranker({"alpha one": 0.5, "alpha two": 0.5, "beta one": 0.45})
    install_reranker(monkeypatch, fake)
    assert classifier.classify("clear alpha") is None


def test_cosine_kwargs_do_not_block_rerank_branch(classifier, monkeypatch):
    # The P(yes) gates govern the rerank branch; cosine thresholds don't.
    fake = FakeReranker({"alpha one": 0.9, "alpha two": 0.9, "beta one": 0.05})
    install_reranker(monkeypatch, fake)
    result = classifier.classify("clear alpha", min_cosine=0.99, margin=0.9)
    assert result == ("alpha", pytest.approx(0.9))


def test_rerank_failure_falls_back_to_cosine(classifier, monkeypatch):
    fake = FakeReranker({"alpha one": 0.9, "alpha two": 0.9, "beta one": 0.1},
                        fail=True)
    install_reranker(monkeypatch, fake)
    assert classifier.classify("clear alpha") == ("alpha", pytest.approx(0.95))


def test_rerank_exception_falls_back_to_cosine(classifier, monkeypatch):
    class Exploding(FakeReranker):
        def score_pairs(self, pairs, instruction="", max_length=None):
            raise RuntimeError("boom")

    install_reranker(monkeypatch, Exploding({}))
    assert classifier.classify("clear alpha") == ("alpha", pytest.approx(0.95))


# ── rank(): reranked head, cosine tail ────────────────────────────────

def test_rank_reranked_head_first(classifier, monkeypatch):
    fake = FakeReranker({"alpha one": 0.1, "alpha two": 0.1, "beta one": 0.8})
    install_reranker(monkeypatch, fake)
    ranked = classifier.rank("clear alpha")
    assert ranked[0] == ("beta", pytest.approx(0.8))
    assert ranked[0][1] >= ranked[1][1]
    assert {label for label, _ in ranked} == {"alpha", "beta"}


def test_rank_no_reranker_pure_cosine(classifier, monkeypatch):
    monkeypatch.setattr("app.memory.reranker.get_reranker", lambda: None)
    ranked = classifier.rank("clear alpha")
    assert ranked[0] == ("alpha", pytest.approx(0.95))


# ── rerank_ranking: the shared retrieval/arbitration precision pass ───

def _rows():
    return [
        {"id": 1, "text": "alpha row", "score": 0.9},
        {"id": 2, "text": "beta row", "score": 0.8},
        {"id": 3, "text": "gamma row", "score": 0.7},
    ]


def test_rerank_ranking_reorders_head_and_annotates(monkeypatch):
    fake = FakeReranker({"alpha row": 0.2, "beta row": 0.9, "gamma row": 0.1})
    install_reranker(monkeypatch, fake)
    from app.memory.reranker import rerank_ranking

    rows = _rows()
    result = rerank_ranking("query", rows, text_of=lambda r: r["text"])
    assert [r["id"] for r in result] == [2, 1, 3]
    assert result[0]["rerank_score"] == pytest.approx(0.9)
    # Default cap (8) covers all three rows → every head row is annotated.
    assert result[2]["rerank_score"] == pytest.approx(0.1)


def test_rerank_ranking_fail_open(monkeypatch):
    from app.memory.reranker import rerank_ranking

    rows = _rows()
    monkeypatch.setattr("app.memory.reranker.get_reranker", lambda: None)
    assert rerank_ranking("q", rows, text_of=lambda r: r["text"]) == rows

    install_reranker(monkeypatch, FakeReranker({}, fail=True))
    assert rerank_ranking("q", rows, text_of=lambda r: r["text"]) == rows


def test_rerank_ranking_respects_cap(monkeypatch):
    fake = FakeReranker({"alpha row": 0.1, "beta row": 0.9, "gamma row": 0.5})
    install_reranker(monkeypatch, fake)
    from app.memory.reranker import rerank_ranking

    rows = _rows()
    result = rerank_ranking("q", rows, text_of=lambda r: r["text"], k=2)
    # Cap 2 → head = rows[:2]; gamma keeps its fused tail position.
    assert [r["id"] for r in result] == [2, 1, 3]


def test_rerank_ranking_empty_or_single(monkeypatch):
    install_reranker(monkeypatch, FakeReranker({"a": 0.9}))
    from app.memory.reranker import rerank_ranking

    single = [{"id": 1, "text": "a", "score": 0.9}]
    assert rerank_ranking("q", single, text_of=lambda r: r["text"]) == single
    assert rerank_ranking("q", [], text_of=lambda r: r["text"]) == []
