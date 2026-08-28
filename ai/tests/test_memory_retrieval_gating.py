"""P4 retrieval-noise-gate tests: an entry with zero lexical relation to the
query must no longer ride into the prompt on importance/confidence/recency
weight alone, unless the user pinned it (importance >= 0.9).
"""

from app.memory.store import MemoryStore


def _seed(store, content, *, importance=0.8, stable_key=None):
    return store.upsert_memory(
        memory_type="fact", subject="user", predicate="topic",
        content=content, character_id="monika",
        importance=importance, confidence=0.85,
        stable_key=stable_key or f"fact:user:{content[:12]}",
    )


def test_unrelated_important_memory_is_not_retrieved(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    _seed(store, "用户喜欢爬山，每周末都去郊外", importance=0.8)

    results = store.search_memories("量子物理", character_id="monika")

    # No lexical overlap, importance 0.8 < 0.9: gated out even though the
    # weight-only score (~0.26) clears the 0.24 threshold.
    assert results == []


def test_lexically_related_memory_is_still_retrieved(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    _seed(store, "用户喜欢喝咖啡，每天早上都要来一杯", importance=0.6)

    results = store.search_memories("咖啡", character_id="monika")

    assert results
    assert "咖啡" in results[0]["content"]
    # Lexical evidence present (substring direct match or n-gram overlap).
    assert {"direct_match", "semantic_overlap"} & set(results[0]["reasons"])


def test_pinned_importance_still_passes_without_lexical_evidence(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    _seed(store, "叫我大哥，不要建议我早睡", importance=0.95,
          stable_key="fact:user:pinned_rule")

    results = store.search_memories("量子物理", character_id="monika")

    assert results
    assert results[0]["importance"] == 0.95


def test_gate_keeps_character_scoping_intact(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    _seed(store, "monika 用户喜欢咖啡", importance=0.6)
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="topic",
        content="alice 用户喜欢喝茶", character_id="alice",
        importance=0.6, confidence=0.85, stable_key="fact:user:tea",
    )

    monika_results = store.search_memories("咖啡", character_id="monika")
    alice_results = store.search_memories("咖啡", character_id="alice")

    assert monika_results and "咖啡" in monika_results[0]["content"]
    assert alice_results == []  # no cross-character leak via the shared query
