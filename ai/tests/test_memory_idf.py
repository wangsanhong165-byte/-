"""Phase-2 retrieval quality: IDF weighting in the lexical score.

Contract notes (settled in the Phase-2 review):
- The lexical EVIDENCE gate stays at the legacy "any overlap" level — the
  alias table ("我爱吃"→"喜欢") is the designed paraphrase bridge for learned
  preferences and relies on a single shared gram (see
  test_memory_end_to_end.test_preference_learn_restart_and_paraphrased_recall).
- IDF weighting therefore lives in the SCORE: high-frequency grams ("喜欢"
  occurs in every preference) contribute less, so template-only matches rank
  below content-bearing ones.
- Known residual: preference-frame abstention queries ("我最喜欢吃的水果")
  surface the top preference. Documented as a known gap in
  tests/fixtures/memory_eval.json; the honest-reply mitigation is downstream.
"""

from app.memory.retrieval import (
    _weighted_overlap,
    document_frequencies,
    score_memory,
)


def test_document_frequencies_counts_content_and_tags():
    candidates = [
        {"content": "用户喜欢徒步", "tags": ["作息"]},
        {"content": "用户喜欢唱歌", "tags": ["作息", "熬夜"]},
    ]
    df = document_frequencies(candidates)
    assert df["__total__"] == 2
    assert df["喜欢"] == 2
    assert df["作息"] == 2
    assert df["熬夜"] == 1


def test_idf_downweights_saturated_grams_in_score():
    # Query shares 喜欢+蛋糕 and carries an unmatched gram (水果): the
    # saturated frame gram (喜欢 in 40/50 memories) contributes less than a
    # rare one would.
    qgrams = {"喜欢", "蛋糕", "水果"}
    cgrams = {"喜欢", "蛋糕"}
    df_hot = {"__total__": 50, "喜欢": 40, "蛋糕": 2, "水果": 1}
    df_cold = {"__total__": 50, "喜欢": 2, "蛋糕": 2, "水果": 1}
    hot = _weighted_overlap(qgrams, cgrams, df_hot)
    cold = _weighted_overlap(qgrams, cgrams, df_cold)
    assert hot < cold, "saturated frame grams must contribute less than rare ones"
    assert 0 < hot < 1


def test_idf_overlap_falls_back_to_uniform_without_df():
    qgrams = {"喜欢", "蛋糕", "水果"}
    cgrams = {"喜欢", "蛋糕"}
    assert abs(_weighted_overlap(qgrams, cgrams, None) - 2 / 3) < 1e-9
    # Query-relative: one of the query's grams shared → 1.0.
    assert _weighted_overlap({"喜欢"}, {"喜欢", "蛋糕"}, None) == 1.0
    assert _weighted_overlap({"喜欢", "蛋糕"}, {"喜欢", "蛋糕", "水果"}, None) == 1.0


def test_direct_match_is_unaffected_by_idf(tmp_path):
    from app.memory.store import MemoryStore

    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="preference", subject="user", predicate="fav_number",
        content="用户最喜欢的数字是42", character_id="monika",
        stable_key="preference:user:fav_number",
    )
    results = store.search_memories("最喜欢的数字", character_id="monika")
    assert any("42" in r["content"] and "direct_match" in r["reasons"]
               for r in results)


def test_without_df_legacy_evidence_behavior_is_kept():
    item = {"content": "用户最喜欢的数字是42", "importance": 0.6, "confidence": 0.7}
    score, reasons = score_memory("我最喜欢吃的水果是什么", item)
    assert "semantic_overlap" in reasons, (
        "direct score_memory calls (no df) keep the legacy any-overlap contract"
    )
    assert score > 0
