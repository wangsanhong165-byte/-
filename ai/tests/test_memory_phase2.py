"""Phase-2 misc: merger semantic pre-grouping, style injection surfaces,
facts_digest absorbing insights.
"""

import asyncio
import json

import pytest

from app.memory import compiler as compiler_mod
from app.memory.merger import _group_candidates
from app.memory.store import MemoryStore, _decode_vector, _encode_vector
from app.providers.memory.sqlite_memory import SQLiteMemory
from app.runtime.context_assembler import ContextAssembler


class _VectorStub:
    """Embedder stub mapping content needles to fixed vectors."""

    def __init__(self, table: dict[str, list[float]]):
        self._table = table

    def available(self):
        return True

    def embed_query(self, text):
        return self._lookup(text)

    def embed_document(self, text):
        return self._lookup(text)

    def _lookup(self, text):
        for needle, vector in self._table.items():
            if needle in text:
                return vector
        return None


def _seed_with_embeddings(store, rows, table):
    from app.memory import embedder as embedder_module

    original = embedder_module.get_embedder
    embedder_module.set_embedder(_VectorStub(table))
    try:
        ids = []
        for memory_type, predicate, content, key in rows:
            ids.append(store.upsert_memory(
                memory_type=memory_type, subject="user", predicate=predicate,
                content=content, character_id="monika", stable_key=key,
            ))
    finally:
        embedder_module.set_embedder(None)
    return ids


def test_merger_groups_semantic_duplicates_across_predicates(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    table = {
        "熬夜": [1.0, 0.0],
        "凌晨": [0.97, 0.24],
        "登山": [0.0, 1.0],
        "爬山": [0.2, 0.98],
    }
    rows = [
        ("fact", "habit_a", "用户经常熬夜到凌晨", "fact:user:habit_a"),
        ("fact", "habit_b", "用户总是凌晨才睡", "fact:user:habit_b"),
        ("preference", "hobby", "用户喜欢登山", "preference:user:hobby"),
        ("preference", "hobby_b", "用户周末常去爬山", "preference:user:hobby_b"),
    ]
    ids = _seed_with_embeddings(store, rows, table)

    groups = _group_candidates(store, "monika")

    assert len(groups) == 2, "two semantic clusters, no shared predicates"
    grouped = {frozenset(r["id"] for r in group) for group in groups}
    assert frozenset(ids[:2]) in grouped
    assert frozenset(ids[2:]) in grouped


def test_merger_leaves_unrelated_memories_ungrouped(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    table = {"熬夜": [1.0, 0.0]}
    rows = [
        ("fact", "habit", "用户经常熬夜到凌晨", "fact:user:habit"),
        ("preference", "hobby", "用户喜欢登山", "preference:user:hobby"),
    ]
    _seed_with_embeddings(store, rows, table)

    groups = _group_candidates(store, "monika")

    assert groups == [], "orthogonal vectors stay apart without shared predicates"


def test_retrieve_appends_relationship_styles(tmp_path):
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="relationship_style", subject="character",
        predicate="interaction_style",
        content="先共情再给方案", character_id="monika",
    )
    provider = SQLiteMemory(store=store)

    results = asyncio.run(provider.retrieve(
        "随便什么查询", character_id="monika",
    ))

    styles = [r for r in results if r["type"] == "relationship_style"]
    assert len(styles) == 1
    assert styles[0]["data"]["content"] == "先共情再给方案"


def test_character_state_lifts_style_into_system_segment():
    character = type("C", (), {})()
    character.mood = type("M", (), {"current": "平静"})()
    character.relationship = type("R", (), {})()
    character.relationship.to_dict = lambda: {
        "affinity": {"default": 0.6}, "interaction_count": {"default": 5},
    }
    character.goals = type("G", (), {"top": lambda self, n: []})()
    memories = [
        {"type": "relationship_style", "data": {"content": "先共情再给方案"}},
        {"type": "relationship_style", "data": {"content": "他能接住撒娇"}},
        {"type": "relationship_style", "data": {"content": "第三条会被截掉"}},
        {"type": "fact", "data": {"content": "用户喜欢徒步"}},
    ]
    text = ContextAssembler().assemble_character_state(character, memories)
    assert "- interaction style: 先共情再给方案; 他能接住撒娇" in text
    assert "第三条会被截掉" not in text


def test_facts_digest_absorbs_insights(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="insight", subject="user", predicate="insight",
        content="用户受挫时想找的是陪伴而不是解决方案", character_id="monika",
        importance=0.8,
    )
    store.upsert_memory(
        memory_type="fact", subject="user", predicate="occupation",
        content="用户是软件开发人员", character_id="monika",
    )
    captured = {}

    def fake_llm(system, user, timeout=15):
        captured["user"] = user
        return "编译结果"

    monkeypatch.setattr(compiler_mod, "_call_llm", fake_llm)
    monkeypatch.setattr(compiler_mod, "_get_base", lambda: tmp_path)
    monkeypatch.setattr(compiler_mod, "memory_store", store)
    compiler_mod.set_active_char("monika")

    result = compiler_mod.facts_digest("monika")

    assert result == "编译结果"
    assert "用户是软件开发人员" in captured["user"]
    assert "用户受挫时想找的是陪伴而不是解决方案" in captured["user"]
