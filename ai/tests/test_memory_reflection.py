"""Phase-2 weekly reflection: insights, relationship style, guardrails."""

from app.memory.reflection import (
    reflect,
    reflection_due,
)
from app.memory.store import MemoryStore

_INSIGHT_JSON = (
    '{"insights": ['
    '{"text": "用户受挫时想找的是陪伴而不是解决方案", "importance": 0.75, "tags": ["情绪"]},'
    '{"text": "用户用测试消息掩饰想聊天的心情", "importance": 0.7, "tags": []}'
    '], "styles": ['
    '{"text": "他会接住撒娇，正经说教时他会走神"}'
    ']}')


class _ScriptedLLM:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def generate_text(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0) if self._responses else ""


def _seed_material(store, tmp_path):
    for predicate, content in [
        ("occupation", "用户是软件开发人员"),
        ("likes", "用户喜欢深夜聊天"),
        ("tone", "用户喜欢轻松的对话"),
        ("mood_trigger", "用户因修bug感到烦躁"),
        ("interest", "用户对动画电影感兴趣"),
    ]:
        store.upsert_memory(
            memory_type="fact", subject="user", predicate=predicate,
            content=content, character_id="monika",
        )


def test_reflection_due_requires_material_and_fresh_stamp(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    stamp_file = tmp_path / "stamp"
    monkeypatch.setattr(
        "app.memory.reflection._stamp_path", lambda cid: stamp_file
    )
    assert reflection_due(store, "monika") is False, "no material yet"

    _seed_material(store, tmp_path)
    assert reflection_due(store, "monika") is True

    stamp_file.write_text("2099-01-01", encoding="utf-8")
    assert reflection_due(store, "monika") is False, "stamp is fresh"


def test_reflect_stores_insights_and_style_with_verification(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    _seed_material(store, tmp_path)
    stamp_file = tmp_path / "stamp"
    monkeypatch.setattr(
        "app.memory.reflection._stamp_path", lambda cid: stamp_file
    )
    llm = _ScriptedLLM([
        _INSIGHT_JSON,
        '[{"index": 0, "supported": true}, {"index": 1, "supported": false}]',
    ])

    stats = reflect(llm, store, "monika", character_name="鲸鱼")

    # The verifier dropped insight #1 ("测试消息掩饰…" is not supported by
    # the seeded material).
    assert stats["dropped"] == 1
    assert stats["insights_stored"] == 1
    assert stats["styles_stored"] == 1
    insights = store.list_memories(
        character_id="monika", memory_type="insight", active_only=True
    )
    assert [row["content"] for row in insights] == [
        "用户受挫时想找的是陪伴而不是解决方案"
    ]
    styles = store.list_memories(
        character_id="monika", memory_type="relationship_style", active_only=True
    )
    assert styles[0]["subject"] == "character"
    assert stats and stamp_file.exists(), "weekly stamp written"


def test_reflect_skips_near_duplicate_insights(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    _seed_material(store, tmp_path)
    monkeypatch.setattr(
        "app.memory.reflection._stamp_path", lambda cid: tmp_path / "stamp"
    )
    llm = _ScriptedLLM([
        _INSIGHT_JSON,
        '[{"index": 0, "supported": true}, {"index": 1, "supported": false}]',
    ])
    reflect(llm, store, "monika")

    # Second identical reflection: the surviving insight is a duplicate now;
    # the newly-supported insight #1 is new and gets stored.
    llm2 = _ScriptedLLM([
        _INSIGHT_JSON,
        '[{"index": 0, "supported": true}, {"index": 1, "supported": true}]',
    ])
    stats = reflect(llm2, store, "monika")
    assert stats["duplicates"] == 1
    assert stats["insights_stored"] == 1
    insights = store.list_memories(
        character_id="monika", memory_type="insight", active_only=True
    )
    assert len(insights) == 2


def test_style_cap_retires_weakest(tmp_path, monkeypatch):
    store = MemoryStore(base_dir=tmp_path)
    for n in range(3):
        store.upsert_memory(
            memory_type="relationship_style", subject="character",
            predicate="interaction_style",
            content=f"旧风格{n}", character_id="monika",
            importance=0.5,
            stable_key=f"relationship_style:character:old{n}",
        )
    monkeypatch.setattr(
        "app.memory.reflection._stamp_path", lambda cid: tmp_path / "stamp"
    )
    llm = _ScriptedLLM([
        '{"insights": [], "styles": [{"text": "新的相处风格：先共情再给方案"}]}',
    ])
    stats = reflect(llm, store, "monika")

    assert stats["styles_stored"] == 1
    styles = store.list_memories(
        character_id="monika", memory_type="relationship_style", active_only=True
    )
    assert len(styles) == 3
    assert any("先共情" in row["content"] for row in styles)
    assert all("旧风格0" not in row["content"] for row in styles), (
        "the weakest oldest style retires when the cap is exceeded"
    )
