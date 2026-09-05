"""Phase-1 vector channel tests: graceful degradation, injected-stub ranking,
embedding backfill, and the paraphrase retrieval keys.
"""

from app.memory import embedder as embedder_module
from app.memory.embedder import LocalEmbedder
from app.memory.store import MemoryStore, _decode_vector, _renormalized_cosine


class _StubEmbedder(LocalEmbedder):
    """Deterministic 2-D embedder for ranking tests (no ONNX involved)."""

    def __init__(
        self,
        doc_table: dict[str, list[float]] | None = None,
        query_vector: list[float] | None = None,
        default: list[float] | None = None,
    ):
        super().__init__(base_dir=None)
        self._doc_table = doc_table or {}
        self._query_vector = query_vector or [0.0, 1.0]
        self._default = default or [0.0, 1.0]
        self.calls = 0

    def available(self) -> bool:  # noqa: D102
        return True

    def expected_dim(self) -> int:  # noqa: D102
        return 2

    def _lookup(self, text: str) -> list[float]:
        self.calls += 1
        for needle, vector in self._doc_table.items():
            if needle in text:
                return vector
        return self._default

    def embed_query(self, text: str):
        self.calls += 1
        return self._query_vector

    def embed_document(self, text: str):
        return self._lookup(text)


def test_renormalized_cosine_maps_bge_range():
    # Orthogonal vectors -> cosine 0 -> clamped renormalization 0.0.
    assert _renormalized_cosine([1.0, 0.0], [0.0, 1.0]) == 0.0
    # Identical unit vectors -> cosine 1.0 -> renormalized 1.0.
    assert _renormalized_cosine([1.0, 0.0], [1.0, 0.0]) == 1.0
    # Length mismatch -> unusable.
    assert _renormalized_cosine([1.0], [1.0, 0.0]) is None


def test_decode_vector_round_trip():
    blob = embedder_module  # placeholder to keep import meaningful
    from app.memory.store import _encode_vector

    decoded = _decode_vector(_encode_vector([0.5, 0.5, 0.7071]))
    assert decoded is not None
    assert abs(decoded[0] - 0.5) < 1e-6
    assert _decode_vector(None) is None
    assert blob  # module imported


def test_search_degrades_without_embedder(tmp_path, monkeypatch):
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: None)
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="occupation",
        content="用户是软件开发人员", character_id="monika",
        tags=["职业"],
    )
    results = store.search_memories("我的职业", character_id="monika")
    assert results, "lexical channel must work without the vector channel"
    assert all(not item.get("vector_enabled") for item in results)


def test_vector_channel_ranks_semantic_match(tmp_path, monkeypatch):
    # Query [1,0]; the bug-chip memory embeds near [1,0]; the unrelated one
    # falls to the default [0,1] — the vector channel must surface the first
    # even though the query shares no surface text with it.
    stub = _StubEmbedder(
        doc_table={"用户因芯片供应发愁": [0.98, 0.2]},
        query_vector=[1.0, 0.0],
    )
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="worry",
        content="用户因芯片供应发愁", character_id="monika",
        importance=0.6, confidence=0.8,
    )
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="hobby",
        content="用户喜欢周末爬山", character_id="monika",
        importance=0.6, confidence=0.8,
    )
    results = store.search_memories("货源紧张的烦恼", character_id="monika")
    assert results, "vector evidence must pass the retrieval gate"
    assert results[0]["content"] == "用户因芯片供应发愁"
    assert "vector_match" in results[0]["reasons"]


def test_upsert_persists_embedding_and_paraphrases(tmp_path, monkeypatch):
    stub = _StubEmbedder(doc_table={"用户": [1.0, 0.0]})
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    store = MemoryStore(base_dir=tmp_path)
    mid = store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户习惯深夜活跃", character_id="monika",
        tags=["作息"], paraphrases=["失眠", "晚睡"],
    )
    row = next(
        r for r in store.list_memories(character_id="monika", active_only=False)
        if r["id"] == mid
    )
    assert row["paraphrases"] == ["失眠", "晚睡"]
    vector = _decode_vector(row["embedding"])
    assert vector is not None
    assert abs(vector[0] - 1.0) < 1e-6


def test_backfill_fills_rows_written_before_vectors(tmp_path, monkeypatch):
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: None)
    store = MemoryStore(base_dir=tmp_path)
    mid = store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户习惯深夜活跃", character_id="monika",
        paraphrases=["晚睡"],
    )
    row = next(
        r for r in store.list_memories(character_id="monika", active_only=False)
        if r["id"] == mid
    )
    assert row["embedding"] is None

    stub = _StubEmbedder(doc_table={"深夜": [1.0, 0.0]})
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    result = store.backfill_embeddings(character_id="monika")
    assert result["embedded"] == 1
    row = next(
        r for r in store.list_memories(character_id="monika", active_only=False)
        if r["id"] == mid
    )
    assert _decode_vector(row["embedding"]) is not None
    # Idempotent: nothing left to embed.
    assert store.backfill_embeddings(character_id="monika")["embedded"] == 0


def test_paraphrases_feed_lexical_channel(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户习惯深夜活跃", character_id="monika",
        paraphrases=["失眠", "几点睡"],
    )
    results = store.search_memories("我最近老是失眠", character_id="monika")
    assert results, "paraphrase keys must bridge the wording gap"
    assert results[0]["content"] == "用户习惯深夜活跃"
