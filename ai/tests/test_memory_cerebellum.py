"""Phase-2.5 tests: initiative semantic freshness (M4) and the cerebellum
gates (M5: low-info turn filter, summary change detection, open_loop
semantic continuity, emotion prototype second opinion).
"""

import asyncio

import pytest

from app.memory.store import MemoryStore
from app.memory import embedder as embedder_module
from app.runtime.initiative_memory import InitiativeMemorySelector


class _KeyedStub:
    """Embedder stub: exact-text vectors first, then needle→vector table."""

    def __init__(self, table: dict[str, list[float]], default=None,
                 exact: dict[str, list[float]] | None = None):
        self._table = table
        self._default = default
        self._exact = exact or {}

    def available(self):
        return True

    def expected_dim(self):
        return len(next(iter(self._table.values()))) if self._table else 2

    def embed_query(self, text):
        return self._lookup(text)

    def embed_document(self, text):
        return self._lookup(text)

    def _lookup(self, text):
        if text in self._exact:
            return self._exact[text]
        for needle, vector in self._table.items():
            if needle in text:
                return vector
        return self._default


# ── M4: initiative semantic freshness ─────────────────────────────────────


def _selector_with(store, table, default=None) -> InitiativeMemorySelector:
    selector = InitiativeMemorySelector(store, cooldown_seconds=0)
    selector._embedder_stub = _KeyedStub(table, default)
    return selector


def test_recent_discussion_suppresses_topic(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    from datetime import datetime, timezone

    mid = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="用户想看魔法少女小圆的剧场版", character_id="jingyu",
        confidence=0.9,
        observed_at=datetime.now(timezone.utc).isoformat(),
    )
    stub = _KeyedStub({"魔法少女": [1.0, 0.0]}, default=[0.0, 1.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    picked = _selector_with(store, {}).select(
        "jingyu", recent_texts=["我们刚才聊了魔法少女小圆的剧场版呢"]
    )
    assert picked is None, "just-discussed topic must be suppressed"


def test_old_topic_is_allowed_back(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    from datetime import datetime, timezone

    store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="用户想看魔法少女小圆的剧场版", character_id="jingyu",
        confidence=0.9,
        observed_at="2026-01-01T00:00:00+00:00",
    )
    stub = _KeyedStub({"魔法少女": [1.0, 0.0]}, default=[0.0, 1.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    picked = _selector_with(store, {}).select(
        "jingyu", recent_texts=["我们刚才聊了魔法少女小圆的剧场版呢"]
    )
    assert picked is not None, "topics older than the freshness window return"


def test_no_recent_texts_keeps_legacy_behavior(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    store.upsert_memory(
        memory_type="preference", subject="user", predicate="likes",
        content="用户喜欢深夜聊天", character_id="jingyu", confidence=0.9,
    )
    stub = _KeyedStub({"深夜": [1.0, 0.0]}, default=[0.0, 1.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    picked = _selector_with(store, {}).select("jingyu")
    assert picked is not None and picked["memory_id"]


# ── M5①: low-information turn gate ───────────────────────────────────────


def test_low_information_gate_detects_spam_window(tmp_path, monkeypatch):
    from app.memory.extractor import is_low_information_turns

    stub = _KeyedStub({"测试": [1.0, 0.0], "ping": [0.99, 0.1]}, default=[1.0, 0.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    turns = [{"content": t} for t in ("发个测试", "再发个测试", "ping 测试", "继续测试")]

    assert is_low_information_turns(turns) is True


def test_low_information_gate_passes_diverse_turns(tmp_path, monkeypatch):
    from app.memory.extractor import is_low_information_turns

    stub = _KeyedStub(
        {"熬夜": [1.0, 0.0], "爬山": [0.0, 1.0], "做饭": [0.7, 0.7]},
        default=[0.0, 1.0],
    )
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)
    turns = [{"content": t} for t in ("昨晚熬夜了", "周末去爬山", "今天学做饭")]

    assert is_low_information_turns(turns) is False


def test_low_information_gate_fails_open_without_embedder(tmp_path, monkeypatch):
    from app.memory.extractor import is_low_information_turns

    monkeypatch.setattr(embedder_module, "get_embedder", lambda: None)
    turns = [{"content": t} for t in ("发个测试", "再发个测试", "继续测试")]

    assert is_low_information_turns(turns) is False


# ── M5②: summary semantic change detection ───────────────────────────────


def test_summary_semantic_unchanged_detects_rewording(tmp_path, monkeypatch):
    from app.memory.extractor import _summary_semantically_unchanged

    stub = _KeyedStub({"测试消息": [1.0, 0.0]}, default=[0.0, 1.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    old = "用户今天持续向AI发送重复的测试消息，没有开启真实对话"
    new = "用户今天仍在向AI发送大量重复的测试消息，没有真正聊天"
    assert _summary_semantically_unchanged(old, new) is True


def test_summary_semantic_change_detects_new_information(tmp_path, monkeypatch):
    from app.memory.extractor import _summary_semantically_unchanged

    stub = _KeyedStub(
        {"测试消息": [1.0, 0.0], "修好了": [0.0, 1.0]},
        default=[0.3, 0.95],
    )
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    old = "用户今天持续向AI发送重复的测试消息，没有开启真实对话"
    new = "用户说bug终于修好了，今天状态不错"
    assert _summary_semantically_unchanged(old, new) is False


# ── M5④: open_loop semantic continuity ───────────────────────────────────


def test_open_loop_rewording_updates_in_place(tmp_path, monkeypatch):
    from app.memory.extractor import sync_open_loops

    store = MemoryStore(base_dir=tmp_path)
    loop_id = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="用户想看魔法少女小圆剧场版，还没安排", character_id="jingyu",
        importance=0.7, confidence=0.8,
        stable_key="open_loop:user:oldwording",
    )
    store.mark_initiative_used("jingyu", loop_id)
    stub = _KeyedStub({"魔法少女": [1.0, 0.0]}, default=[0.0, 1.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    summary = "[还悬着]\n用户想看魔法少女小圆的电影，还没定场次\n[现状]（无）\n[已聊透]（无）"
    stats = sync_open_loops(store, "jingyu", summary)

    rows = store.list_memories(character_id="jingyu", memory_type="open_loop",
                               active_only=True, limit=50)
    assert len(rows) == 1, "reworded pending must update the existing loop, not spawn one"
    assert rows[0]["id"] == loop_id, "the loop keeps its id (cooldown continuity)"
    assert "电影" in rows[0]["content"]
    assert stats["open_loops_open"] == 1 and stats["open_loops_closed"] == 0


def test_open_loop_unmatched_is_closed(tmp_path, monkeypatch):
    from app.memory.extractor import sync_open_loops

    store = MemoryStore(base_dir=tmp_path)
    guitar_id = store.upsert_memory(
        memory_type="open_loop", subject="user", predicate="pending_topic",
        content="用户想学吉他", character_id="jingyu",
        stable_key="open_loop:user:guitar",
    )
    stub = _KeyedStub({"魔法少女": [1.0, 0.0], "吉他": [0.0, 1.0]}, default=[0.0, 1.0])
    monkeypatch.setattr(embedder_module, "get_embedder", lambda: stub)

    summary = "[还悬着]\n用户想看魔法少女小圆的电影\n[现状]（无）\n[已聊透]（无）"
    stats = sync_open_loops(store, "jingyu", summary)

    rows = store.list_memories(character_id="jingyu", memory_type="open_loop",
                               active_only=True, limit=50)
    assert all(r["id"] != guitar_id for r in rows), "resolved loop is closed"
    assert any("魔法少女" in r["content"] for r in rows)
    assert stats["open_loops_closed"] == 1


# ── M5③: emotion prototype second opinion ────────────────────────────────


def test_emotion_prototype_classification(tmp_path, monkeypatch):
    from app.memory import emotion_prototypes as ep

    config = tmp_path / "emotion_prototypes.json"
    config.write_text(json.dumps({
        "prototypes": {
            "happy": ["我今天超开心"],
            "sad": ["我难过得想哭"],
        }
    }, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(ep, "_CONFIG_PATH", config)
    monkeypatch.setattr(ep, "_CACHE_DIR", tmp_path)
    monkeypatch.setattr(ep, "_classifier", None)  # reset the module singleton

    table = {
        "我今天超开心": [1.0, 0.0],
        "我难过得想哭": [0.0, 1.0],
    }

    def make_stub(query_vec):
        class _S(_KeyedStub):
            def embed_query(self, text):
                return query_vec

            def embed_document(self, text):
                return self._lookup(text)
        return _S(
            table,
            default=[0.0, 1.0],
            exact={"我今天心情很好很开心呀": query_vec},
        )

    monkeypatch.setattr(
        "app.memory.embedder.get_embedder",
        lambda: make_stub([0.97, 0.24]),
    )
    match = ep.classify_emotion("我今天心情很好很开心呀")
    assert match is not None and match[0] == "happy"

    # Ambiguous: beats neither the confidence line nor the runner-up margin.
    monkeypatch.setattr(
        "app.memory.embedder.get_embedder",
        lambda: make_stub([0.72, 0.69]),
    )
    assert ep.classify_emotion("我今天心情很好很开心呀") is None


def test_emotion_step_uses_prototype_before_keywords(tmp_path, monkeypatch):
    from app.runtime.steps.emotion_step import EmotionStep
    from app.runtime.character_turn import CharacterTurn, TurnInput

    monkeypatch.setattr(
        "app.memory.emotion_prototypes.classify_emotion",
        lambda text: ("pout", 0.9),
    )
    step = EmotionStep()
    turn = CharacterTurn(input=TurnInput(text="哼"))
    turn.reply_text = "哼，随便你"
    turn.emotion = "neutral"
    turn.emotion_intensity = 0.3
    turn.character = None
    turn.character_self = None

    asyncio.run(step.run(turn))

    assert turn.emotion == "pout", (
        "the prototype match replaces the keyword fallback when confident"
    )


import json  # noqa: E402  (used by the emotion corpus test)
