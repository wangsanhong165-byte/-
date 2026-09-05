"""Phase-2 conflict arbitration: propose → verify → soft-retire, offline."""

import pytest

from app.memory.arbitrator import arbitrate_new_facts
from app.memory.store import MemoryStore


class _ScriptedLLM:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def generate_text(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0) if self._responses else ""


def _store_with_conflict(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    old_id = store.upsert_memory(
        memory_type="preference", subject="user", predicate="sleep_schedule",
        content="用户喜欢深夜聊天，经常熬夜到五点", character_id="jingyu",
        stable_key="preference:user:sleep_schedule",
        observed_at="2026-08-27",
    )
    new_id = store.upsert_memory(
        memory_type="fact", subject="user", predicate="sleep_schedule",
        content="用户最近改掉了熬夜习惯，开始早睡早起", character_id="jingyu",
        stable_key="fact:user:sleep_schedule",
        confidence=0.85,
    )
    return store, old_id, new_id


def _row(store, memory_id) -> dict:
    return next(
        r for r in store.list_memories(active_only=False, limit=100)
        if r["id"] == memory_id
    )


def test_confirmed_arbitration_retires_obsolete_memory(tmp_path):
    store, old_id, new_id = _store_with_conflict(tmp_path)
    llm = _ScriptedLLM([
        f'[{{"new": {new_id}, "supersede": [{old_id}], "reason": "作息已改变"}}]',
        f'[{{"supersede": {old_id}, "obsolete": true}}]',
    ])

    stats = arbitrate_new_facts(llm, store, "jingyu", [_row(store, new_id)])

    assert stats["pairs"] == 1
    assert stats["proposed"] == 1
    assert stats["confirmed"] == 1
    assert _row(store, old_id)["active"] == 0
    assert _row(store, new_id)["active"] == 1


def test_rejected_verdict_keeps_old_memory(tmp_path):
    store, old_id, new_id = _store_with_conflict(tmp_path)
    llm = _ScriptedLLM([
        f'[{{"new": {new_id}, "supersede": [{old_id}], "reason": "疑似冲突"}}]',
        f'[{{"supersede": {old_id}, "obsolete": false}}]',
    ])

    stats = arbitrate_new_facts(llm, store, "jingyu", [_row(store, new_id)])

    assert stats["proposed"] == 1
    assert stats["confirmed"] == 0
    assert stats["rejected"] == 1
    assert _row(store, old_id)["active"] == 1


def test_low_confidence_new_fact_is_never_arbitrated(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="preference", subject="user", predicate="likes",
        content="用户喜欢深夜聊天", character_id="jingyu",
    )
    low = store.upsert_memory(
        memory_type="fact", subject="user", predicate="likes",
        content="用户似乎不喜欢深夜聊天了", character_id="jingyu",
        confidence=0.5,
    )
    llm = _ScriptedLLM([])

    stats = arbitrate_new_facts(llm, store, "jingyu", [_row(store, low)])

    assert stats["pairs"] == 0
    assert llm.calls == []


def test_proposal_outside_candidate_pairs_is_never_applied(tmp_path):
    store, old_id, new_id = _store_with_conflict(tmp_path)
    stranger = store.upsert_memory(
        memory_type="preference", subject="user", predicate="likes",
        content="用户喜欢爬山", character_id="jingyu",
    )
    llm = _ScriptedLLM([
        f'[{{"new": {new_id}, "supersede": [{stranger}], "reason": "越权裁决"}}]',
        f'[{{"supersede": {stranger}, "obsolete": true}}]',
    ])

    arbitrate_new_facts(llm, store, "jingyu", [_row(store, new_id)])

    assert _row(store, stranger)["active"] == 1, (
        "the verifier can only retire rows that were proposed as candidates"
    )


def test_pipeline_wires_arbitration(tmp_path, monkeypatch):
    from app.memory import compiler as compiler_mod
    from app.memory.extractor import run_extraction_pipeline

    # Isolate the compiled-memory directory: otherwise the real persisted
    # summary for this character leaks into the pipeline.
    monkeypatch.setattr(compiler_mod, "_get_base", lambda: tmp_path)
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="preference", subject="user", predicate="sleep_schedule",
        content="用户喜欢深夜聊天，经常熬夜到五点", character_id="jingyu",
    )
    # The rolling summary needs material: seed a few conversation turns.
    for n, text in enumerate([
        "最近好累，想调整作息",
        "我决定开始早睡早起，不再熬夜了",
        "昨晚十一点就睡了",
        "感觉白天精神好多了",
    ]):
        store.log_turn(
            text, {"reply_text": "好棒"}, character_id="jingyu",
            turn_id=f"t{n}", write_token=f"w{n}",
        )
    summary = (
        "[还悬着]（无）\n"
        "[现状] 鲸鱼和用户聊了作息，用户说自己最近在早睡早起，不再熬夜了。\n"
        "[已聊透]（无）"
    )
    llm = _ScriptedLLM([
        summary,
        '[{"fact": "用户最近在早睡早起，不再熬夜", "type": "fact", '
        '"predicate": "sleep_schedule", "confidence": 0.85}]',
        "[]",
    ])
    monkeypatch.setattr("app.memory.embedder.get_embedder", lambda: None)

    stats = run_extraction_pipeline(
        llm, character_name="鲸鱼", character_id="jingyu", store=store
    )
    assert stats["facts_stored"] == 1
    assert stats["arbitration"]["pairs"] == 1
    assert stats["arbitration"]["proposed"] == 0
